/** Claude-only release workflow adapter; selection stays in the shared resolver. */
import yaml from "js-yaml";
import { parseComputeDeclaration } from "../../requirement/index.mjs";
import { resolve } from "../../resolver/index.mjs";
import { mergePolicy, SHIPPED_POLICY } from "../../policy/index.mjs";
import { snapshotCatalog, validateSnapshot } from "../../snapshot/core.mjs";
import { renderInvocation } from "../../sources/runtime/claude.mjs";
import { materialize } from "../index.mjs";

const fail = code => Object.assign(new Error(code), { code });
const sourcePath = "plugins/dotbabel/src/model-intelligence/workflows/ai-review.source.yml";
const quote = value => "'" + value.replaceAll("'", "'\"'\"'") + "'";
function parse(text, code) {
  try { if (typeof text !== "string" || Buffer.byteLength(text) > 1024 * 1024) throw fail(code); return yaml.load(text); }
  catch { throw fail(code); }
}

/**
 * Resolve the canonical session sidecar and emit a native, offline GitHub Actions workflow.
 * This adapter does not discover capabilities, invoke Claude or alter worker configurations.
 * @param {{toolVersion:string,snapshot:object,sourceContent:string,computeContent:string}} inputs Immutable release inputs.
 * @returns {{files:object[],manifest:object}} One YAML projection and its deterministic provenance.
 */
export function buildClaudeReviewWorkflow({ toolVersion, snapshot, sourceContent, computeContent }) {
  validateSnapshot(snapshot);
  const declaration = parse(computeContent, "workflow_compute_invalid");
  const parsed = parseComputeDeclaration(declaration, { sourcePath: sourcePath.replace("source", "compute") });
  if (!declaration || Object.keys(declaration).length !== 1 || !declaration.dotbabel || Object.keys(declaration.dotbabel).length !== 1 || parsed.errors.length || !parsed.requirement || parsed.requirement.binding !== "session" || !["floor", "pin"].includes(parsed.requirement.mode)) throw fail("workflow_compute_invalid");
  const document = parse(sourceContent, "workflow_source_invalid");
  if (!document || Object.hasOwn(document, "dotbabel")) throw fail("workflow_source_invalid");
  const steps = document.jobs?.review?.steps;
  const step = Array.isArray(steps) ? steps.find(item => item.name === "Run /review-prs headless") : undefined;
  const command = "npx @anthropic-ai/claude-code -p ";
  const runs = Array.isArray(steps) ? steps.filter(item => typeof item.run === "string").map(item => item.run) : [];
  if (typeof step?.run !== "string" || !step.run.startsWith(command) || runs.join("\n").split("npx @anthropic-ai/claude-code").length !== 2 || /--(?:model|effort)\b/.test(step.run) || sourceContent.split(command).length !== 2) throw fail("workflow_invocation_invalid");
  const runtimeContract = snapshot.runtimes.claude.runtimeContract;
  const invocation = runtimeContract.capabilities.invocation;
  if (invocation?.support !== "supported" || invocation.axes?.model !== "supported" || invocation.axes?.reasoning !== "supported") throw fail("workflow_invocation_unverified");
  const policy = mergePolicy({ shipped: SHIPPED_POLICY });
  const target = { path: "ai-review.yml", runtimeId: "claude", artifactKind: "workflow" };
  const resolverResult = resolve({ requirement: parsed.requirement, target, catalog: snapshotCatalog(snapshot), policy, runtimeContract });
  if (resolverResult.status !== "resolved" || resolverResult.confidence === "low" || resolverResult.enforcement.state === "unsatisfied" || typeof resolverResult.configuration?.axes.model !== "string") throw fail("release_requirement_unsatisfied");
  const nativeArgs = " " + renderInvocation(resolverResult.configuration).args.map((value, index) => index % 2 === 0 ? value : quote(value)).join(" ");
  const outputBody = sourceContent.replace(command, "npx @anthropic-ai/claude-code" + nativeArgs + " -p ");
  return materialize({ toolVersion, artifacts: [{ sourcePath, sourceContent, target, requirement: parsed.requirement, policy, resolverResult, runtimeContract, snapshotId: snapshot.snapshotId, capabilityEvidence: { sidecar: declaration }, projectionContract: { outputFormat: "yaml", outputBody, frontmatterKeys: [] } }] });
}
