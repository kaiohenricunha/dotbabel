import { describe, it, expect } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  FULL_COMMANDS,
  main,
  mustRunGlobs,
  parseScript,
  scopedLintCommands,
} from "../scripts/attest-scope.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, "../../..");
const SCRIPT = path.join(REPO, "plugins/dotbabel/scripts/attest-scope.mjs");
const LINT_SCRIPT = JSON.parse(readFileSync(path.join(REPO, "package.json"), "utf8")).scripts.lint;

const POLICY = {
  quality: {
    critical_paths: ["plugins/dotbabel/src/**", "plugins/dotbabel/bin/**"],
    components: [
      {
        root: ".",
        tools: {
          lint: { argv: ["npm", "run", "lint"], paths: ["**/*.md", "*.md", "plugins/dotbabel/src/**"] },
          test: { argv: ["npm", "test"], paths: ["plugins/dotbabel/src/**"] },
          coverage: { argv: ["npm", "run", "coverage"], paths: ["plugins/dotbabel/src/**"] },
        },
      },
    ],
  },
};

/**
 * An in-memory ScopeIo. `runs` records every command; `onRun` decides each
 * exit code and may write files (the vitest json report).
 */
function fakeIo({ files = {}, onRun = () => 0 } = {}) {
  const fs = {
    "package.json": JSON.stringify({ scripts: { lint: LINT_SCRIPT } }),
    ".dotbabel.json": JSON.stringify(POLICY),
    ...files,
  };
  const runs = [];
  const logs = [];
  const io = {
    readText: (p) => {
      if (!(p in fs)) throw new Error(`ENOENT ${p}`);
      return fs[p];
    },
    exists: (p) => p in fs,
    writeText: (p, text) => {
      fs[p] = text;
    },
    listFiles: (dir) => Object.keys(fs).filter((p) => p.startsWith(`${dir}/`)).sort(),
    run: (cmd, args) => {
      runs.push([cmd, ...args]);
      return onRun(cmd, args, fs);
    },
    tempDir: () => "/tmp/scope",
    cleanup: () => {},
    log: (m) => logs.push(m),
  };
  return { io, fs, runs, logs };
}

const ENV = (extra = {}) => ({
  DOTBABEL_ATTEST_CHANGED_FILES: "/in/changed.json",
  DOTBABEL_ATTEST_SKIP_FILE: "/out/skip",
  ...extra,
});
const changedFiles = (list) => ({ "/in/changed.json": JSON.stringify(list) });

/** onRun that writes a vitest json report with `count` tests for a vitest run. */
const vitestReports = (count, exit = 0) => (cmd, args, fs) => {
  const out = args.find((a) => a.startsWith("--outputFile.json="));
  if (out && count !== undefined) fs[out.slice("--outputFile.json=".length)] = JSON.stringify({ numTotalTests: count });
  return exit;
};

describe("attest-scope.mjs — usage and fail-open", () => {
  it("rejects an unknown leg with exit 64", () => {
    const { io, runs } = fakeIo();
    expect(main({ argv: ["knip"], env: ENV(), io })).toBe(64);
    expect(runs).toEqual([]);
  });

  it("runs every leg in full, exactly as before scoping, when the changed-file list is unset", () => {
    for (const leg of ["lint", "test", "bats"]) {
      const { io, runs } = fakeIo();
      expect(main({ argv: [leg], env: {}, io })).toBe(0);
      expect(runs).toEqual([[FULL_COMMANDS[leg][0], ...FULL_COMMANDS[leg][1]]]);
    }
    expect(FULL_COMMANDS.lint).toEqual(["npm", ["run", "lint"]]);
    expect(FULL_COMMANDS.test).toEqual(["npm", ["test", "--", "--coverage"]]);
    expect(FULL_COMMANDS.bats).toEqual(["bash", ["plugins/dotbabel/scripts/run-bats.sh"]]);
  });

  it("runs in full when the changed-file list is unreadable or empty", () => {
    for (const files of [{}, { "/in/changed.json": "[]" }, { "/in/changed.json": "not json" }]) {
      const { io, runs } = fakeIo({ files });
      main({ argv: ["bats"], env: ENV(), io });
      expect(runs).toEqual([["bash", "plugins/dotbabel/scripts/run-bats.sh"]]);
    }
  });

  it("propagates a full run's failure exit code", () => {
    const { io } = fakeIo({ onRun: () => 3 });
    expect(main({ argv: ["test"], env: {}, io })).toBe(3);
  });
});

