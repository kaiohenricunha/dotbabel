import { describe, expect, it } from "vitest";

import { CHANGED_FILES_ENV, SKIP_FILE_ENV } from "../src/attest-scope.mjs";
import { main } from "../src/attest-scope-command.mjs";

const ROOT = "/repo";
const CHANGED = "/tmp/changed.json";
const SKIP = "/tmp/skip.txt";

/**
 * An in-memory repository. `files` are repo-relative; every one is tracked.
 * `on` answers captured and run commands by their joined argv.
 */
function fakeRepo({ prefix = "", files = {}, changed = null, on = {}, env: extraEnv = {} } = {}) {
  const store = new Map(Object.entries(files).map(([p, t]) => [`${ROOT}/${p}`, t]));
  if (changed) store.set(CHANGED, JSON.stringify(changed));
  const runs = [];
  const logs = [];
  const answer = (cmd, args) => {
    const key = [cmd, ...args].join(" ");
    const hit = Object.entries(on).find(([pattern]) => key.startsWith(pattern));
    return hit ? hit[1] : undefined;
  };
  const io = {
    git: (args) => {
      if (args.includes("--show-toplevel")) return `${ROOT}\n`;
      if (args.includes("--show-prefix")) return `${prefix}\n`;
      if (args[0] === "ls-files") return Object.keys(files).join("\0");
      throw new Error(`unexpected git ${args.join(" ")}`);
    },
    readText: (p) => {
      if (!store.has(p)) throw Object.assign(new Error(`ENOENT ${p}`), { code: "ENOENT" });
      return store.get(p);
    },
    exists: (p) => store.has(p),
    writeText: (p, text) => store.set(p, text),
    capture: (cmd, args) => {
      const a = answer(cmd, args);
      return typeof a === "function" ? a(args, store) : (a ?? { status: 1, stdout: "" });
    },
    run: (cmd, args) => {
      runs.push([cmd, ...args]);
      const a = answer(cmd, args);
      return typeof a === "function" ? a(args, store) : (a ?? 0);
    },
    tempDir: () => "/tmp/scope",
    cleanup: () => {},
    log: (msg) => logs.push(msg),
  };
  const env = { [CHANGED_FILES_ENV]: changed ? CHANGED : undefined, [SKIP_FILE_ENV]: SKIP, ...extraEnv };
  return { io, env, runs, logs, skipReason: () => store.get(SKIP) ?? null };
}

const run = (repo, argv) => main({ argv, env: repo.env, io: repo.io });

describe("usage", () => {
  it.each([
    [["--", "go", "test", "./..."]],
    [["--runner", "mocha", "--", "mocha"]],
    [["--runner", "go"]],
    [["--runner", "go", "--"]],
    [["--runner", "go", "--verbose", "--", "go", "test", "./..."]],
  ])("exits 64 for %j", (argv) => {
    const repo = fakeRepo({ changed: ["a.go"] });
    expect(run(repo, argv)).toBe(64);
    expect(repo.runs).toEqual([]);
  });

  it("accepts --runner=<name>", () => {
    const repo = fakeRepo();
    run(repo, ["--runner=go", "--", "go", "test", "./..."]);
    expect(repo.runs).toEqual([["go", "test", "./..."]]);
  });
});

