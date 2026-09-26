// Additive boundary tests for `quality/adapters/python.mjs`, closing the gap
// between quality-adapters.test.mjs's light indirect coverage and the
// TEST-1 mutation-score floor (baseline 57.63%, 236 mutants).
//
// Eight mutants are documented as genuinely equivalent rather than chased,
// each confirmed empirically via differential scripts in this session's
// scratchpad (equiv-python-adapter.mjs, equiv-python-claimed.mjs,
// equiv-python-read.mjs), not by inspection:
//   - 15:76-81 (`includeTests = false` default on the unexported
//     `configuredPythonPlans`): its one call site (line 132) always passes
//     an explicit 4th argument, so the default can never execute.
//   - 16:14-16 (`let text = ""`): only read after `fs.readFileSync`
//     succeeds and reassigns it, or the catch returns `[]` before it is
//     read again — the initial value is never observed.
//   - 17:85-91 and 41:55-61 (`"utf8"` -> `""` on two separate reads):
//     the resulting Buffer's `.toString()` defaults to utf8, identical to
//     every downstream regex `.test`/`.match` call's coercion — the same
//     recurring mutant class already found in spec-file.mjs and
//     confirm.mjs.
//   - 17:102-116 and 41:72-88 (both `catch { return null/[]; }` bodies
//     emptied): every caller already treats "missing" and "unparseable"
//     identically downstream (`?? ""` or `!== null` checks that also
//     accept `undefined` in practice, or a regex test that never matches
//     the literal string "null"/"undefined") — confirmed with 8 and 6
//     probe scenarios respectively covering every declaresPytest/
//     declaresPytestCov source.
//   - 78:33-46 (`text !== null &&` forced to `true &&`): `RegExp.test`
//     coerces `null` to the string `"null"`, which never matches
//     `/pytest-cov/`, so skipping the guard changes nothing observable.
//   - 133:31-60 (the `claimed.add` loop after `configuredPythonPlans`
//     emptied to a no-op): nothing downstream ever re-checks `claimed` for
//     "lint", "format", or "typecheck" — `builtinPytestPlans` only reads
//     "test"/"coverage" and `mutationToolPlans` only reads "mutation" — so
//     configuredPythonPlans's own claims are never consulted again.
//   - 57:76-78, 64:58-60, 65:68-70 (three `?? ""` fallbacks on `read(...)`,
//     each swapped to a junk string): each fallback only fires when the
//     file is missing (read returns null), and the junk text never matches
//     the section-header regex it feeds into any more than `""` does —
//     confirmed directly against all three regexes.
//   - 121:65-93 and 121:90-93 (both branches, and the "." comparison
//     target, of `path.dirname(marker) === "." ? "." : path.dirname
//     (marker)`): this ternary is a tautology — it always equals
//     `path.dirname(marker)` regardless of which branch executes, since
//     the true-branch's literal `"."` is exactly what `path.dirname`
//     already returns whenever the condition is true. No test can
//     distinguish forcing either branch, or changing what it compares
//     against, from the untouched original.
//
// One additional mutant (29:10-98, `candidates.filter(...).map(toPlan)`
// replaced by the bare `candidates` array) is pinned by "plans a ruff lint
// candidate, with the full expected shape" — manually verified with the
// mutation applied directly to the source (the test fails as expected) —
// but Stryker's own report still lists it as Survived on every rerun. This
// looks like a coverage-analysis or sandboxing quirk in the tool, not a
// real gap; recorded rather than silently accepted.
import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pythonAdapter } from "../src/quality/adapters/python.mjs";

const dirs = [];
afterEach(() => dirs.splice(0).forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));

function makeRoot(files = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "python-adapter-behavior-"));
  dirs.push(dir);
  for (const [name, content] of Object.entries(files)) {
    const full = path.join(dir, name);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return dir;
}

function component(root, extra = {}) {
  return { id: ".:python", root: ".", absoluteRoot: root, language: "python", files: ["a.py"], markers: ["pyproject.toml"], tools: {}, ...extra };
}

