import { describe, expect, it } from "vitest";

import {
  detectRunner,
  goScopedArgv,
  jestScopedArgv,
  parseGoList,
  parseGoTestArgs,
  parseJestArgs,
  parsePytestArgs,
  pytestScopedArgv,
  selectGoPackages,
  selectPytestTests,
  simpleArgv,
  snapshotOwners,
  unclassifiedJsInputs,
  wrapCommand,
} from "../src/attest-scope-runners.mjs";

describe("simpleArgv", () => {
  it("splits one plain command into argv", () => {
    expect(simpleArgv("go test -race -count=1 ./...")).toEqual(["go", "test", "-race", "-count=1", "./..."]);
  });

  it("collapses repeated spaces and trims", () => {
    expect(simpleArgv("  npm   test  ")).toEqual(["npm", "test"]);
  });

  it.each([
    ["a chain", "npm ci && npm test"],
    ["a pipe", "go test ./... | tee out"],
    ["a sequence", "make; make test"],
    ["a variable", "pytest $ARGS"],
    ["quotes", "pytest -k 'not slow'"],
    ["a newline", "npm ci\nnpm test"],
    ["a redirect", "go test ./... > out.txt"],
    ["a glob", "pytest tests/*.py"],
    ["braces", "jest --coverageThreshold={}"],
  ])("refuses %s, because the scoper could not rewrite it faithfully", (_label, command) => {
    expect(simpleArgv(command)).toBeNull();
  });

  it("refuses an empty command", () => {
    expect(simpleArgv("   ")).toBeNull();
  });
});

describe("detectRunner", () => {
  it("recognises go test and keeps its flags and patterns as args", () => {
    expect(detectRunner(["go", "test", "-race", "./..."], null)).toEqual({
      runner: "go",
      exec: ["go", "test"],
      args: ["-race", "./..."],
    });
  });

  it("does not treat other go subcommands as a test runner", () => {
    expect(detectRunner(["go", "vet", "./..."], null)).toBeNull();
  });

  it.each([
    [["pytest", "-q"], ["pytest"]],
    [["python", "-m", "pytest", "-q"], ["python", "-m", "pytest"]],
    [["python3", "-m", "pytest", "-q"], ["python3", "-m", "pytest"]],
    [["uv", "run", "pytest", "-q"], ["uv", "run", "pytest"]],
    [["poetry", "run", "pytest", "-q"], ["poetry", "run", "pytest"]],
  ])("recognises the pytest launcher %j", (argv, exec) => {
    expect(detectRunner(argv, null)).toEqual({ runner: "pytest", exec, args: ["-q"] });
  });

  it.each([
    [["jest", "--ci"], "jest", ["jest"]],
    [["npx", "jest", "--ci"], "jest", ["npx", "jest"]],
    [["npx", "--no-install", "jest", "--ci"], "jest", ["npx", "--no-install", "jest"]],
    [["pnpm", "exec", "jest", "--ci"], "jest", ["pnpm", "exec", "jest"]],
    [["node_modules/.bin/vitest", "--ci"], "vitest", ["node_modules/.bin/vitest"]],
    [["vitest", "--ci"], "vitest", ["vitest"]],
  ])("recognises the direct JS launcher %j", (argv, runner, exec) => {
    expect(detectRunner(argv, null)).toEqual({ runner, exec, args: ["--ci"] });
  });

  it("follows `npm test` into its script and launches the binary through npx --no-install", () => {
    expect(detectRunner(["npm", "test"], { test: "jest --ci" })).toEqual({
      runner: "jest",
      exec: ["npx", "--no-install", "jest"],
      args: ["--ci"],
    });
  });

  it("appends args given after npm's -- separator", () => {
    expect(detectRunner(["npm", "run", "test:unit", "--", "--coverage"], { "test:unit": "vitest run" })).toEqual({
      runner: "vitest",
      exec: ["npx", "--no-install", "vitest"],
      args: ["run", "--coverage"],
    });
  });

  it("refuses npm args without the -- separator, which npm would read as its own config", () => {
    expect(detectRunner(["npm", "test", "--coverage"], { test: "jest" })).toBeNull();
  });

  it("launches a script's binary through the same package manager", () => {
    expect(detectRunner(["yarn", "test"], { test: "jest" })?.exec).toEqual(["yarn", "jest"]);
    expect(detectRunner(["pnpm", "run", "test"], { test: "jest" })?.exec).toEqual(["pnpm", "exec", "jest"]);
  });

  it("returns null when the script is missing or is not one plain runner command", () => {
    expect(detectRunner(["npm", "test"], {})).toBeNull();
    expect(detectRunner(["npm", "test"], null)).toBeNull();
    expect(detectRunner(["npm", "test"], { test: "tsc && jest" })).toBeNull();
    expect(detectRunner(["npm", "test"], { test: "cross-env CI=1 jest" })).toBeNull();
    expect(detectRunner(["npm", "test"], { test: "npm run unit" })).toBeNull();
  });

  it("returns null for commands that run no known test runner", () => {
    expect(detectRunner(["make", "test"], null)).toBeNull();
    expect(detectRunner(["npm", "ci"], null)).toBeNull();
  });
});

