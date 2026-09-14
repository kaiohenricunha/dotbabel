import fs from "node:fs";
import path from "node:path";

import { capabilityInProfile, capabilityRules } from "./shared.mjs";

const CONVENTIONAL = Object.freeze({
  format: ["format-check"],
  lint: ["lint"],
  test: ["test"],
  coverage: ["coverage"],
  security: ["security"],
  race: ["test-race", "race"],
});

function targets(root) {
  const file = path.join(root, "Makefile");
  if (!fs.existsSync(file)) return new Set();
  return new Set([...fs.readFileSync(file, "utf8").matchAll(/^([A-Za-z0-9_.-]+)\s*:(?![=])/gm)].map((match) => match[1]));
}

/**
 * Select repository-owned Make targets without reading recipe commands.
 *
 * An unowned component -- inferred from stray source files, with neither a
 * manifest nor an operator declaration -- may claim only the `quality-*`
 * namespace. The CONVENTIONAL names are ambient: `lint` in a polyglot repo
 * belongs to whichever language wrote it, and matching by name would run that
 * toolchain under the wrong component (#337). `quality-lint` cannot collide by
 * accident, so it stays available. Skipping beats emitting a `not_configured`
 * plan, which would resolve through `on_unavailable` and fail the hard rules
 * where no plan at all is informational.
 */
export function makeRepositoryPlans(component, profile, claimed = new Set(), includeTests = false) {
  const unowned = (component.markers ?? []).length === 0 && !component.configured;
  const available = targets(component.absoluteRoot);
  const plans = [];
  for (const capability of ["format", "compile", "typecheck", "lint", "test", "regression", "coverage", "complexity", "mutation", "dead-code", "dependencies", "duplication", "security", "race"]) {
    if (claimed.has(capability) || !capabilityInProfile(capability, profile, includeTests)) continue;
    const preferred = `quality-${capability}`;
    const conventional = unowned ? [] : (CONVENTIONAL[capability] ?? []).filter((name) => available.has(name));
    const candidates = available.has(preferred) ? [preferred] : conventional;
    if (candidates.length === 0) continue;
    if (candidates.length > 1) {
      plans.push({ id: `${component.id}:${capability}:ambiguous-make`, componentId: component.id, capability, ruleIds: capabilityRules(capability), availability: "not_configured", candidates, evidence: "equal-authority Make targets require a project tool override" });
      continue;
    }
    plans.push({ id: `${component.id}:${capability}:${candidates[0]}`, componentId: component.id, capability, ruleIds: capabilityRules(capability), executable: "make", argv: [candidates[0]], cwd: component.absoluteRoot, availability: "available", source: "repository-target", requiresTrust: true });
  }
  return plans;
}
