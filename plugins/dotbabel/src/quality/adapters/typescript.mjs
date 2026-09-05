import fs from "node:fs";
import path from "node:path";
import { capabilityInProfile, capabilityRules } from "./shared.mjs";
import { nodeRepositoryPlans } from "./node-tools.mjs";

/** Built-in TypeScript quality adapter. */
export const typescriptAdapter = Object.freeze({
  id: "typescript",
  languages: ["typescript"],
  discover({ files }) {
    return files.filter((file) => /^tsconfig.*\.json$/.test(path.basename(file))).map((marker) => ({ root: path.dirname(marker) === "." ? "." : path.dirname(marker), language: "typescript", markers: [marker] }));
  },
  plan(component, _policy, _changeSet, profile) {
    const plans = Object.entries(component.tools ?? {}).filter(([capability]) => capabilityInProfile(capability, profile)).map(([capability, tool]) => ({ id: `${component.id}:${capability}`, componentId: component.id, capability, ruleIds: capabilityRules(capability), executable: tool.argv[0], argv: tool.argv.slice(1), cwd: component.absoluteRoot, timeoutSeconds: tool.timeout_seconds, report: tool.report, availability: "available", source: "project", requiresTrust: true }));
    plans.push(...nodeRepositoryPlans(component, profile, new Set(plans.map((plan) => plan.capability))));
    for (const plan of plans.filter((item) => item.capability === "typecheck")) plan.ruleIds = ["correctness.compile", "correctness.types"];
    if (!plans.some((plan) => plan.capability === "typecheck")) {
      const local = "./node_modules/.bin/tsc";
      plans.push({ id: `${component.id}:tsc`, componentId: component.id, capability: "typecheck", ruleIds: ["correctness.compile", "correctness.types"], executable: fs.existsSync(path.join(component.absoluteRoot, "node_modules", ".bin", "tsc")) ? local : "tsc", argv: ["--noEmit", "-p", path.basename(component.markers[0] ?? "tsconfig.json")], cwd: component.absoluteRoot, availability: "candidate", source: "configured", requiresTrust: true });
    }
    return plans;
  },
});