describe("wrapCommand", () => {
  it("keeps the CI command byte for byte after the separator", () => {
    expect(wrapCommand("go", "go test -race -count=1 ./...")).toBe(
      "dotbabel attest-scope --runner go -- go test -race -count=1 ./...",
    );
  });
});

describe("parseGoTestArgs", () => {
  it("separates flags, including flags with a separate value, from package patterns", () => {
    expect(parseGoTestArgs(["-race", "-run", "TestA", "-count=1", "./..."])).toEqual({
      flags: ["-race", "-run", "TestA", "-count=1"],
      patterns: ["./..."],
    });
  });

  it("accepts the current-directory pattern", () => {
    expect(parseGoTestArgs(["."])).toEqual({ flags: [], patterns: ["."] });
  });

  it("refuses -args, which hands the rest of the line to the test binary", () => {
    expect(parseGoTestArgs(["./...", "-args", "-v"])).toBeNull();
  });

  it("refuses -C, which changes the directory the patterns are read from", () => {
    expect(parseGoTestArgs(["-C", "api", "./..."])).toBeNull();
  });

  it("refuses import-path patterns, which the scoper cannot map to directories", () => {
    expect(parseGoTestArgs(["example.com/api/..."])).toBeNull();
  });

  it("refuses a command with no package pattern", () => {
    expect(parseGoTestArgs(["-race"])).toBeNull();
  });
});

describe("parseGoList", () => {
  it("reads tab-separated import path, dir, and deps, keeping test variants", () => {
    const text = [
      "example.com/api/lib\tapi/lib\t",
      "example.com/api/app_test [example.com/api/app.test]\tapi/app\tfmt example.com/api/app example.com/api/lib",
      "",
    ].join("\n");
    expect(parseGoList(text)).toEqual([
      { importPath: "example.com/api/lib", dir: "api/lib", deps: [] },
      {
        importPath: "example.com/api/app_test [example.com/api/app.test]",
        dir: "api/app",
        deps: ["fmt", "example.com/api/app", "example.com/api/lib"],
      },
    ]);
  });
});

describe("selectGoPackages", () => {
  // api/lib is imported by api/app (through an external test package);
  // api/leaf has no test files; api/solo has tests and nothing imports it.
  const roots = [
    { importPath: "example.com/api/app", dir: "api/app", hasTests: true },
    { importPath: "example.com/api/leaf", dir: "api/leaf", hasTests: false },
    { importPath: "example.com/api/lib", dir: "api/lib", hasTests: true },
    { importPath: "example.com/api/solo", dir: "api/solo", hasTests: true },
  ];
  const graph = [
    { importPath: "example.com/api/lib", dir: "api/lib", deps: [] },
    { importPath: "example.com/api/app", dir: "api/app", deps: ["example.com/api/lib"] },
    { importPath: "example.com/api/leaf", dir: "api/leaf", deps: [] },
    { importPath: "example.com/api/solo", dir: "api/solo", deps: [] },
    { importPath: "example.com/api/lib [example.com/api/lib.test]", dir: "api/lib", deps: ["testing"] },
    {
      importPath: "example.com/api/app_test [example.com/api/app.test]",
      dir: "api/app",
      deps: ["example.com/api/app", "example.com/api/lib", "testing"],
    },
    { importPath: "example.com/api/solo [example.com/api/solo.test]", dir: "api/solo", deps: ["testing"] },
  ];
  const select = (changedFiles) => selectGoPackages({ changedFiles, prefix: "api/", roots, graph });

  it("tests only the changed package when 2-3 files change in one package nothing imports", () => {
    const d = select(["api/solo/a.go", "api/solo/b.go", "api/solo/a_test.go"]);
    expect(d).toMatchObject({ mode: "scoped", packages: ["./solo"] });
  });

  it("also tests every package that depends on the changed one", () => {
    const d = select(["api/lib/lib.go"]);
    expect(d).toMatchObject({ mode: "scoped", packages: ["./app", "./lib"] });
  });

  it("counts testdata and embedded files as part of the package that owns the directory", () => {
    expect(select(["api/solo/testdata/case.json"])).toMatchObject({ mode: "scoped", packages: ["./solo"] });
  });

  it("skips when the only affected package has no test files, since go test would pass on nothing", () => {
    const d = select(["api/leaf/leaf.go"]);
    expect(d.mode).toBe("skip");
  });

  it("skips when no changed file belongs to a Go package of this command", () => {
    expect(select(["web/src/app.tsx", "README.md"]).mode).toBe("skip");
  });

  it("ignores documentation even inside a package directory", () => {
    expect(select(["api/solo/README.md"]).mode).toBe("skip");
  });

  it("runs in full when a changed Go file under the leg is in no listed package", () => {
    const d = select(["api/newpkg/x.go"]);
    expect(d.mode).toBe("full");
    expect(d.reason).toMatch(/api\/newpkg\/x\.go/);
  });

  it("uses the bare directory pattern for a package at the leg's own directory", () => {
    const d = selectGoPackages({
      changedFiles: ["main.go"],
      prefix: "",
      roots: [{ importPath: "example.com/m", dir: "", hasTests: true }],
      graph: [{ importPath: "example.com/m", dir: "", deps: [] }],
    });
    expect(d).toMatchObject({ mode: "scoped", packages: ["."] });
  });
});