function plan(root, profile = "pr", extra = {}, changeSet = { changedFiles: [] }) {
  return pythonAdapter.plan(component(root, extra), { rules: {} }, changeSet, profile);
}

function byCapability(plans, capability) {
  return plans.find((p) => p.capability === capability);
}

describe("pythonAdapter.discover", () => {
  it("roots a component at the marker file's own directory, not the repo root", () => {
    const found = pythonAdapter.discover({ files: ["services/api/pyproject.toml"] });
    expect(found).toEqual([{ root: "services/api", language: "python", markers: ["services/api/pyproject.toml"] }]);
  });

  it("uses '.' for a marker at the repository root", () => {
    const found = pythonAdapter.discover({ files: ["pyproject.toml"] });
    expect(found).toEqual([{ root: ".", language: "python", markers: ["pyproject.toml"] }]);
  });

  it("falls back to a markerless '.' component when only stray .py files exist", () => {
    const found = pythonAdapter.discover({ files: ["tools/helper.py"] });
    expect(found).toEqual([{ root: ".", language: "python", markers: [] }]);
  });

  it("discovers nothing when there is neither a marker file nor any .py file", () => {
    expect(pythonAdapter.discover({ files: ["README.md", "src/index.js"] })).toEqual([]);
  });

  it("recognizes setup.cfg as a marker on its own, not just pyproject.toml or tox.ini", () => {
    expect(pythonAdapter.discover({ files: ["setup.cfg"] })).toEqual([{ root: ".", language: "python", markers: ["setup.cfg"] }]);
  });

  it("recognizes tox.ini as a marker on its own, not just pyproject.toml or setup.cfg", () => {
    expect(pythonAdapter.discover({ files: ["tox.ini"] })).toEqual([{ root: ".", language: "python", markers: ["tox.ini"] }]);
  });

  it("roots at '.', the identity result of its own root-vs-\".\" ternary, for every marker depth", () => {
    // `path.dirname(marker) === "." ? "." : path.dirname(marker)` always
    // equals `path.dirname(marker)` regardless of which ternary branch
    // runs — it is a tautology, so no test can distinguish either branch
    // being forced or the "." comparison target changing. This test only
    // documents the two depths the identity holds for; it is not a kill.
    expect(pythonAdapter.discover({ files: ["pyproject.toml"] })[0].root).toBe(".");
    expect(pythonAdapter.discover({ files: ["a/b/pyproject.toml"] })[0].root).toBe("a/b");
  });
});

describe("configuredPythonPlans — lint", () => {
  it("does not claim lint when ruff is not configured", () => {
    const root = makeRoot({ "pyproject.toml": "[tool.black]\n" });
    expect(byCapability(plan(root), "lint")).toBeUndefined();
  });

  it("plans a ruff lint candidate, with the full expected shape, when ruff is configured", () => {
    const root = makeRoot({ "pyproject.toml": "[tool.ruff]\nline-length = 100\n" });
    expect(byCapability(plan(root), "lint")).toMatchObject({
      id: ".:python:lint:ruff",
      capability: "lint",
      ruleIds: ["correctness.lint"],
      executable: "ruff",
      argv: ["check", "."],
      availability: "candidate",
      source: "configured",
      requiresTrust: true,
    });
  });

  it("does not add a second lint plan when a project tool already claims lint, even if ruff is also configured", () => {
    const root = makeRoot({ "pyproject.toml": "[tool.ruff]\n" });
    const plans = plan(root, "pr", { tools: { lint: { argv: ["flake8"] } } });
    expect(plans.filter((p) => p.capability === "lint")).toHaveLength(1);
    expect(byCapability(plans, "lint").source).toBe("project");
  });
});

