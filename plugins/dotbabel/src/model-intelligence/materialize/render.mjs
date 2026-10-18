/** Pure allowlisted YAML-frontmatter rendering; adapters supply native field contracts. */
import yaml from "js-yaml";
import { parseFrontmatter } from "../../build-index.mjs";
import { checkOpaqueValue } from "../domain/index.mjs";
import { parseComputeDeclaration } from "../requirement/index.mjs";

/**
 * Render one canonical artifact without leaking private metadata or claiming native execution.
 * @param {object} artifact Canonical source, resolved configuration and explicit emission contract.
 * @param {string} projectionId Deterministic derivation identity.
 * @returns {string} Generated runtime bytes, preserving the canonical body.
 */
export function renderProjection(artifact, projectionId) {
  const { frontmatter, body, warnings } = parseFrontmatter(artifact.sourceContent);
  if (warnings.some(warning => !warning.startsWith("no YAML frontmatter"))) throw new TypeError("invalid projection source frontmatter");
  if (parseComputeDeclaration(frontmatter, { sourcePath: artifact.sourcePath }).errors.length) throw new TypeError("invalid canonical compute declaration");
  const contract = artifact.projectionContract;
  if (!contract || !Array.isArray(contract.frontmatterKeys) || contract.frontmatterKeys.some(key => typeof key !== "string" || !/^[A-Za-z][A-Za-z0-9_.-]*$/.test(key) || ["constructor", "prototype"].includes(key))) throw new TypeError("invalid projection metadata contract");
  if (contract.permitsCompute === true && (typeof contract.computeConsumer !== "string" || contract.computeConsumer.trim() === "")) throw new TypeError("private compute metadata needs an explicit consumer");
  const mappings = Object.entries(contract.axisKeys ?? {});
  if (mappings.some(([axis, key]) => !["model", "reasoning"].includes(axis) || typeof key !== "string") || new Set(mappings.map(([, key]) => key)).size !== mappings.length) throw new TypeError("invalid projection axis mapping");
  const metadata = Object.fromEntries(contract.frontmatterKeys.filter(key => Object.hasOwn(frontmatter, key) && (key !== "dotbabel" || contract.permitsCompute === true)).map(key => [key, structuredClone(frontmatter[key])]));
  const binding = (artifact.runtimeContract.capabilities ?? artifact.runtimeContract).binding?.[artifact.target.artifactKind];
  const bound = artifact.resolverResult.enforcement?.state === "enforced" && artifact.resolverResult.enforcement.basis === "artifact-binding";
  for (const [axis, key] of mappings) {
    delete metadata[key];
    const value = artifact.resolverResult.configuration?.axes?.[axis];
    if (value !== undefined && (typeof value !== "string" || !checkOpaqueValue(axis, value))) throw new TypeError("invalid resolved projection axis");
    if (bound && value !== undefined && binding?.support === "supported" && binding.axes?.[axis] === "supported" && contract.frontmatterKeys.includes(key)) metadata[key] = value;
  }
  const header = yaml.dump(metadata, { sortKeys: true, noRefs: true, lineWidth: -1, quotingType: '"', forceQuotes: false });
  return `---\n# dotbabel:generated projection=${projectionId} source=${artifact.sourcePath} — do not edit directly\n${header}---\n${body}`;
}
