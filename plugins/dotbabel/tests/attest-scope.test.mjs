import { describe, it, expect } from "vitest";

import {
  CHANGED_FILES_ENV,
  SKIP_FILE_ENV,
  entrypointsReaching,
  fullRunTrigger,
  matchesAnyGlob,
  readChangedFiles,
  scopeGlobToRegExp,
  selectTests,
  vitestScopedArgs,
  vitestTestCount,
} from "../src/attest-scope.mjs";

/** A readText stub over an in-memory file map; throws for a missing path like fs does. */
function textReader(files) {
  return (path) => {
    if (!(path in files)) throw new Error(`ENOENT: ${path}`);
    return files[path];
  };
}

describe("env names", () => {
  it("are the names the local-attest runner passes", () => {
    expect(CHANGED_FILES_ENV).toBe("DOTBABEL_ATTEST_CHANGED_FILES");
    expect(SKIP_FILE_ENV).toBe("DOTBABEL_ATTEST_SKIP_FILE");
  });
});

describe("readChangedFiles", () => {
  const read = textReader({
    "/t/ok.json": JSON.stringify(["a.md", "src/b.mjs"]),
    "/t/empty.json": "[]",
    "/t/bad.json": "{not json",
    "/t/obj.json": JSON.stringify({ files: ["a"] }),
    "/t/mixed.json": JSON.stringify(["a", 7]),
    "/t/blank.json": JSON.stringify(["a", ""]),
  });

  it("returns the list the runner wrote", () => {
    expect(readChangedFiles({ [CHANGED_FILES_ENV]: "/t/ok.json" }, read)).toEqual(["a.md", "src/b.mjs"]);
  });

  it("fails open (null) when the variable is unset or empty", () => {
    expect(readChangedFiles({}, read)).toBeNull();
    expect(readChangedFiles({ [CHANGED_FILES_ENV]: "" }, read)).toBeNull();
  });

  it("fails open (null) when the file is unreadable or not a list of paths", () => {
    for (const p of ["/t/missing.json", "/t/bad.json", "/t/obj.json", "/t/mixed.json", "/t/blank.json"]) {
      expect(readChangedFiles({ [CHANGED_FILES_ENV]: p }, read)).toBeNull();
    }
  });

  it("fails open (null) on an empty list — zero known files is not a scope", () => {
    expect(readChangedFiles({ [CHANGED_FILES_ENV]: "/t/empty.json" }, read)).toBeNull();
  });
});

describe("scopeGlobToRegExp / matchesAnyGlob", () => {
  it("matches ** across directories and at the root", () => {
    expect(scopeGlobToRegExp("**/*.md").test("README.md")).toBe(true);
    expect(scopeGlobToRegExp("**/*.md").test("docs/a/b.md")).toBe(true);
    expect(scopeGlobToRegExp("plugins/**").test("plugins/x/y.mjs")).toBe(true);
  });

  it("keeps * inside one segment and ? to one character", () => {
    expect(scopeGlobToRegExp("bats/*.bats").test("bats/a.bats")).toBe(true);
    expect(scopeGlobToRegExp("bats/*.bats").test("bats/sub/a.bats")).toBe(false);
    expect(scopeGlobToRegExp("a?.md").test("ab.md")).toBe(true);
    expect(scopeGlobToRegExp("a?.md").test("a/.md")).toBe(false);
  });

  it("expands {a,b} alternation and escapes regex characters", () => {
    const re = scopeGlobToRegExp("**/*.{json,yml}");
    expect(re.test("x/a.json")).toBe(true);
    expect(re.test("a.yml")).toBe(true);
    expect(re.test("a.yaml")).toBe(false);
    expect(scopeGlobToRegExp("a.b").test("axb")).toBe(false);
    expect(scopeGlobToRegExp("a+(b)").test("a+(b)")).toBe(true);
  });

  it("is anchored at both ends", () => {
    expect(scopeGlobToRegExp("*.md").test("x/a.md")).toBe(false);
    expect(scopeGlobToRegExp("a.md").test("a.mdx")).toBe(false);
  });

  it("matchesAnyGlob is false for an empty glob list", () => {
    expect(matchesAnyGlob("a.md", [])).toBe(false);
    expect(matchesAnyGlob("a.md", ["*.json", "*.md"])).toBe(true);
  });
});

describe("fullRunTrigger", () => {
  const fullTriggers = ["vitest.config.mjs", "package.json", "package-lock.json", "tests/bats/**"];

  it("returns the first changed file that matches a trigger", () => {
    expect(fullRunTrigger({ changedFiles: ["a.md", "package-lock.json"], fullTriggers })).toBe("package-lock.json");
  });

  it("returns null when no trigger changed", () => {
    expect(fullRunTrigger({ changedFiles: ["a.md", "src/x.mjs"], fullTriggers })).toBeNull();
    expect(fullRunTrigger({ changedFiles: [], fullTriggers })).toBeNull();
  });

  it("never counts a test file as a trigger", () => {
    const testGlobs = ["tests/bats/*.bats"];
    expect(fullRunTrigger({ changedFiles: ["tests/bats/a.bats"], fullTriggers, testGlobs })).toBeNull();
    expect(fullRunTrigger({ changedFiles: ["tests/bats/helpers.bash"], fullTriggers, testGlobs })).toBe(
      "tests/bats/helpers.bash",
    );
  });
});