describe("configuredPythonPlans — format", () => {
  it("prefers black over ruff when both are configured", () => {
    const root = makeRoot({ "pyproject.toml": "[tool.black]\n[tool.ruff]\n" });
    expect(byCapability(plan(root), "format")).toMatchObject({ executable: "black", argv: ["--check", "."] });
  });

  it("falls back to ruff format when only ruff is configured, with the full expected shape", () => {
    const root = makeRoot({ "pyproject.toml": "[tool.ruff]\n" });
    expect(byCapability(plan(root), "format")).toMatchObject({
      capability: "format",
      executable: "ruff",
      argv: ["format", "--check", "."],
    });
  });

  it("does not claim format when neither black nor ruff is configured", () => {
    const root = makeRoot({ "pyproject.toml": "[tool.mypy]\n" });
    expect(byCapability(plan(root), "format")).toBeUndefined();
  });

  it("does not add a format plan when a project tool already claims format", () => {
    const root = makeRoot({ "pyproject.toml": "[tool.black]\n" });
    const plans = plan(root, "pr", { tools: { format: { argv: ["autopep8"] } } });
    expect(plans.filter((p) => p.capability === "format")).toHaveLength(1);
    expect(byCapability(plans, "format").source).toBe("project");
  });
});

describe("configuredPythonPlans — typecheck", () => {
  it("does not claim typecheck when neither mypy nor pyright is configured", () => {
    const root = makeRoot({ "pyproject.toml": "[tool.ruff]\n" });
    expect(byCapability(plan(root), "typecheck")).toBeUndefined();
  });

  it("plans mypy alone", () => {
    const root = makeRoot({ "pyproject.toml": "[tool.mypy]\n" });
    expect(byCapability(plan(root), "typecheck")).toMatchObject({ executable: "mypy", argv: ["."] });
  });

  it("plans pyright alone", () => {
    const root = makeRoot({ "pyproject.toml": "[tool.pyright]\n" });
    expect(byCapability(plan(root), "typecheck")).toMatchObject({ executable: "pyright", argv: ["."] });
  });

  it("reports mypy+pyright together as not_configured/ambiguous, with no other candidate leaking through", () => {
    const root = makeRoot({ "pyproject.toml": "[tool.mypy]\n[tool.pyright]\n" });
    const plans = plan(root);
    // Also pins the `candidates` array's initial value: a stray junk entry
    // in it would surface here as an extra, malformed plan (no capability).
    expect(plans).toEqual([{
      id: ".:python:typecheck:ambiguous",
      componentId: ".:python",
      capability: "typecheck",
      ruleIds: ["correctness.types"],
      availability: "not_configured",
      candidates: ["mypy", "pyright"],
      evidence: "equal-authority type checkers require a project tool override",
    }]);
  });

  it("does not claim typecheck when a project tool already claims it, even with both mypy and pyright configured", () => {
    const root = makeRoot({ "pyproject.toml": "[tool.mypy]\n[tool.pyright]\n" });
    const plans = plan(root, "pr", { tools: { typecheck: { argv: ["pyre"] } } });
    expect(plans.filter((p) => p.capability === "typecheck")).toHaveLength(1);
    expect(byCapability(plans, "typecheck").source).toBe("project");
  });
});

describe("configuredPythonPlans — command resolution (uv/poetry/plain)", () => {
  it("runs a configured tool under uv when uv.lock is present", () => {
    const root = makeRoot({ "pyproject.toml": "[tool.ruff]\n", "uv.lock": "" });
    expect(byCapability(plan(root), "lint")).toMatchObject({ executable: "uv", argv: ["run", "ruff", "check", "."] });
  });

  it("runs a configured tool under poetry when poetry.lock is present (and no uv.lock)", () => {
    const root = makeRoot({ "pyproject.toml": "[tool.ruff]\n", "poetry.lock": "" });
    expect(byCapability(plan(root), "lint")).toMatchObject({ executable: "poetry", argv: ["run", "ruff", "check", "."] });
  });

  it("runs a configured tool directly when neither lockfile is present", () => {
    const root = makeRoot({ "pyproject.toml": "[tool.ruff]\n" });
    expect(byCapability(plan(root), "lint")).toMatchObject({ executable: "ruff", argv: ["check", "."] });
  });
});