describe("attest-scope.mjs — lint", () => {
  it("derives the scoped commands from package.json's lint script", () => {
    const { io, runs, fs } = fakeIo({
      files: {
        ...changedFiles(["README.md", "a.json", "plugins/dotbabel/src/x.mjs", "gone.md", "x.sh"]),
        "README.md": "",
        "a.json": "",
        "plugins/dotbabel/src/x.mjs": "",
        "x.sh": "",
      },
    });
    expect(main({ argv: ["lint"], env: ENV(), io })).toBe(0);
    expect(runs).toEqual([
      ["npx", "prettier", "--check", "README.md", "a.json", "--ignore-path", ".gitignore", "--ignore-path", ".prettierignore", "--ignore-unknown"],
      ["npx", "markdownlint-cli2", "README.md", "#node_modules", "#.claude/worktrees"],
      ["node", "scripts/check-jsdoc-coverage.mjs", "plugins/dotbabel/src/x.mjs"],
    ]);
    expect("/out/skip" in fs).toBe(false);
  });

  it("stops at the first failing lint command", () => {
    const { io, runs } = fakeIo({ files: { ...changedFiles(["README.md"]), "README.md": "" }, onRun: () => 1 });
    expect(main({ argv: ["lint"], env: ENV(), io })).toBe(1);
    expect(runs).toHaveLength(1);
  });

  it("skips with a reason when no changed file is linted and quality's lint does not measure one", () => {
    const { io, runs, fs } = fakeIo({ files: { ...changedFiles(["x.sh"]), "x.sh": "" } });
    expect(main({ argv: ["lint"], env: ENV(), io })).toBe(0);
    expect(runs).toEqual([]);
    expect(fs["/out/skip"]).toMatch(/no changed file is linted/);
  });

  it("runs the full lint when only a deleted file quality's lint measures changed", () => {
    const { io, runs } = fakeIo({ files: changedFiles(["docs/deleted.md"]) });
    expect(main({ argv: ["lint"], env: ENV(), io })).toBe(0);
    expect(runs).toEqual([["npm", "run", "lint"]]);
  });

  it("runs the full lint when a lint configuration file changed", () => {
    for (const trigger of [".prettierrc.json", ".markdownlint-cli2.jsonc", ".prettierignore", "scripts/check-jsdoc-coverage.mjs"]) {
      const { io, runs } = fakeIo({ files: { ...changedFiles(["README.md", trigger]), "README.md": "", [trigger]: "" } });
      main({ argv: ["lint"], env: ENV(), io });
      expect(runs).toEqual([["npm", "run", "lint"]]);
    }
  });

  it("runs the full lint when the lint script has an unknown shape", () => {
    const { io, runs } = fakeIo({
      files: {
        ...changedFiles(["README.md"]),
        "README.md": "",
        "package.json": JSON.stringify({ scripts: { lint: "eslint . && prettier --check \"**/*.md\"" } }),
      },
    });
    main({ argv: ["lint"], env: ENV(), io });
    expect(runs).toEqual([["npm", "run", "lint"]]);
  });

  it("fails rather than passing empty when there is nothing to run and no skip file to report through", () => {
    const { io, runs } = fakeIo({ files: { ...changedFiles(["x.sh"]), "x.sh": "" } });
    expect(main({ argv: ["lint"], env: { DOTBABEL_ATTEST_CHANGED_FILES: "/in/changed.json" }, io })).toBe(1);
    expect(runs).toEqual([]);
  });
});

