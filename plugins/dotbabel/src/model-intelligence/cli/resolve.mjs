/** Read-only CLI orchestration. The shared resolver receives only already-loaded data. */
import { openSync, closeSync, fstatSync, readSync, constants } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { parseFrontmatter } from "../../build-index.mjs";
import { parseComputeDeclaration } from "../requirement/index.mjs";
import { interpretLegacy, detectDualDeclarationConflict } from "../compat/index.mjs";
import { loadPolicyLayers, mergePolicy } from "../policy/index.mjs";
import { SOURCE_ADAPTERS } from "../sources/index.mjs";
import { loadCatalog } from "../catalog/index.mjs";
import { resolve } from "../resolver/index.mjs";

/** @param {string} status @param {string} code @returns {object} */
function failed(status, code) {
  return { status, enforcement: { state: status === "conflict" ? "unsatisfied" : "unknown", basis: "none" }, confidence: "low", explanation: [], diagnostics: [{ code, message: code }] };
}

/** Read only a bounded regular artifact; descriptor reads also bound concurrent growth.
 * @param {string} file
 * @returns {string}
 */
function readArtifact(file) {
  const maxBytes = 1024 * 1024;
  const fd = openSync(file, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > maxBytes) throw new Error("artifact_unavailable");
    const buffer = Buffer.alloc(maxBytes + 1);
    let length = 0;
    while (length < buffer.length) {
      const count = readSync(fd, buffer, length, buffer.length - length, null);
      if (!count) break;
      length += count;
    }
    if (length > maxBytes) throw new Error("artifact_unavailable");
    return buffer.toString("utf8", 0, length);
  } finally { closeSync(fd); }
}

/**
 * Resolve an explicit diagnostic request without discovery, observation, or mutation.
 * @param {{repoRoot: string, runtimeId: string, artifactKind: string, workloadClass?: string, artifactPath?: string}} options
 * @returns {{result: object, exitCode: number, context?: object}}
 */
export function resolveRequest({ repoRoot, runtimeId, artifactKind, workloadClass, artifactPath }) {
  let requirement;
  if (artifactPath !== undefined) {
    const sourcePath = resolvePath(repoRoot, artifactPath);
    let text;
    try { text = readArtifact(sourcePath); }
    catch { return { result: failed("unresolved", "artifact_unavailable"), exitCode: 2 }; }
    const parsed = parseFrontmatter(text);
    if (text.startsWith("---") && parsed.warnings.length) return { result: failed("invalid", "invalid_artifact_frontmatter"), exitCode: 1 };
    const canonical = parseComputeDeclaration(parsed.frontmatter, { sourcePath });
    if (canonical.errors.length) return { result: failed("invalid", "MI_COMPUTE_INVALID"), exitCode: 1 };
    const legacy = interpretLegacy(parsed.frontmatter, { sourcePath, artifactKind });
    if (detectDualDeclarationConflict(canonical.requirement, legacy)) return { result: failed("conflict", "MI_DUAL_DECLARATION_CONFLICT"), exitCode: 1 };
    if (!canonical.declared && legacy.disposition === "ambiguous") return { result: failed("unresolved", "legacy_requirement_ambiguous"), exitCode: 1 };
    requirement = canonical.requirement ?? legacy.requirement ?? undefined;
  } else {
    requirement = { requirement: workloadClass, mode: "dynamic", binding: "consumer", provenance: { sourceId: "explicit-cli-requirement", sourceKind: "artifact", derivation: "declared" } };
  }
  let policy;
  try {
    const { shipped, user, project } = loadPolicyLayers({ repoRoot });
    policy = mergePolicy({ shipped, user, project });
  } catch { return { result: failed("invalid", "invalid_model_intelligence_policy"), exitCode: 1 }; }
  const adapter = SOURCE_ADAPTERS.find(module => module.descriptor.kind === "runtime" && module.descriptor.id === runtimeId);
  if (!adapter) return { result: failed("unresolved", "runtime_adapter_unavailable"), exitCode: 2 };
  const catalog = loadCatalog({ sources: SOURCE_ADAPTERS.map(module => ({ module })), now: new Date().toISOString() });
  const target = { runtimeId, artifactKind };
  const result = resolve({ requirement, policy, catalog, target, runtimeContract: adapter.descriptor });
  const localEvidence = catalog.runtimes.find(runtime => runtime.runtimeId === runtimeId)?.models.length > 0;
  const exitCode = result.status === "resolved" ? 0 : result.status === "unresolved" && !localEvidence ? 2 : 1;
  return { result, exitCode, context: { requirement, floor: policy.floor, pin: policy.pin, target } };
}