describe("fail-open: the CI command runs unchanged", () => {
  const goCmd = ["--runner", "go", "--", "go", "test", "-race", "./..."];

  it("when the runner passed no changed-file list (a --full run, or an unknown diff)", () => {
    const repo = fakeRepo({ on: { "go test": 0 } });
    expect(run(repo, goCmd)).toBe(0);
    expect(repo.runs).toEqual([["go", "test", "-race", "./..."]]);
  });

  it("when the runner gave no skip channel, since an empty run would then read as a pass", () => {
    const repo = fakeRepo({ changed: ["web/x.ts"], env: { [SKIP_FILE_ENV]: undefined } });
    run(repo, goCmd);
    expect(repo.runs).toEqual([["go", "test", "-race", "./..."]]);
  });

  it("when the command does not invoke the runner it names", () => {
    const repo = fakeRepo({ changed: ["a.go"] });
    run(repo, ["--runner", "jest", "--", "go", "test", "./..."]);
    expect(repo.runs).toEqual([["go", "test", "./..."]]);
  });

  it("when a shared input of every test changed", () => {
    const repo = fakeRepo({ prefix: "api/", changed: ["api/go.sum"] });
    run(repo, goCmd);
    expect(repo.runs).toEqual([["go", "test", "-race", "./..."]]);
    expect(repo.logs.join("\n")).toMatch(/api\/go\.sum/);
  });

  it("and returns its exit code", () => {
    const repo = fakeRepo({ on: { "go test": 3 } });
    expect(run(repo, goCmd)).toBe(3);
  });

  it("when the leg is not inside a git work tree", () => {
    const repo = fakeRepo({ changed: ["a.go"] });
    repo.io.git = () => {
      throw new Error("fatal: not a git repository");
    };
    run(repo, goCmd);
    expect(repo.runs).toEqual([["go", "test", "-race", "./..."]]);
    expect(repo.logs.join("\n")).toMatch(/not inside a git work tree/);
  });
});

describe("go", () => {
  const rootsOut = [
    `example.com/api/lib\t${ROOT}/api/lib\t1\t0`,
    `example.com/api/app\t${ROOT}/api/app\t0\t1`,
    `example.com/api/solo\t${ROOT}/api/solo\t1\t0`,
  ].join("\n");
  const graphOut = [
    `example.com/api/lib\t${ROOT}/api/lib\t`,
    `example.com/api/app\t${ROOT}/api/app\texample.com/api/lib`,
    `example.com/api/solo\t${ROOT}/api/solo\t`,
    `fmt\t/usr/lib/go/src/fmt\t`,
    `example.com/api/app_test [example.com/api/app.test]\t${ROOT}/api/app\texample.com/api/app example.com/api/lib`,
  ].join("\n");
  const goRepo = (changed, extra = {}) =>
    fakeRepo({
      prefix: "api/",
      changed,
      on: {
        "go list -f": { status: 0, stdout: rootsOut },
        "go list -test -deps": { status: 0, stdout: graphOut },
        "go test": 0,
        ...extra,
      },
    });
  const goCmd = ["--runner", "go", "--", "go", "test", "-race", "-count=1", "./..."];

  it("tests only the changed package when a few files change in one package", () => {
    const repo = goRepo(["api/solo/a.go", "api/solo/b.go"]);
    expect(run(repo, goCmd)).toBe(0);
    expect(repo.runs).toEqual([["go", "test", "-race", "-count=1", "./solo"]]);
  });

  it("tests the packages that import a changed package too", () => {
    const repo = goRepo(["api/lib/lib.go"]);
    run(repo, goCmd);
    expect(repo.runs).toEqual([["go", "test", "-race", "-count=1", "./app", "./lib"]]);
  });

  it("writes the skip file and runs nothing when no Go package is affected", () => {
    const repo = goRepo(["web/src/app.tsx"]);
    expect(run(repo, goCmd)).toBe(0);
    expect(repo.runs).toEqual([]);
    expect(repo.skipReason()).toMatch(/no package/);
  });

  it("runs in full when go list fails, for example on a package that no longer compiles", () => {
    const repo = goRepo(["api/lib/lib.go"], { "go list -test -deps": { status: 1, stdout: "" } });
    run(repo, goCmd);
    expect(repo.runs).toEqual([["go", "test", "-race", "-count=1", "./..."]]);
  });

  it("returns a failing scoped run's exit code and writes no skip", () => {
    const repo = goRepo(["api/solo/a.go"], { "go test": 1 });
    expect(run(repo, goCmd)).toBe(1);
    expect(repo.skipReason()).toBeNull();
  });

  it("runs in full when a changed Go file is in no package the command builds", () => {
    const repo = goRepo(["api/newpkg/x.go"]);
    run(repo, goCmd);
    expect(repo.runs).toEqual([["go", "test", "-race", "-count=1", "./..."]]);
  });

  it("runs in full when the go test arguments cannot be narrowed", () => {
    const repo = goRepo(["api/solo/a.go"]);
    run(repo, ["--runner", "go", "--", "go", "test", "./...", "-args", "-v"]);
    expect(repo.runs).toEqual([["go", "test", "./...", "-args", "-v"]]);
  });

  it("ignores a listed package whose directory is outside the repository", () => {
    const repo = goRepo(["api/solo/a.go"], {
      "go list -f": { status: 0, stdout: `${rootsOut}\nexample.com/vendored\t/elsewhere/vendored\t1\t0` },
    });
    run(repo, goCmd);
    expect(repo.runs).toEqual([["go", "test", "-race", "-count=1", "./solo"]]);
  });
});

