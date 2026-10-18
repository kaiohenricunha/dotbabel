/** Evidence-backed compatibility of a retained native selector and authored semantic intent. */
import { parseComputeDeclaration } from "../requirement/index.mjs";
import { interpretLegacy, detectDualDeclarationConflict } from "./index.mjs";
import { resolve } from "../resolver/index.mjs";
import { isArtifactSourcePath } from "../policy/scopes.mjs";

/**
 * Prove compatibility through the public resolver without ranking model names or changing axes.
 * The caller supplies accepted evidence and policy. This says nothing about live entitlement.
 * Missing, weak or unsatisfied evidence never overrides the conservative legacy conflict.
 * @param {object} declared Parsed canonical declaration.
 * @param {object} reading Existing interpreted legacy metadata.
 * @param {object} context Caller-loaded catalog, policy, Claude contract, canonical path and kind.
 * @returns {boolean} Whether the exact retained native configuration satisfies every constraint.
 */
export function legacySatisfiesDeclaration(declared, reading, context) {
  if (!context || !isArtifactSourcePath(context.sourcePath) || typeof reading?.legacy?.model !== "string" || reading.legacy.model === "inherit") return false;
  const artifactKind = context.artifactKind ?? (declared?.binding === "self" ? "agent" : declared?.binding === "session" ? "command" : "skill");
  const axes = { model: reading.legacy.model, ...(artifactKind === "agent" && reading.legacy.effort !== undefined ? { reasoning: reading.legacy.effort } : {}) };
  if (declared?.mode === "pin" && (declared.pin?.runtime !== "claude" || Object.entries(declared.pin.config).some(([axis, value]) => axes[axis] !== value))) return false;
  const target = { runtimeId: "claude", artifactKind, ...(isArtifactSourcePath(context.sourcePath) ? { sourcePath: context.sourcePath } : {}) };
  const result = resolve({ requirement: declared, target, catalog: context.catalog, policy: context.policy, runtimeContract: context.runtimeContract, invocation: { pin: { runtime: "claude", config: axes }, omitDefaultReasoning: true } });
  return result.status === "resolved" && result.confidence === "high" && result.enforcement.state !== "unsatisfied" && Object.entries(axes).every(([axis, value]) => result.configuration.axes[axis] === value);
}


/**
 * Compute proof paths for a migration report without changing or selecting replacement metadata.
 * @param {object[]} inputs Parsed canonical migration inventory.
 * @param {object} context Caller-loaded evidence and policy.
 * @returns {Set<string>} Exact paths verified through the same public resolver.
 */
export function compatibleMigrationPaths(inputs, context) {
  return new Set(inputs.filter(input => {
    const declared = parseComputeDeclaration(input.frontmatter, { sourcePath: input.sourcePath });
    const reading = interpretLegacy(input.frontmatter, input);
    return declared.errors.length === 0 && detectDualDeclarationConflict(declared.requirement, reading) !== null && legacySatisfiesDeclaration(declared.requirement, reading, { ...context, sourcePath: input.sourcePath, artifactKind: input.artifactKind });
  }).map(input => input.sourcePath));
}
