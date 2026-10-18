/** Explicit projection plans connect runtime planners to existing project fan-out. */
import fs from "node:fs";
import path from "node:path";
import { materialize } from "./index.mjs";
import { inspectProjectionTree, syncProjectionTree } from "./transaction.mjs";
import { isProjectionPath, openProjectionTree } from "./projection-fs.mjs";

/**
 * Apply or inspect caller-supplied canonical plans; no automatic discovery or configuration opt-in.
 * Runtime-specific planners own activation, cached resolver inputs and verified adapter contracts.
 * @param {{repoRoot:string, projectionTrees?:object[], dryRun?:boolean, check?:boolean, allowArtifact?:Function}} options Explicit local plans only.
 * @returns {Promise<{targets:Set<string>, entries:object[], generated:number}>} Destinations protected from legacy symlink fan-out.
 */
export async function projectProjectionTrees({ repoRoot, projectionTrees = [], dryRun = false, check = false, allowArtifact = () => true }) {
  if (!Array.isArray(projectionTrees)) throw new Error("projection_plan_invalid");
  const plans = projectionTrees.map(tree => {
    if (typeof tree?.root !== "string" || typeof tree.loadInputs !== "function") throw new Error("projection_plan_invalid");
    const relative = path.relative(path.resolve(repoRoot), path.resolve(tree.root));
    if (!isProjectionPath(relative)) throw new Error("projection_path_unsafe");
    return { root: path.resolve(tree.root), relative, loadInputs: async () => {
      const inputs = await tree.loadInputs();
      return { ...inputs, artifacts: inputs.artifacts.filter(allowArtifact) };
    } };
  });
  const roots = plans.map(plan => plan.root).sort();
  if (roots.some((root, index) => roots.slice(index + 1).some(other => other === root || other.startsWith(root + path.sep)))) throw new Error("projection_plan_overlap");
  const targets = new Set(); const entries = []; let generated = 0;
  for (const plan of plans) {
    let result;
    if (dryRun || check && !fs.existsSync(plan.root)) {
      const batch = materialize(await plan.loadInputs());
      result = { manifest: batch.manifest, entries: batch.files.map(file => ({ path: file.path, state: "missing" })) };
    } else if (check) result = await inspectProjectionTree(plan);
    else {
      const owner = openProjectionTree(repoRoot);
      try { owner.ensureDirectory(plan.relative); } finally { owner.close(); }
      result = await syncProjectionTree(plan);
    }
    if (["busy", "incomplete"].includes(result.status)) throw new Error("projection_" + result.status);
    for (const target of Object.keys(result.manifest.entries)) targets.add(path.join(plan.root, target));
    entries.push(...result.entries.map(entry => ({ ...entry, path: path.relative(repoRoot, path.join(plan.root, entry.path)) })));
    generated += Object.keys(result.manifest.entries).length;
  }
  return { targets, entries, generated };
}