describe("pytest", () => {
  const files = {
    "app/views.py": "",
    "tests/test_views.py": "def test_v(): pass",
    "tests/test_models.py": "def test_m(): pass",
  };
  const pyCmd = ["--runner", "pytest", "--", "python", "-m", "pytest", "-q", "tests"];

  it("runs the test files named after the changed modules", () => {
    const repo = fakeRepo({ files, changed: ["app/views.py"], on: { "python -m pytest": 0 } });
    expect(run(repo, pyCmd)).toBe(0);
    expect(repo.runs).toEqual([["python", "-m", "pytest", "-q", "tests/test_views.py"]]);
  });

  it("records exit 5 (no tests collected) as a skip, never as a pass", () => {
    const repo = fakeRepo({ files, changed: ["app/views.py"], on: { "python -m pytest": 5 } });
    expect(run(repo, pyCmd)).toBe(0);
    expect(repo.skipReason()).toMatch(/collected no tests/);
  });

  it("returns a failing run's exit code", () => {
    const repo = fakeRepo({ files, changed: ["app/views.py"], on: { "python -m pytest": 1 } });
    expect(run(repo, pyCmd)).toBe(1);
  });

  it("runs in full when the args are ambiguous", () => {
    const repo = fakeRepo({ files, changed: ["app/views.py"] });
    run(repo, ["--runner", "pytest", "--", "pytest", "--plugin-flag", "tests"]);
    expect(repo.runs).toEqual([["pytest", "--plugin-flag", "tests"]]);
  });

  it("runs in full when a changed module has no test named after it", () => {
    const repo = fakeRepo({ files: { ...files, "app/utils.py": "" }, changed: ["app/utils.py"] });
    run(repo, pyCmd);
    expect(repo.runs).toEqual([["python", "-m", "pytest", "-q", "tests"]]);
  });

  it("skips when every selected test is outside the paths the CI command runs", () => {
    const repo = fakeRepo({ files, changed: ["app/views.py"] });
    expect(run(repo, ["--runner", "pytest", "--", "pytest", "tests/unit"])).toBe(0);
    expect(repo.runs).toEqual([]);
    expect(repo.skipReason()).toMatch(/outside the paths/);
  });
});