describe("goScopedArgv", () => {
  it("keeps every flag and replaces the patterns with the selected packages", () => {
    expect(goScopedArgv({ flags: ["-race", "-count=1"], packages: ["./app", "./lib"] })).toEqual([
      "go",
      "test",
      "-race",
      "-count=1",
      "./app",
      "./lib",
    ]);
  });
});

describe("parsePytestArgs", () => {
  it("separates options, with their values, from positional paths", () => {
    expect(parsePytestArgs(["-q", "-k", "not slow", "--maxfail=1", "tests/unit"])).toEqual({
      options: ["-q", "-k", "not slow", "--maxfail=1"],
      paths: ["tests/unit"],
    });
  });

  it("lets --cov take the next token, as pytest-cov's optional argument does", () => {
    expect(parsePytestArgs(["--cov", "src", "tests"])).toEqual({ options: ["--cov", "src"], paths: ["tests"] });
  });

  it("refuses a long option it does not know, since its value could be mistaken for a path", () => {
    expect(parsePytestArgs(["--some-plugin-flag", "tests"])).toBeNull();
  });
});

describe("selectPytestTests", () => {
  const testFiles = ["tests/test_models.py", "tests/test_views.py", "tests/api/views_test.py"];
  const exists = (p) => !p.includes("deleted");
  const select = (changedFiles, prefix = "") => selectPytestTests({ changedFiles, prefix, testFiles, exists });

  it("runs the test files named after the changed modules", () => {
    expect(select(["app/views.py"])).toMatchObject({
      mode: "scoped",
      tests: ["tests/api/views_test.py", "tests/test_views.py"],
    });
  });

  it("runs a changed test file itself", () => {
    expect(select(["tests/test_models.py"])).toMatchObject({ mode: "scoped", tests: ["tests/test_models.py"] });
  });

  it("runs in full when a changed module has no test named after it", () => {
    const d = select(["app/utils.py"]);
    expect(d.mode).toBe("full");
    expect(d.reason).toMatch(/app\/utils\.py/);
  });

  it.each(["app/__init__.py", "tests/conftest.py"])("runs in full when %s changes, since it reaches many tests", (f) => {
    expect(select([f]).mode).toBe("full");
  });

  it("runs in full when a non-Python file under the leg changes, since a test may read it", () => {
    expect(select(["tests/fixtures/data.json"]).mode).toBe("full");
  });

  it("ignores documentation and other languages' code", () => {
    expect(select(["README.md", "web/app.ts", "api/main.go"]).mode).toBe("skip");
  });

  it("ignores a deleted test file instead of passing a missing path to pytest", () => {
    expect(select(["tests/test_deleted.py"]).mode).toBe("skip");
  });

  it("runs in full when Python outside a sub-directory leg changes, since an installed package may link it", () => {
    expect(select(["shared/lib.py"], "svc/").mode).toBe("full");
  });

  it("returns test paths relative to the leg directory", () => {
    const d = selectPytestTests({
      changedFiles: ["svc/app/views.py"],
      prefix: "svc/",
      testFiles: ["svc/tests/test_views.py"],
      exists: () => true,
    });
    expect(d).toMatchObject({ mode: "scoped", tests: ["tests/test_views.py"] });
  });
});

