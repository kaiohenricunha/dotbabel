import path from "node:path";
import { projectToolPlans } from "./shared.mjs";
import { nodeRepositoryPlans } from "./node-tools.mjs";

/** Built-in JavaScript quality adapter. */
export const javascriptAdapter = Object.freeze({
  id: "javascript",
  languages: ["javascript"],
  discover({ files }) {
    const packageMarkers = files.filter((file) => path.basename(file) === "package.json");
    const tsMarkers = files.filter((file) => /^tsconfig.*\.json$/.test(path.basename(file))).filter((marker) => {
      const root = path.dirname(marker) === "." ? "." : path.dirname(marker);
      return files.some((file) => /\.[cm]?js$/.test(file) && (root === "." || file.startsWith(`${root}/`)));
    });
    const markers = [...new Set([...packageMarkers, ...tsMarkers])];
    if (markers.length) return markers.map((marker) => ({ root: path.dirname(marker) === "." ? "." : path.dirname(marker), language: "javascript", markers: [marker] }));
    return files.some((file) => /\.[cm]?js$/.test(file)) ? [{ root: ".", language: "javascript", markers: [] }] : [];
  },
  plan(component, _policy, changeSet, profile) {
    const plans = projectToolPlans(component, profile);
    plans.push(...nodeRepositoryPlans(component, profile, new Set(plans.map((plan) => plan.capability))));
    const changed = changeSet.changedFiles.map((item) => item.path).filter((file) => /\.[cm]?js$/.test(file) && component.files.includes(file));
    for (const file of changed) plans.push({ id: `${component.id}:node-check:${file}`, componentId: component.id, capability: "compile", ruleIds: ["correctness.compile"], executable: "node", argv: ["--check", path.relative(component.root, file)], cwd: component.absoluteRoot, availability: "available", source: "built-in", requiresTrust: false });
    return plans;
  },
});
