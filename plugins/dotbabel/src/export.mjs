/** Pure file-export values. No SDK, collector, or network request. */
import { createHash } from "node:crypto";
import { dependencyStates } from "./work-graph.mjs";
import { normalizeReceipt } from "./run-receipt.mjs";
import { JEV_MODEL } from "./jev-adapter.mjs";

/** Pinned development convention snapshot; these attributes are not stable. */
export const CONVENTION_VERSION = "gen-ai-development@f3c6d0c9bb66ebd474668a3a0be25c61226f02c2";

function id(value, length) { return createHash("sha256").update(value).digest("hex").slice(0, length); }

/** Convert tasks to A2A 1.0 Task JSON. Blocked references are metadata only.
 * @param {object[]} tasks
 * @param {string} repoKey
 * @param {object} [resolution]
 * @returns {object[]}
 */
export function a2aTasks(tasks, repoKey, resolution = {}) {
  return tasks.map((task) => ({
    id: id(`${repoKey}\0${task.worktree}\0${task.slug}`, 32),
    contextId: id(`${repoKey}\0${task.worktree}`, 32),
    status: { state: task.status === "closed" ? "TASK_STATE_COMPLETED" : task.phase ? "TASK_STATE_WORKING" : "TASK_STATE_SUBMITTED", timestamp: task.updated_at },
    metadata: { slug: task.slug, goal: task.goal, phase: task.phase ?? null, blockedBy: dependencyStates(task, tasks, resolution).filter((s) => s.state !== "satisfied").map(({ ref, state }) => ({ ref, state })) },
  }));
}

function attribute(key, value) {
  if (typeof value === "boolean") return { key, value: { boolValue: value } };
  if (typeof value === "number") return { key, value: { doubleValue: value } };
  return { key, value: { stringValue: typeof value === "string" ? value : JSON.stringify(value) } };
}

function span(traceId, spanId, name, at, attributes, parentSpanId) {
  const instant = String(BigInt(Date.parse(at)) * 1000000n);
  return { traceId, spanId, ...(parentSpanId ? { parentSpanId } : {}), name, kind: 1, startTimeUnixNano: instant, endTimeUnixNano: instant, attributes: Object.entries(attributes).map(([k, v]) => attribute(k, v)) };
}

/** Convert self-reported receipt attempts and decisions to OTLP JSON spans.
 * Attempt timestamps mark recording instants; no duration or token usage is invented.
 * @param {object[]} receipts
 * @returns {object}
 */
export function otlpSpans(receipts) {
  const spans = [];
  for (const value of receipts) {
    const receipt = normalizeReceipt(value);
    const traceId = id(`pr-${receipt.pr}\0${receipt.created_at}`, 32);
    for (const attempt of receipt.attempts) {
      const spanId = id(`${traceId}\0${attempt.phase}\0${attempt.n}`, 16);
      spans.push(span(traceId, spanId, `phase ${attempt.phase}`, attempt.at, { "dotbabel.pr": receipt.pr, "dotbabel.outcome": attempt.outcome, "dotbabel.head_sha": attempt.head_sha, "dotbabel.self_reported": true }));
      for (const [i, decision] of attempt.decisions.entries()) {
        const attrs = { "dotbabel.decider": decision.decider, "dotbabel.answer": decision.answer, "dotbabel.confidence": decision.confidence, "dotbabel.fallback": decision.fallback };
        if (decision.shadow) attrs["dotbabel.shadow"] = decision.shadow;
        if (decision.decider === "jev" || decision.shadow?.decider === "jev") {
          attrs["gen_ai.provider.name"] = "typesafe";
          attrs["gen_ai.request.model"] = JEV_MODEL;
        }
        spans.push(span(traceId, id(`${spanId}\0${i}`, 16), `decide ${decision.step}`, attempt.at, attrs, spanId));
      }
    }
  }
  return { resourceSpans: [{ resource: { attributes: [attribute("service.name", "dotbabel"), attribute("dotbabel.otel.convention.version", CONVENTION_VERSION)] }, scopeSpans: [{ scope: { name: "dotbabel.graph-engineering", version: CONVENTION_VERSION }, spans }] }] };
}

/** Serialize export data while removing configured user keys from strings.
 * @param {unknown} value
 * @param {string[]} [secrets]
 * @returns {string}
 */
export function exportJson(value, secrets = []) {
  return `${JSON.stringify(value, (_, item) => typeof item === "string" ? secrets.filter(Boolean).reduce((s, key) => s.split(key).join("<redacted>"), item) : item, 2)}\n`;
}