describe("parseScript / scopedLintCommands", () => {
  it("splits && segments and groups double quotes", () => {
    expect(parseScript('a "b c" && d')).toEqual([["a", "b c"], ["d"]]);
  });

  it("refuses shell syntax it cannot model", () => {
    for (const s of ["a | b", "a; b", "a || b", "echo $X", "a 'b'", undefined]) {
      expect(parseScript(s)).toBeNull();
    }
  });

  it("drops a segment with no file in scope", () => {
    expect(scopedLintCommands(LINT_SCRIPT, ["a.yml"])).toEqual([
      ["npx", ["prettier", "--check", "a.yml", "--ignore-path", ".gitignore", "--ignore-path", ".prettierignore", "--ignore-unknown"]],
    ]);
    expect(scopedLintCommands(LINT_SCRIPT, [])).toEqual([]);
  });

  it("checks jsdoc only for .mjs files under the script's roots", () => {
    const cmds = scopedLintCommands(LINT_SCRIPT, ["plugins/dotbabel/src/a.mjs", "plugins/dotbabel/bin/b.mjs", "plugins/dotbabel/srcx/c.mjs"]);
    expect(cmds).toEqual([["node", ["scripts/check-jsdoc-coverage.mjs", "plugins/dotbabel/src/a.mjs"]]]);
  });
});

describe("mustRunGlobs", () => {
  it("collects critical paths and the reused tools' paths from .dotbabel.json", () => {
    const { io } = fakeIo();
    expect(mustRunGlobs(io, ["test", "coverage"], { critical: true })).toEqual([
      "plugins/dotbabel/src/**",
      "plugins/dotbabel/bin/**",
      "plugins/dotbabel/src/**",
      "plugins/dotbabel/src/**",
    ]);
  });

  it("returns null (everything must run) when the policy is unreadable or a reused tool has no paths", () => {
    expect(mustRunGlobs(fakeIo({ files: { ".dotbabel.json": "{" } }).io, ["lint"])).toBeNull();
    const noPaths = { quality: { components: [{ tools: { lint: { argv: ["x"] } } }] } };
    expect(mustRunGlobs(fakeIo({ files: { ".dotbabel.json": JSON.stringify(noPaths) } }).io, ["lint"])).toBeNull();
  });
});

