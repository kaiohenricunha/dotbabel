import fs from "node:fs";
import path from "node:path";
import { capabilityInProfile, capabilityRules } from "./shared.mjs";
import { makeRepositoryPlans } from "./make-tools.mjs";

function has(root, name) { return fs.existsSync(path.join(root, name)); }

function pythonCommand(root, executable, args) {
  if (has(root, "uv.lock")) return { executable: "uv", argv: ["run", executable, ...args] };
  if (has(root, "poetry.lock")) return { executable: "poetry", argv: ["run", executable, ...args] };
  return { executable, argv: args };
}

function configuredPythonPlans(component, profile, claimed) {
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
  return candidates.filter((item) => capabilityInProfile(item.capability, profile)).map(toPlan);

  function toPlan(item) {
    const command = pythonCommand(component.absoluteRoot, item.tool, item.args);
    return { id: `${component.id}:${item.capability}:${item.tool}`, componentId: component.id, capability: item.capability, ruleIds: capabilityRules(item.capability), ...command, cwd: component.absoluteRoot, availability: "candidate", source: "configured", requiresTrust: true };
  }
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
  plan(component, _policy, _changeSet, profile) {
    const plans = Object.entries(component.tools ?? {}).filter(([capability]) => capabilityInProfile(capability, profile)).map(([capability, tool]) => ({ id: `${component.id}:${capability}`, componentId: component.id, capability, ruleIds: capabilityRules(capability), executable: tool.argv[0], argv: tool.argv.slice(1), cwd: component.absoluteRoot, timeoutSeconds: tool.timeout_seconds, report: tool.report, availability: "available", source: "project", requiresTrust: true }));
    const claimed = new Set(plans.map((plan) => plan.capability));
    const absoluteRoot = component.absoluteRoot ?? path.resolve(component.root);
    component.absoluteRoot = absoluteRoot;
    plans.push(...makeRepositoryPlans(component, profile, claimed));
    for (const plan of plans) claimed.add(plan.capability);
    plans.push(...configuredPythonPlans(component, profile, claimed));
    return plans;
  },
});