describe("entrypointsReaching", () => {
  // bin/a -> src/x -> src/lib/y ; bin/b -> src/z (dynamic) ; bin/c imports a bare package only
  const files = {
    "bin/a.mjs": 'import { x } from "../src/x.mjs";\n',
    "src/x.mjs": 'export { y } from "./lib/y.mjs";\nimport fs from "node:fs";\n',
    "src/lib/y.mjs": "export const y = 1;\n",
    "bin/b.mjs": 'const m = await import("../src/z.mjs");\n',
    "src/z.mjs": 'import "./missing.mjs";\n',
    "bin/c.mjs": 'import yaml from "yaml";\n',
    "bin/cycle.mjs": 'import "../src/p.mjs";\n',
    "src/p.mjs": 'import "./q.mjs";\n',
    "src/q.mjs": 'import "./p.mjs";\n',
  };
  const entrypoints = ["bin/a.mjs", "bin/b.mjs", "bin/c.mjs", "bin/cycle.mjs"];
  const readText = textReader(files);

  it("finds an entrypoint that reaches a changed module through other imports", () => {
    expect(entrypointsReaching({ entrypoints, changedFiles: ["src/lib/y.mjs"], readText })).toEqual(["bin/a.mjs"]);
  });

  it("follows dynamic imports with a literal specifier", () => {
    expect(entrypointsReaching({ entrypoints, changedFiles: ["src/z.mjs"], readText })).toEqual(["bin/b.mjs"]);
  });

  it("counts an entrypoint that changed itself", () => {
    expect(entrypointsReaching({ entrypoints, changedFiles: ["bin/c.mjs"], readText })).toEqual(["bin/c.mjs"]);
  });

  it("treats a missing module as a leaf and a deleted changed module as reachable", () => {
    expect(entrypointsReaching({ entrypoints, changedFiles: ["src/missing.mjs"], readText })).toEqual(["bin/b.mjs"]);
  });

  it("terminates on an import cycle", () => {
    expect(entrypointsReaching({ entrypoints, changedFiles: ["src/q.mjs"], readText })).toEqual(["bin/cycle.mjs"]);
  });

  it("returns nothing when no changed file is in any closure", () => {
    expect(entrypointsReaching({ entrypoints, changedFiles: ["docs/a.md"], readText })).toEqual([]);
    expect(entrypointsReaching({ entrypoints, changedFiles: [], readText })).toEqual([]);
  });
});

