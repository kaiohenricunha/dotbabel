/** Read-only installed workflow provenance; no execution or release adoption is inferred. */
import fs from "node:fs";
import path from "node:path";
import { openProjectionTree } from "../projection-fs.mjs";
import { validateProjectionBatch } from "../transaction.mjs";
const fail = code => Object.assign(new Error(code), { code });
const present = file => { try { fs.lstatSync(file); return true; } catch (error) { if (error.code === "ENOENT") return false; throw error; } };

/**
 * Inspect one generated workflow and compare its immutable output with a shipped baseline.
 * @param {string} root Packaged workflow root or consumer .github/workflows directory.
 * @param {object} [shipped] Previously inspected package baseline, without filesystem authority.
 * @returns {object} Projection provenance, an honest absence, or a bounded diagnostic.
 */
export function inspectWorkflowProjection(root, shipped) {
  let tree;
  try {
    if (!present(path.join(root, ".dotbabel-projection.pending.json")) && !present(path.join(root, ".dotbabel-projection.json"))) return { status: "absent", configurationBasis: "projection" };
    tree = openProjectionTree(root);
    let manifest; try { manifest = JSON.parse(tree.read(".dotbabel-projection.json")); } catch { throw fail("workflow_projection_invalid"); }
    if (tree.read(".dotbabel-projection.pending.json") !== null || !manifest?.entries || Object.keys(manifest.entries).length !== 1) throw fail("workflow_projection_invalid");
    const entry = manifest.entries["ai-review.yml"];
    if (entry?.runtimeId !== "claude" || entry.artifactKind !== "workflow" || typeof entry.snapshotId !== "string" || !/^sha256:[a-f0-9]{64}$/.test(entry.snapshotId)) throw fail("workflow_projection_invalid");
    validateProjectionBatch({ manifest, files: [{ path: "ai-review.yml", content: tree.read("ai-review.yml") }] });
    return { status: "present", configurationBasis: "projection", toolVersion: manifest.toolVersion, snapshotId: entry.snapshotId, outputHash: entry.outputHash, matchesShipped: shipped?.status === "present" ? shipped.outputHash === entry.outputHash && shipped.snapshotId === entry.snapshotId : null };
  } catch (error) { return { status: "unavailable", configurationBasis: "projection", reason: error.code ?? "workflow_projection_invalid" }; }
  finally { tree?.close(); }
}
