import fs from "node:fs";
import path from "node:path";
import { capabilityInProfile, capabilityRules, projectToolPlans } from "./shared.mjs";
import { makeRepositoryPlans } from "./make-tools.mjs";

function has(root, name) { return fs.existsSync(path.join(root, name)); }

function pythonCommand(root, executable, args) {
  if (has(root, "uv.lock")) return { executable: "uv", argv: ["run", executable, ...args] };
  if (has(root, "poetry.lock")) return { executable: "poetry", argv: ["run", executable, ...args] };
  return { executable, argv: args };
}

function configuredPythonPlans(component, profile, claimed, includeTests = false) {
  let text = "";
  try { text = fs.readFileSync(path.join(component.absoluteRoot, "pyproject.toml"), "utf8"); } catch { return []; }
  const candidates = [];
  if (!claimed.has("lint") && /\[tool\.ruff(?:\.|\])/.test(text)) candidates.push({ capability: "lint", tool: "ruff", args: ["check", "."] });
  if (!claimed.has("format")) {
    if (/\[tool\.black\]/.test(text)) candidates.push({ capability: "format", tool: "black", args: ["--check", "."] });
    else if (/\[tool\.ruff(?:\.|\])/.test(text)) candidates.push({ capability: "format", tool: "ruff", args: ["format", "--check", "."] });
  }
  if (!claimed.has("typecheck")) {
    const typeTools = [["mypy", /\[tool\.mypy\]/], ["pyright", /\[tool\.pyright\]/]].filter(([, expression]) => expression.test(text));
    if (typeTools.length > 1) return [...candidates.map(toPlan), { id: `${component.id}:typecheck:ambiguous`, componentId: component.id, capability: "typecheck", ruleIds: ["correctness.types"], availability: "not_configured", candidates: typeTools.map(([name]) => name), evidence: "equal-authority type checkers require a project tool override" }];
    if (typeTools.length === 1) candidates.push({ capability: "typecheck", tool: typeTools[0][0], args: ["."] });
  }
  return candidates.filter((item) => capabilityInProfile(item.capability, profile, includeTests)).map(toPlan);

  function toPlan(item) {
    const command = pythonCommand(component.absoluteRoot, item.tool, item.args);
    return { id: `${component.id}:${item.capability}:${item.tool}`, componentId: component.id, capability: item.capability, ruleIds: capabilityRules(item.capability), ...command, cwd: component.absoluteRoot, availability: "candidate", source: "configured", requiresTrust: true };
  }
}

/** Where a built-in pytest coverage plan writes its report. */
const COVERAGE_REPORT_PATH = ".dotbabel/quality/coveragepy.json";

function read(root, name) {
  try { return fs.readFileSync(path.join(root, name), "utf8"); } catch { return null; }
}

/**
 * True when the component declares pytest configuration (KD-8).
 *
 * Declaration is the gate, not the presence of test files: `dotbabel quality`
 * never installs a checker, so planning pytest for a repository that does not
 * use it produces a plan that can only resolve through `on_unavailable`, which
 * reads as a finding rather than as "nothing to measure here".
 *
 * @param {string} root
 * @returns {boolean}
 */
function declaresPytest(root) {
  if (has(root, "pytest.ini") || has(root, "conftest.py")) return true;
  if (/\[tool\.pytest\.ini_options\]/.test(read(root, "pyproject.toml") ?? "")) return true;
  if (/^\s*\[pytest\]/m.test(read(root, "tox.ini") ?? "")) return true;
  return /^\s*\[tool:pytest\]/m.test(read(root, "setup.cfg") ?? "");
}

/**
 * True when `pytest-cov` is a declared dependency somewhere the component
 * records its dependencies. Without it `--cov` is an unknown option, so the
 * coverage plan would fail rather than report.
 *
 * @param {string} root
 * @returns {boolean}
 */
function declaresPytestCov(root) {
  const sources = [read(root, "pyproject.toml"), read(root, "requirements.txt"), read(root, "requirements-dev.txt"), read(root, "setup.cfg")];
  return sources.some((text) => text !== null && /(?<![\w-])pytest-cov(?![\w-])/.test(text));
}

/**
 * Built-in pytest test and coverage plans, for declared configuration only
 * (KD-8). Runs under `uv run` or `poetry run` when the matching lockfile
 * exists, so the plan uses the environment the repository actually resolves.
 *
 * @param {object} component
 * @param {string} profile
 * @param {Set<string>} claimed Capabilities a higher-priority source already planned.
 * @param {boolean} includeTests
 * @returns {object[]}
 */
function builtinPytestPlans(component, profile, claimed, includeTests) {
  const root = component.absoluteRoot;
  if (!declaresPytest(root)) return [];
  const plans = [];

  const build = (capability, args, report) => {
    const command = pythonCommand(root, "pytest", args);
    return { id: `${component.id}:${capability}:pytest`, componentId: component.id, capability, ruleIds: capabilityRules(capability), ...command, cwd: root, ...(report ? { report } : {}), availability: "available", source: "built-in", requiresTrust: true };
  };

  if (!claimed.has("test") && capabilityInProfile("test", profile, includeTests)) {
    plans.push(build("test", []));
  }
  if (!claimed.has("coverage") && capabilityInProfile("coverage", profile, includeTests) && declaresPytestCov(root)) {
    plans.push(build("coverage", ["--cov", `--cov-report=json:${COVERAGE_REPORT_PATH}`], { format: "coveragepy-json", path: COVERAGE_REPORT_PATH }));
  }
  return plans;
}

/** Built-in Python quality adapter. */
export const pythonAdapter = Object.freeze({
  id: "python",
  languages: ["python"],
  discover({ files }) {
    const markers = files.filter((file) => ["pyproject.toml", "setup.cfg", "tox.ini"].includes(path.basename(file)));
    if (markers.length) return markers.map((marker) => ({ root: path.dirname(marker) === "." ? "." : path.dirname(marker), language: "python", markers: [marker] }));
    return files.some((file) => file.endsWith(".py")) ? [{ root: ".", language: "python", markers: [] }] : [];
  },
  plan(component, _policy, changeSet, profile) {
    const includeTests = (changeSet.criticalMatches ?? []).length > 0;
    const plans = projectToolPlans(component, profile, includeTests);
    const claimed = new Set(plans.map((plan) => plan.capability));
    const absoluteRoot = component.absoluteRoot ?? path.resolve(component.root);
    component.absoluteRoot = absoluteRoot;
    plans.push(...makeRepositoryPlans(component, profile, claimed, includeTests));
    for (const plan of plans) claimed.add(plan.capability);
    plans.push(...configuredPythonPlans(component, profile, claimed, includeTests));
    for (const plan of plans) claimed.add(plan.capability);
    // Last, so a project tool, a Make target, or configured tooling all keep
    // priority over the built-in pytest plans.
    plans.push(...builtinPytestPlans(component, profile, claimed, includeTests));
    return plans;
  },
});