describe("selectTests", () => {
  const testGlobs = ["tests/**/*.test.mjs"];
  const sourceGlobs = ["**/*.{mjs,js,cjs}"];
  const fullTriggers = ["vitest.config.mjs", "package.json", "tests/fixtures/setup.mjs"];
  const testFiles = [
    { path: "tests/a.test.mjs", content: 'import { a } from "../src/a.mjs";' },
    { path: "tests/fixture.test.mjs", content: 'const f = "tests/fixtures/data/sample.json";' },
    { path: "tests/bin.test.mjs", content: 'execFileSync("node", [join(ROOT, "bin/tool.mjs")]);' },
    { path: "tests/docs.test.mjs", content: 'readFileSync("README.md")' },
  ];
  const present = new Set([
    "src/a.mjs",
    "src/b.mjs",
    "tests/a.test.mjs",
    "tests/new.test.mjs",
    "tests/fixtures/data/sample.json",
    "README.md",
    "docs/x.md",
    "bin/tool.mjs",
  ]);
  const exists = (p) => present.has(p);
  const base = { exists, testFiles, testGlobs, sourceGlobs, fullTriggers };

  it("runs the full suite when a shared input changed", () => {
    const r = selectTests({ ...base, changedFiles: ["src/a.mjs", "vitest.config.mjs"] });
    expect(r.mode).toBe("full");
    expect(r.reason).toContain("vitest.config.mjs");
  });

  it("hands changed sources to the runner's related mode and keeps test files apart", () => {
    const r = selectTests({ ...base, changedFiles: ["src/b.mjs", "tests/new.test.mjs"] });
    expect(r).toMatchObject({ mode: "scoped", sources: ["src/b.mjs"], tests: ["tests/new.test.mjs"] });
  });

  it("selects tests that mention a changed fixture by path", () => {
    const r = selectTests({ ...base, changedFiles: ["tests/fixtures/data/sample.json"] });
    expect(r).toMatchObject({ mode: "scoped", sources: [], tests: ["tests/fixture.test.mjs"] });
  });

  it("selects tests that mention a deleted module by basename, without passing it as a source", () => {
    const r = selectTests({ ...base, changedFiles: ["src/gone/a.mjs"] });
    expect(r).toMatchObject({ mode: "scoped", sources: [], tests: ["tests/a.test.mjs"] });
  });

  it("selects tests that mention an entrypoint reaching a changed module", () => {
    const r = selectTests({ ...base, changedFiles: ["src/b.mjs"], entrypoints: ["bin/tool.mjs"] });
    expect(r.tests).toEqual(["tests/bin.test.mjs"]);
  });

  it("selects tests for a changed data file outside the import graph", () => {
    const r = selectTests({ ...base, changedFiles: ["README.md"] });
    expect(r).toMatchObject({ mode: "scoped", sources: [], tests: ["tests/docs.test.mjs"] });
  });

  it("skips with a reason when nothing is in scope", () => {
    const r = selectTests({ ...base, changedFiles: ["docs/x.md"] });
    expect(r.mode).toBe("skip");
    expect(r.reason).toMatch(/no test/i);
  });

  it("never skips when a changed file matches mustRun, even with nothing selected", () => {
    const r = selectTests({ ...base, changedFiles: ["docs/x.md"], mustRun: ["docs/**"] });
    expect(r).toMatchObject({ mode: "scoped", sources: [], tests: [] });
  });

  it("does not hand a deleted test file to the runner", () => {
    const r = selectTests({ ...base, changedFiles: ["tests/deleted.test.mjs"] });
    expect(r.mode).toBe("skip");
  });

  it("returns sorted, de-duplicated lists", () => {
    const r = selectTests({ ...base, changedFiles: ["src/a.mjs", "tests/a.test.mjs", "README.md"] });
    expect(r.sources).toEqual(["src/a.mjs"]);
    expect(r.tests).toEqual(["tests/a.test.mjs", "tests/docs.test.mjs"]);
  });

  it("works for a runner with no import graph (bats)", () => {
    const bats = selectTests({
      changedFiles: ["scripts/x.sh", "tests/bats/helpers.bash"],
      exists: () => true,
      testFiles: [{ path: "tests/bats/x.bats", content: 'run "$ROOT/scripts/x.sh"' }],
      testGlobs: ["tests/bats/*.bats"],
      sourceGlobs: [],
      fullTriggers: ["tests/bats/**"],
    });
    expect(bats.mode).toBe("full");
    const scoped = selectTests({
      changedFiles: ["scripts/x.sh"],
      exists: () => true,
      testFiles: [{ path: "tests/bats/x.bats", content: 'run "$ROOT/scripts/x.sh"' }],
      testGlobs: ["tests/bats/*.bats"],
      sourceGlobs: [],
      fullTriggers: ["tests/bats/**"],
    });
    expect(scoped).toMatchObject({ mode: "scoped", sources: [], tests: ["tests/bats/x.bats"] });
  });
});

describe("vitestScopedArgs", () => {
  it("builds a related run over sources and tests", () => {
    expect(vitestScopedArgs({ sources: ["src/a.mjs"], tests: ["tests/a.test.mjs"] })).toEqual([
      "related",
      "--run",
      "--passWithNoTests",
      "src/a.mjs",
      "tests/a.test.mjs",
    ]);
  });

  it("turns the global coverage thresholds off for a scoped coverage run", () => {
    const args = vitestScopedArgs({ sources: ["src/a.mjs"], tests: [], coverage: true });
    expect(args).toEqual([
      "related",
      "--run",
      "--passWithNoTests",
      "--coverage",
      "--coverage.thresholds.lines=0",
      "--coverage.thresholds.functions=0",
      "--coverage.thresholds.branches=0",
      "--coverage.thresholds.statements=0",
      "src/a.mjs",
    ]);
  });

  it("adds the json reporter beside the default one when asked, so the test count can be read", () => {
    const args = vitestScopedArgs({ sources: [], tests: ["tests/a.test.mjs"], jsonReport: "/tmp/r.json" });
    expect(args).toEqual([
      "related",
      "--run",
      "--passWithNoTests",
      "--reporter=default",
      "--reporter=json",
      "--outputFile.json=/tmp/r.json",
      "tests/a.test.mjs",
    ]);
  });
});

describe("vitestTestCount", () => {
  it("reads numTotalTests, zero included", () => {
    expect(vitestTestCount(JSON.stringify({ numTotalTests: 12 }))).toBe(12);
    expect(vitestTestCount(JSON.stringify({ numTotalTests: 0 }))).toBe(0);
  });

  it("returns null — unknown, never zero — for anything that is not a count", () => {
    for (const text of ["", "{", "null", "{}", JSON.stringify({ numTotalTests: -1 }), JSON.stringify({ numTotalTests: "3" })]) {
      expect(vitestTestCount(text)).toBeNull();
    }
  });
});