describe("attest-scope.mjs — test", () => {
  const tests = {
    "plugins/dotbabel/tests/a.test.mjs": 'import "../src/a.mjs";',
    "plugins/dotbabel/tests/bin.test.mjs": 'execFileSync("node", [BIN("dotbabel-tool.mjs")]);',
    "plugins/dotbabel/tests/docs.test.mjs": 'read("docs/guide.md")',
  };
  const tree = {
    ...tests,
    "plugins/dotbabel/src/a.mjs": "export const a = 1;",
    "plugins/dotbabel/src/deep.mjs": "export const d = 1;",
    "plugins/dotbabel/bin/dotbabel-tool.mjs": 'import "../src/deep.mjs";',
    "docs/guide.md": "",
    "docs/other.md": "",
  };

  it("runs a scoped vitest related run with coverage and the global thresholds off", () => {
    const { io, runs } = fakeIo({ files: { ...tree, ...changedFiles(["plugins/dotbabel/src/a.mjs"]) }, onRun: vitestReports(4) });
    expect(main({ argv: ["test"], env: ENV(), io })).toBe(0);
    expect(runs).toHaveLength(1);
    const [cmd, ...args] = runs[0];
    expect([cmd, args[0], args[1]]).toEqual(["npx", "vitest", "related"]);
    expect(args).toEqual(
      expect.arrayContaining([
        "--coverage",
        "--coverage.thresholds.lines=0",
        "--coverage.thresholds.functions=0",
        "--coverage.thresholds.branches=0",
        "--coverage.thresholds.statements=0",
        "plugins/dotbabel/src/a.mjs",
      ]),
    );
  });

  it("selects the test that runs a bin reaching the changed module through imports", () => {
    const { io, runs } = fakeIo({ files: { ...tree, ...changedFiles(["plugins/dotbabel/src/deep.mjs"]) }, onRun: vitestReports(2) });
    main({ argv: ["test"], env: ENV(), io });
    expect(runs[0]).toContain("plugins/dotbabel/tests/bin.test.mjs");
  });

  it("runs the full suite when a shared test input changed", () => {
    const { io, runs } = fakeIo({ files: { ...tree, ...changedFiles(["plugins/dotbabel/tests/fixtures/temp-dir.mjs"]) } });
    main({ argv: ["test"], env: ENV(), io });
    expect(runs).toEqual([["npm", "test", "--", "--coverage"]]);
  });

  it("skips with a reason when no test is in scope and quality measures nothing", () => {
    const { io, runs, fs } = fakeIo({ files: { ...tree, ...changedFiles(["docs/other.md"]) } });
    expect(main({ argv: ["test"], env: ENV(), io })).toBe(0);
    expect(runs).toEqual([]);
    expect(fs["/out/skip"]).toMatch(/no test/);
  });

  it("records a scoped run that reached zero tests as a skip, never as a pass", () => {
    const { io, fs } = fakeIo({ files: { ...tree, ...changedFiles(["docs/guide.md"]) }, onRun: vitestReports(0) });
    expect(main({ argv: ["test"], env: ENV(), io })).toBe(0);
    expect(fs["/out/skip"]).toMatch(/reached no test/);
  });

  it("runs the full suite when a must-run change reaches zero tests", () => {
    const { io, runs, fs } = fakeIo({
      files: { ...tree, ...changedFiles(["plugins/dotbabel/src/a.mjs"]) },
      onRun: vitestReports(0),
    });
    expect(main({ argv: ["test"], env: ENV(), io })).toBe(0);
    expect(runs[1]).toEqual(["npm", "test", "--", "--coverage"]);
    expect("/out/skip" in fs).toBe(false);
  });

  it("runs the full suite when a must-run change selects nothing at all", () => {
    const { io, runs } = fakeIo({ files: { ...tree, "plugins/dotbabel/src/lonely.mjs": "", ...changedFiles(["plugins/dotbabel/bin/gone.sh"]) } });
    main({ argv: ["test"], env: ENV(), io });
    expect(runs).toEqual([["npm", "test", "--", "--coverage"]]);
  });

  it("runs the full suite when the scoped run's test count is unknown", () => {
    const { io, runs } = fakeIo({ files: { ...tree, ...changedFiles(["docs/guide.md"]) }, onRun: vitestReports(undefined) });
    main({ argv: ["test"], env: ENV(), io });
    expect(runs[1]).toEqual(["npm", "test", "--", "--coverage"]);
  });

  it("returns a failing scoped run's exit code and writes no skip", () => {
    const { io, fs, runs } = fakeIo({ files: { ...tree, ...changedFiles(["docs/guide.md"]) }, onRun: vitestReports(0, 1) });
    expect(main({ argv: ["test"], env: ENV(), io })).toBe(1);
    expect(runs).toHaveLength(1);
    expect("/out/skip" in fs).toBe(false);
  });

  it("never skips when the quality policy cannot be read", () => {
    const { io, runs } = fakeIo({ files: { ...tree, ".dotbabel.json": "{", ...changedFiles(["docs/other.md"]) } });
    main({ argv: ["test"], env: ENV(), io });
    expect(runs).toEqual([["npm", "test", "--", "--coverage"]]);
  });
});