describe("builtinPytestPlans — declaresPytest detection", () => {
  it("detects pytest.ini", () => {
    const root = makeRoot({ "pytest.ini": "" });
    expect(byCapability(plan(root, "pr"), "test")).toBeDefined();
  });

  it("detects conftest.py", () => {
    const root = makeRoot({ "conftest.py": "" });
    expect(byCapability(plan(root, "pr"), "test")).toBeDefined();
  });

  it("detects [tool.pytest.ini_options] in pyproject.toml", () => {
    const root = makeRoot({ "pyproject.toml": "[tool.pytest.ini_options]\n" });
    expect(byCapability(plan(root, "pr"), "test")).toBeDefined();
  });

  it("detects an indented [pytest] section in tox.ini", () => {
    // A negated character class in the anchoring regex (`[^ \t]*` instead of
    // `[ \t]*`) would reject exactly this: a header preceded by real
    // indentation, which is valid tox.ini/setup.cfg style.
    const root = makeRoot({ "tox.ini": "[tox]\nenvlist = py311\n\n  [pytest]\naddopts = -ra\n" });
    expect(byCapability(plan(root, "pr"), "test")).toBeDefined();
  });

  it("does not treat '[pytest]' appearing mid-line as a real section header", () => {
    // A missing `^` anchor would let `[ \t]*\[pytest\]` match anywhere in
    // the file, not just right after a line start.
    const root = makeRoot({ "tox.ini": "; this text mentions [pytest] in a comment, not a real header\n" });
    expect(byCapability(plan(root, "pr"), "test")).toBeUndefined();
  });

  it("detects an indented [tool:pytest] section in setup.cfg", () => {
    const root = makeRoot({ "setup.cfg": "[metadata]\nname = x\n\n  [tool:pytest]\naddopts = -ra\n" });
    expect(byCapability(plan(root, "pr"), "test")).toBeDefined();
  });

  it("does not treat '[tool:pytest]' appearing mid-line in setup.cfg as a real section header", () => {
    const root = makeRoot({ "setup.cfg": "# see [tool:pytest] for config\n" });
    expect(byCapability(plan(root, "pr"), "test")).toBeUndefined();
  });

  it("does not plan a test when none of the pytest markers are present", () => {
    const root = makeRoot({ "pyproject.toml": "[tool.ruff]\n" });
    expect(byCapability(plan(root, "pr"), "test")).toBeUndefined();
  });
});

describe("builtinPytestPlans — declaresPytestCov detection", () => {
  it("finds pytest-cov declared only in requirements.txt", () => {
    const root = makeRoot({ "pytest.ini": "", "requirements.txt": "pytest-cov==4.0.0\n" });
    expect(byCapability(plan(root, "pr"), "coverage")).toBeDefined();
  });

  it("finds pytest-cov declared only in requirements-dev.txt", () => {
    const root = makeRoot({ "pytest.ini": "", "requirements-dev.txt": "pytest-cov\n" });
    expect(byCapability(plan(root, "pr"), "coverage")).toBeDefined();
  });

  it("finds pytest-cov declared only in setup.cfg", () => {
    const root = makeRoot({ "pytest.ini": "", "setup.cfg": "[options]\ninstall_requires =\n    pytest-cov\n" });
    expect(byCapability(plan(root, "pr"), "coverage")).toBeDefined();
  });

  it("does not plan coverage when pytest-cov is not declared anywhere, even with pytest configured", () => {
    const root = makeRoot({ "pytest.ini": "" });
    expect(byCapability(plan(root, "pr"), "coverage")).toBeUndefined();
  });
});