describe("pytestScopedArgv", () => {
  it("keeps the options, drops the original paths, and keeps only tests under those paths", () => {
    expect(
      pytestScopedArgv({
        exec: ["python", "-m", "pytest"],
        options: ["-q"],
        paths: ["tests/unit"],
        tests: ["tests/unit/test_a.py", "tests/integration/test_b.py"],
      }),
    ).toEqual(["python", "-m", "pytest", "-q", "tests/unit/test_a.py"]);
  });

  it("turns off the coverage floor when the command measures coverage, because a subset cannot meet a global floor", () => {
    expect(pytestScopedArgv({ exec: ["pytest"], options: ["--cov=app"], paths: [], tests: ["tests/test_a.py"] })).toEqual([
      "pytest",
      "--cov=app",
      "--cov-fail-under=0",
      "tests/test_a.py",
    ]);
  });
});

describe("parseJestArgs", () => {
  it("accepts flags and --flag=value options", () => {
    expect(parseJestArgs(["--ci", "--maxWorkers=2", "--coverage"])).toEqual({
      options: ["--ci", "--maxWorkers=2", "--coverage"],
    });
  });

  it("refuses a bare value or positional pattern, which --findRelatedTests would read as a file", () => {
    expect(parseJestArgs(["--maxWorkers", "2"])).toBeNull();
    expect(parseJestArgs(["src/"])).toBeNull();
  });

  it.each(["--onlyChanged", "--changedSince=main", "--shard=1/2", "--listTests", "--findRelatedTests", "--watch"])(
    "refuses %s, which already selects tests by its own rule",
    (flag) => {
      expect(parseJestArgs([flag])).toBeNull();
    },
  );
});

describe("jestScopedArgv", () => {
  it("turns off the coverage floor and relates the selected files", () => {
    expect(jestScopedArgv({ exec: ["npx", "jest"], options: ["--ci"], files: ["src/a.ts", "src/a.test.ts"] })).toEqual([
      "npx",
      "jest",
      "--ci",
      "--coverageThreshold={}",
      "--findRelatedTests",
      "src/a.ts",
      "src/a.test.ts",
    ]);
  });

  it("builds the listing probe that counts tests before anything runs", () => {
    expect(jestScopedArgv({ exec: ["jest"], options: [], files: ["src/a.ts"], list: true })).toEqual([
      "jest",
      "--coverageThreshold={}",
      "--listTests",
      "--findRelatedTests",
      "src/a.ts",
    ]);
  });
});

describe("snapshotOwners", () => {
  it("maps a changed snapshot to the test file that owns it", () => {
    expect(
      snapshotOwners(["src/__snapshots__/Button.test.tsx.snap"], ["src/Button.test.tsx", "src/Other.test.tsx"]),
    ).toEqual(["src/Button.test.tsx"]);
  });
});

describe("unclassifiedJsInputs", () => {
  // The caller passes predicates built from the shared glob matcher; plain
  // regexes stand in for it here.
  const isTest = (f) => /\.test\.(js|ts|tsx)$/.test(f);
  const isSource = (f) => /\.(js|ts|tsx|json|css)$/.test(f);
  const unclassified = (changedFiles, prefix = "") =>
    unclassifiedJsInputs({ changedFiles, prefix, isSource, isTest, testContents: ["readFileSync('fixtures/a.txt')"] });

  it("returns nothing for source, test, documentation, and other languages' files", () => {
    expect(unclassified(["src/a.ts", "src/a.test.ts", "README.md", "api/main.go", "svc/app.py"])).toEqual([]);
  });

  it("returns nothing for a fixture a test names", () => {
    expect(unclassified(["fixtures/a.txt"])).toEqual([]);
  });

  it("returns a file no rule can relate to a test, so the caller runs in full", () => {
    expect(unclassified(["fixtures/b.txt"])).toEqual(["fixtures/b.txt"]);
  });

  it("returns JS code outside a sub-directory leg, which a workspace link may reach", () => {
    expect(unclassified(["packages/b/src/x.ts"], "packages/a/")).toEqual(["packages/b/src/x.ts"]);
  });
});
