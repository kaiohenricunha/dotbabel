import fs from "node:fs";
import path from "node:path";
import { makeRepositoryPlans } from "./make-tools.mjs";
import { capabilityInProfile, capabilityRules } from "./shared.mjs";

function explicitPlans(component, profile) {
  return Object.entries(component.tools ?? {}).flatMap(([capability, tool]) => {
    if (!capabilityInProfile(capability, profile)) return [];
    return [{ id: `${component.id}:${capability}`, componentId: component.id, capability, ruleIds: capabilityRules(capability), executable: tool.argv[0], argv: tool.argv.slice(1), cwd: component.absoluteRoot, timeoutSeconds: tool.timeout_seconds, report: tool.report, availability: "available", source: "project", requiresTrust: true }];
  });
}

/** Built-in Go quality adapter. */
export const goAdapter = Object.freeze({
  id: "go",
  languages: ["go"],
  discover({ root, files }) {
    return files.filter((file) => path.basename(file) === "go.mod").map((marker) => ({ root: path.dirname(marker) === "." ? "." : path.dirname(marker), language: "go", markers: [marker] }));
  },
  plan(component, _policy, changeSet, profile) {
    component.absoluteRoot ??= path.resolve(component.root);
    const explicit = explicitPlans(component, profile);
    const claimed = new Set(explicit.map((plan) => plan.capability));
    const changed = changeSet.changedFiles.map((item) => item.path).filter((file) => file.endsWith(".go") && component.files.includes(file));
    const plans = [...explicit, ...makeRepositoryPlans(component, profile, claimed)];
    for (const plan of plans) claimed.add(plan.capability);
    if (changed.length > 0 && !claimed.has("format")) plans.push({ id: `${component.id}:format`, componentId: component.id, capability: "format", ruleIds: ["correctness.format"], executable: "gofmt", argv: ["-l", ...changed.map((file) => path.relative(component.root, file))], cwd: component.absoluteRoot, availability: "available", source: "built-in", requiresTrust: false, stdoutFailure: true });
    if (!claimed.has("compile")) plans.push({ id: `${component.id}:compile`, componentId: component.id, capability: "compile", ruleIds: ["correctness.compile"], executable: "go", argv: ["test", "-run", "^$", "./..."], cwd: component.absoluteRoot, availability: "available", source: "built-in", requiresTrust: true });
    if (!claimed.has("lint")) {
      const golangci = [".golangci.yml", ".golangci.yaml", ".golangci.toml", ".golangci.json"].some((file) => fs.existsSync(path.join(component.absoluteRoot, file)));
      plans.push(golangci
        ? { id: `${component.id}:golangci-lint`, componentId: component.id, capability: "lint", ruleIds: ["correctness.lint"], executable: "golangci-lint", argv: ["run"], cwd: component.absoluteRoot, availability: "candidate", source: "configured", requiresTrust: true }
        : { id: `${component.id}:vet`, componentId: component.id, capability: "lint", ruleIds: ["correctness.lint"], executable: "go", argv: ["vet", "./..."], cwd: component.absoluteRoot, availability: "available", source: "built-in", requiresTrust: true });
    }
    if (profile !== "fast" && !claimed.has("test")) plans.push({ id: `${component.id}:test`, componentId: component.id, capability: "test", ruleIds: ["correctness.compile", "correctness.tests"], executable: "go", argv: ["test", "./..."], cwd: component.absoluteRoot, availability: "available", source: "built-in", requiresTrust: true });
    return plans;
  },
});