describe("jest", () => {
  const files = {
    "package.json": JSON.stringify({ scripts: { test: "jest --ci" } }),
    "src/a.ts": "export const a = 1;",
    "src/a.test.ts": "import { a } from './a';",
    "src/b.test.ts": "readFileSync('fixtures/b.txt')",
    "src/__snapshots__/a.test.ts.snap": "",
  };
  const jestCmd = ["--runner", "jest", "--", "npm", "test"];
  const listing = (paths) => ({ status: 0, stdout: paths.map((p) => `${ROOT}/${p}`).join("\n") });

  it("lists the related tests first, then runs them through the script's launcher with the floor off", () => {
    const repo = fakeRepo({
      files,
      changed: ["src/a.ts"],
      on: { "npx --no-install jest --ci --coverageThreshold={} --listTests": listing(["src/a.test.ts"]) },
    });
    expect(run(repo, jestCmd)).toBe(0);
    expect(repo.runs).toEqual([
      ["npx", "--no-install", "jest", "--ci", "--coverageThreshold={}", "--findRelatedTests", "src/a.ts"],
    ]);
  });

  it("skips when the related set holds no test, instead of a run that passes on nothing", () => {
    const repo = fakeRepo({ files, changed: ["src/a.ts"], on: { "npx --no-install jest": listing([]) } });
    expect(run(repo, jestCmd)).toBe(0);
    expect(repo.runs).toEqual([]);
    expect(repo.skipReason()).toMatch(/no test/);
  });

  it("counts only listed test paths, not a package manager's banner lines on stdout", () => {
    const repo = fakeRepo({
      files: { ...files, "package.json": JSON.stringify({ scripts: { test: "jest --ci" } }) },
      changed: ["src/a.ts"],
      on: { "yarn jest": { status: 0, stdout: "yarn run v1.22.22\n$ /repo/node_modules/.bin/jest --listTests\nDone in 0.41s.\n" } },
    });
    expect(run(repo, ["--runner", "jest", "--", "yarn", "test"])).toBe(0);
    expect(repo.runs).toEqual([]);
    expect(repo.skipReason()).toMatch(/no test/);
  });

  it("runs in full when the listing probe fails", () => {
    const repo = fakeRepo({ files, changed: ["src/a.ts"], on: { "npx --no-install jest": { status: 1, stdout: "" } } });
    run(repo, jestCmd);
    expect(repo.runs).toEqual([["npm", "test"]]);
  });

  it("runs in full when a source file was deleted, since its importers cannot be traced", () => {
    const repo = fakeRepo({ files, changed: ["src/gone.ts"] });
    run(repo, jestCmd);
    expect(repo.runs).toEqual([["npm", "test"]]);
  });

  it("runs in full when a changed file is one no rule relates to a test", () => {
    const repo = fakeRepo({ files: { ...files, "fixtures/c.txt": "" }, changed: ["fixtures/c.txt"] });
    run(repo, jestCmd);
    expect(repo.runs).toEqual([["npm", "test"]]);
  });

  it("selects the test a changed fixture is named in", () => {
    const repo = fakeRepo({
      files: { ...files, "fixtures/b.txt": "" },
      changed: ["fixtures/b.txt"],
      on: { "npx --no-install jest": listing(["src/b.test.ts"]) },
    });
    run(repo, jestCmd);
    expect(repo.runs.at(-1)).toEqual([
      "npx", "--no-install", "jest", "--ci", "--coverageThreshold={}", "--findRelatedTests", "src/b.test.ts",
    ]);
  });

  it("selects the test that owns a changed snapshot", () => {
    const repo = fakeRepo({
      files,
      changed: ["src/__snapshots__/a.test.ts.snap"],
      on: { "npx --no-install jest": listing(["src/a.test.ts"]) },
    });
    run(repo, jestCmd);
    expect(repo.runs.at(-1)?.slice(-1)).toEqual(["src/a.test.ts"]);
  });

  it("runs in full when an option takes a separate value that --findRelatedTests would read as a file", () => {
    const repo = fakeRepo({ files, changed: ["src/a.ts"] });
    run(repo, ["--runner", "jest", "--", "npx", "jest", "--maxWorkers", "2"]);
    expect(repo.runs).toEqual([["npx", "jest", "--maxWorkers", "2"]]);
  });

  it("skips without probing when no changed file is under a sub-directory leg", () => {
    const repo = fakeRepo({ prefix: "web/", files: { "web/package.json": files["package.json"] }, changed: ["api/main.go"] });
    expect(run(repo, ["--runner", "jest", "--", "npx", "jest"])).toBe(0);
    expect(repo.skipReason()).not.toBeNull();
  });
});

