import fs from "node:fs";
import path from "node:path";

import { capabilityInProfile, capabilityRules } from "./shared.mjs";

const CONVENTIONAL = Object.freeze({
  format: ["format:check"],
  typecheck: ["typecheck", "check:types"],
  lint: ["lint"],
  test: ["test"],
});

function manager(root) {
  if (fs.existsSync(path.join(root, "pnpm-lock.yaml"))) return "pnpm";
  if (fs.existsSync(path.join(root, "yarn.lock"))) return "yarn";
  return "npm";
}

function readScripts(root) {
  try { return JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).scripts ?? {}; }
  catch { return {}; }
}

/** Select repository-owned Node scripts without executing package metadata. */
export function nodeRepositoryPlans(component, profile, claimed = new Set()) {
  const root = component.absoluteRoot;
  const scripts = readScripts(root);
  const executable = manager(root);
  const plans = [];
  for (const capability of ["format", "typecheck", "lint", "test", "coverage", "complexity", "mutation", "dead-code", "dependencies", "duplication", "security"]) {
    if (claimed.has(capability) || !capabilityInProfile(capability, profile)) continue;
    const qualityCandidates = [`quality:${capability}`, `quality-${capability}`].filter((name) => scripts[name] !== undefined);
    const candidates = qualityCandidates.length > 0 ? qualityCandidates : (CONVENTIONAL[capability] ?? []).filter((name) => scripts[name] !== undefined);
    if (candidates.length === 0) continue;
    if (candidates.length > 1) {
      plans.push({ id: `${component.id}:${capability}:ambiguous`, componentId: component.id, capability, ruleIds: capabilityRules(capability), availability: "not_configured", candidates, evidence: "equal-authority package scripts require a project tool override" });
      continue;
    }
    plans.push({ id: `${component.id}:${capability}:${candidates[0]}`, componentId: component.id, capability, ruleIds: capabilityRules(capability), executable, argv: ["run", candidates[0]], cwd: root, availability: "available", source: "repository-script", requiresTrust: true });
  }
  return plans;
}