describe("attest-scope.mjs — bats", () => {
  const tree = {
    "plugins/dotbabel/tests/bats/helpers.bash": "",
    "plugins/dotbabel/tests/bats/x.bats": 'run "$ROOT/plugins/dotbabel/scripts/x.sh"',
    "plugins/dotbabel/tests/bats/y.bats": 'run node "$ROOT/plugins/dotbabel/bin/dotbabel-tool.mjs"',
    "plugins/dotbabel/scripts/x.sh": "",
    "plugins/dotbabel/bin/dotbabel-tool.mjs": 'import "../src/deep.mjs";',
    "plugins/dotbabel/src/deep.mjs": "",
  };

  it("runs only the suites that name a changed file or a bin reaching it", () => {
    const { io, runs } = fakeIo({ files: { ...tree, ...changedFiles(["plugins/dotbabel/scripts/x.sh", "plugins/dotbabel/src/deep.mjs"]) } });
    main({ argv: ["bats"], env: ENV(), io });
    expect(runs).toEqual([
      ["bash", "plugins/dotbabel/scripts/run-bats.sh", "plugins/dotbabel/tests/bats/x.bats", "plugins/dotbabel/tests/bats/y.bats"],
    ]);
  });

  it("runs every suite when a bats helper or the wrapper changed", () => {
    for (const trigger of ["plugins/dotbabel/tests/bats/helpers.bash", "plugins/dotbabel/scripts/run-bats.sh"]) {
      const { io, runs } = fakeIo({ files: { ...tree, ...changedFiles([trigger]) } });
      main({ argv: ["bats"], env: ENV(), io });
      expect(runs).toEqual([["bash", "plugins/dotbabel/scripts/run-bats.sh"]]);
    }
  });

  it("runs a changed suite on its own and skips when no suite is in scope", () => {
    const one = fakeIo({ files: { ...tree, ...changedFiles(["plugins/dotbabel/tests/bats/x.bats"]) } });
    main({ argv: ["bats"], env: ENV(), io: one.io });
    expect(one.runs).toEqual([["bash", "plugins/dotbabel/scripts/run-bats.sh", "plugins/dotbabel/tests/bats/x.bats"]]);
    const none = fakeIo({ files: { ...tree, ...changedFiles(["docs/a.md"]) } });
    expect(main({ argv: ["bats"], env: ENV(), io: none.io })).toBe(0);
    expect(none.runs).toEqual([]);
    expect(none.fs["/out/skip"]).toMatch(/no bats suite/);
  });
});

describe("attest-scope.mjs — as a CLI in this repository", () => {
  it("writes the skip file and exits 0 when no bats suite names the change", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "attest-scope-cli-"));
    const list = path.join(dir, "changed.json");
    const skipFile = path.join(dir, "skip");
    writeFileSync(list, JSON.stringify(["docs/zz-no-suite-names-this-file.txt"]));
    const r = spawnSync(process.execPath, [SCRIPT, "bats"], {
      cwd: REPO,
      env: { ...process.env, DOTBABEL_ATTEST_CHANGED_FILES: list, DOTBABEL_ATTEST_SKIP_FILE: skipFile },
      encoding: "utf8",
    });
    expect(r.status).toBe(0);
    expect(existsSync(skipFile)).toBe(true);
    expect(readFileSync(skipFile, "utf8")).toMatch(/no bats suite/);
  });
});

describe("the lint tools honour the repository's ignores for explicit paths", () => {
  // The scoped lint passes changed files explicitly instead of the script's
  // globs. These prove the tools still apply .prettierignore and the
  // markdownlint config's `ignores` to an explicit path, so no exclusion list
  // has to be copied into the scoper.
  it("prettier skips an explicitly named file that .prettierignore lists", () => {
    const out = execFileSync(
      "npx",
      ["prettier", "--check", "skills/security-audit/references/upstream/HUNTING.md", "--ignore-path", ".gitignore", "--ignore-path", ".prettierignore", "--ignore-unknown"],
      { cwd: REPO, encoding: "utf8" },
    );
    expect(out).toMatch(/All matched files use Prettier code style/);
  });

  it("markdownlint-cli2 lints zero files for an explicitly named file its config ignores", () => {
    const r = spawnSync("npx", ["markdownlint-cli2", "commands/merge-pr.md", "#node_modules", "#.claude/worktrees"], {
      cwd: REPO,
      encoding: "utf8",
    });
    expect(r.status).toBe(0);
    expect(`${r.stdout}${r.stderr}`).toMatch(/Linting: 0 file/);
  });
});