describe("builtinPytestPlans — plan construction and shape", () => {
  it("plans a test with the full expected shape when pytest is configured", () => {
    const root = makeRoot({ "pytest.ini": "" });
    expect(byCapability(plan(root, "pr"), "test")).toMatchObject({
      id: ".:python:test:pytest",
      capability: "test",
      executable: "pytest",
      argv: [],
      availability: "candidate",
      source: "built-in",
      requiresTrust: true,
    });
  });

  it("plans coverage with the --cov flags and the coveragepy-json report descriptor", () => {
    const root = makeRoot({ "pytest.ini": "", "requirements.txt": "pytest-cov\n" });
    expect(byCapability(plan(root, "pr"), "coverage")).toMatchObject({
      id: ".:python:coverage:pytest",
      capability: "coverage",
      argv: ["--cov", "--cov-report=json:.dotbabel/quality/coveragepy.json"],
      report: { format: "coveragepy-json", path: ".dotbabel/quality/coveragepy.json" },
    });
  });

  it("does not add a second test plan when a project tool already claims test", () => {
    const root = makeRoot({ "pytest.ini": "" });
    const plans = plan(root, "pr", { tools: { test: { argv: ["tox"] } } });
    expect(plans.filter((p) => p.capability === "test")).toHaveLength(1);
    expect(byCapability(plans, "test").source).toBe("project");
  });

  it("does not add a second coverage plan when a project tool already claims coverage", () => {
    const root = makeRoot({ "pytest.ini": "", "requirements.txt": "pytest-cov\n" });
    const plans = plan(root, "pr", { tools: { coverage: { argv: ["coverage", "run"] } } });
    expect(plans.filter((p) => p.capability === "coverage")).toHaveLength(1);
    expect(byCapability(plans, "coverage").source).toBe("project");
  });

  it("returns only well-formed plan objects, never a bare initial-array placeholder", () => {
    const root = makeRoot({ "pytest.ini": "", "requirements.txt": "pytest-cov\n" });
    const plans = plan(root, "pr");
    expect(plans.every((p) => typeof p === "object" && p !== null && "capability" in p)).toBe(true);
    expect(plans).toHaveLength(2); // exactly test + coverage, no stray extra entry
  });

  it("keeps test and coverage out of the fast profile without includeTests", () => {
    const root = makeRoot({ "pytest.ini": "", "requirements.txt": "pytest-cov\n" });
    const plans = plan(root, "fast");
    expect(plans.some((p) => p.capability === "test")).toBe(false);
    expect(plans.some((p) => p.capability === "coverage")).toBe(false);
  });
});

describe("plan() — includeTests derivation from changeSet.criticalMatches", () => {
  it("does not escalate test into the fast profile when criticalMatches is empty", () => {
    const root = makeRoot({ "pytest.ini": "" });
    const plans = plan(root, "fast", {}, { changedFiles: [], criticalMatches: [] });
    expect(byCapability(plans, "test")).toBeUndefined();
  });

  it("escalates test into the fast profile when criticalMatches is non-empty", () => {
    const root = makeRoot({ "pytest.ini": "" });
    const plans = plan(root, "fast", {}, { changedFiles: [], criticalMatches: ["src/critical.py"] });
    expect(byCapability(plans, "test")).toBeDefined();
  });

  it("treats a changeSet with no criticalMatches key at all as empty, not as escalating", () => {
    const root = makeRoot({ "pytest.ini": "" });
    const plans = plan(root, "fast", {}, { changedFiles: [] });
    expect(byCapability(plans, "test")).toBeUndefined();
  });
});

describe("plan() — claimed-capability accumulation across contributors", () => {
  it("does not double-plan coverage when a project tool claims it and a Makefile quality-coverage target also exists", () => {
    const root = makeRoot({});
    fs.writeFileSync(path.join(root, "Makefile"), "quality-coverage:\n\tcov-tool run\n");
    const plans = plan(root, "pr", { markers: [], tools: { coverage: { argv: ["cov-tool", "run"] } } });
    expect(plans.filter((p) => p.capability === "coverage")).toHaveLength(1);
    expect(byCapability(plans, "coverage").source).toBe("project");
  });

  it("does not double-plan lint when a Makefile quality-lint target claims it and ruff is also configured", () => {
    const root = makeRoot({ "pyproject.toml": "[tool.ruff]\n" });
    fs.writeFileSync(path.join(root, "Makefile"), "quality-lint:\n\truff check .\n");
    const plans = plan(root, "pr", { markers: ["pyproject.toml"] });
    expect(plans.filter((p) => p.capability === "lint")).toHaveLength(1);
    expect(byCapability(plans, "lint").source).toBe("repository-target");
  });
});
