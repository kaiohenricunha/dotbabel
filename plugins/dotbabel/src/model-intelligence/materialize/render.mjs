/** Pure allowlisted YAML-frontmatter rendering; adapters supply native field contracts. */
import yaml from "js-yaml";
import { parseFrontmatter } from "../../build-index.mjs";
import { checkOpaqueValue } from "../domain/index.mjs";
import { parseComputeDeclaration } from "../requirement/index.mjs";

/**
 * Parse canonical source once through the shared YAML and requirement boundaries.
 * @param {object} artifact Source content and canonical path.
 * @returns {object} Parsed metadata, body and normalized authored requirement.
 */
export function parseProjectionSource(artifact) {
  const { frontmatter, body, warnings } = parseFrontmatter(artifact.sourceContent);
  if (warnings.some(warning => !warning.startsWith("no YAML frontmatter"))) throw new TypeError("invalid projection source frontmatter");
  const parsed = parseComputeDeclaration(frontmatter, { sourcePath: artifact.sourcePath });
  if (parsed.errors.length) throw new TypeError("invalid canonical compute declaration");
  return { frontmatter, body, requirement: parsed.requirement };
}

/**
 * Render one canonical artifact without leaking private metadata or claiming native execution.
 * @param {object} artifact Canonical source, resolved configuration and explicit emission contract.
 * @param {string} projectionId Deterministic derivation identity.
 * @param {object} source Already parsed canonical data, shared with identity validation.
 * @returns {string} Generated runtime bytes, preserving the canonical body.
 */
export function renderProjection(artifact, projectionId, source) {
  const { frontmatter, body } = source;
  const contract = artifact.projectionContract;
  if (!contract || !Array.isArray(contract.frontmatterKeys) || contract.frontmatterKeys.some(key => typeof key !== "string" || !/^[A-Za-z][A-Za-z0-9_.-]*$/.test(key) || ["constructor", "prototype"].includes(key))) throw new TypeError("invalid projection metadata contract");
  if (contract.permitsCompute === true && (typeof contract.computeConsumer !== "string" || contract.computeConsumer.trim() === "")) throw new TypeError("private compute metadata needs an explicit consumer");
  const mappings = Object.entries(contract.axisKeys ?? {});
  if (mappings.some(([axis, key]) => !["model", "reasoning"].includes(axis) || typeof key !== "string") || new Set(mappings.map(([, key]) => key)).size !== mappings.length) throw new TypeError("invalid projection axis mapping");
  const metadata = Object.fromEntries(contract.frontmatterKeys.filter(key => Object.hasOwn(frontmatter, key) && (key !== "dotbabel" || contract.permitsCompute === true)).map(key => [key, structuredClone(key === "dotbabel" ? { compute: frontmatter.dotbabel.compute } : frontmatter[key])]));
  const binding = (artifact.runtimeContract.capabilities ?? artifact.runtimeContract).binding?.[artifact.target.artifactKind];
  const bound = artifact.resolverResult.enforcement?.state === "enforced" && artifact.resolverResult.enforcement.basis === "artifact-binding";
  for (const [axis, key] of mappings) {
    delete metadata[key];
    const value = artifact.resolverResult.configuration?.axes?.[axis];
    if (value !== undefined && (typeof value !== "string" || !checkOpaqueValue(axis, value))) throw new TypeError("invalid resolved projection axis");
    const explicitPin = contract.allowExplicitPinAxes === true && source.requirement?.mode === "pin" && ["self", "session"].includes(source.requirement.binding) && source.requirement.pin.runtime === artifact.target.runtimeId && source.requirement.pin.config[axis] === value;
    if ((bound || explicitPin) && value !== undefined && binding?.support === "supported" && binding.axes?.[axis] === "supported" && contract.frontmatterKeys.includes(key)) metadata[key] = value;
  }
  const options = { sortKeys: true, noRefs: true, lineWidth: -1, quotingType: '"', forceQuotes: false };
  const keys = Object.keys(metadata).sort();
  const header = contract.preferUnescapedQuotes === true && keys.length ? keys.map(key => {
    const value = metadata[key];
    const quotingType = typeof value === "string" && value.includes('"') && !value.includes("'") ? "'" : '"';
    return yaml.dump({ [key]: value }, { ...options, quotingType });
  }).join("") : yaml.dump(metadata, options);
  return `---\n# dotbabel:generated projection=${projectionId} source=${artifact.sourcePath} — do not edit directly\n${header}---\n${body}`;
}