describe("vitest", () => {
  const files = {
    "package.json": JSON.stringify({ scripts: { test: "vitest run --coverage" } }),
    "src/a.ts": "export const a = 1;",
    "src/a.test.ts": "import { a } from './a';",
  };
  const vitestCmd = ["--runner", "vitest", "--", "npm", "test"];
  const reportWith = (numTotalTests, code = 0) => (args, store) => {
    const out = args.find((a) => a.startsWith("--outputFile.json="))?.split("=")[1];
    if (out && numTotalTests !== null) store.set(out, JSON.stringify({ numTotalTests }));
    return code;
  };

  it("runs the shared selector's related args with the coverage floor off and counts the tests", () => {
    const repo = fakeRepo({ files, changed: ["src/a.ts"], on: { "npx --no-install vitest": reportWith(3) } });
    expect(run(repo, vitestCmd)).toBe(0);
    const [argv] = repo.runs;
    expect(argv.slice(0, 5)).toEqual(["npx", "--no-install", "vitest", "related", "--run"]);
    expect(argv).toContain("--coverage.thresholds.lines=0");
    expect(argv.at(-1)).toBe("src/a.ts");
    expect(repo.skipReason()).toBeNull();
  });

  it("records a run that reached zero tests as a skip", () => {
    const repo = fakeRepo({ files, changed: ["src/a.ts"], on: { "npx --no-install vitest": reportWith(0) } });
    expect(run(repo, vitestCmd)).toBe(0);
    expect(repo.skipReason()).toMatch(/no test/);
  });

  it("runs in full when the test count is unknown", () => {
    const repo = fakeRepo({ files, changed: ["src/a.ts"], on: { "npx --no-install vitest": reportWith(null), "npm test": 0 } });
    run(repo, vitestCmd);
    expect(repo.runs.at(-1)).toEqual(["npm", "test"]);
  });

  it("returns a failing scoped run's exit code", () => {
    const repo = fakeRepo({ files, changed: ["src/a.ts"], on: { "npx --no-install vitest": reportWith(2, 1) } });
    expect(run(repo, vitestCmd)).toBe(1);
  });

  it("runs in full when the command names its own test filter", () => {
    const repo = fakeRepo({ files, changed: ["src/a.ts"] });
    run(repo, ["--runner", "vitest", "--", "npx", "vitest", "run", "src/"]);
    expect(repo.runs).toEqual([["npx", "vitest", "run", "src/"]]);
  });

  it("keeps the command's other flags and measures coverage only when the command does", () => {
    const repo = fakeRepo({ files: { ...files, "package.json": "{}" }, changed: ["src/a.ts"], on: { "npx vitest": reportWith(1) } });
    run(repo, ["--runner", "vitest", "--", "npx", "vitest", "--silent"]);
    const [argv] = repo.runs;
    expect(argv.slice(0, 4)).toEqual(["npx", "vitest", "related", "--silent"]);
    expect(argv).not.toContain("--coverage");
  });

  it("keeps coverage reporter settings, so a reused lcov report is still written", () => {
    const repo = fakeRepo({ files: { ...files, "package.json": "{}" }, changed: ["src/a.ts"], on: { "npx vitest": reportWith(1) } });
    run(repo, ["--runner", "vitest", "--", "npx", "vitest", "run", "--coverage", "--coverage.reporter=lcov"]);
    const [argv] = repo.runs;
    expect(argv).toContain("--coverage.reporter=lcov");
    expect(argv.filter((a) => a === "--coverage")).toHaveLength(1);
  });

  it("skips without running when no changed file is in the leg", () => {
    const repo = fakeRepo({ files, changed: ["api/main.go"] });
    expect(run(repo, vitestCmd)).toBe(0);
    expect(repo.runs).toEqual([]);
    expect(repo.skipReason()).not.toBeNull();
  });

  it("runs in full when a source file was deleted", () => {
    const repo = fakeRepo({ files, changed: ["src/gone.ts"] });
    run(repo, vitestCmd);
    expect(repo.runs).toEqual([["npm", "test"]]);
  });
});

describe("realIo", () => {
  it("captures stdout, returns exit codes, and reports a missing binary as exit 1", async () => {
    const { realIo } = await import("../src/attest-scope-command.mjs");
    const io = realIo();
    expect(io.capture(process.execPath, ["-e", "process.stdout.write('out')"])).toEqual({ status: 0, stdout: "out" });
    expect(io.run(process.execPath, ["-e", "process.exit(3)"])).toBe(3);
    expect(io.run("dotbabel-no-such-binary-for-test", [])).toBe(1);
    expect(io.git(["--version"])).toMatch(/^git version/);
  });

  it("reads, writes, and removes files in a fresh temp directory", async () => {
    const { realIo } = await import("../src/attest-scope-command.mjs");
    const io = realIo();
    const dir = io.tempDir();
    const file = `${dir}/skip.txt`;
    expect(io.exists(file)).toBe(false);
    io.writeText(file, "why\n");
    expect(io.readText(file)).toBe("why\n");
    io.cleanup(dir);
    expect(io.exists(dir)).toBe(false);
  });
});
