/** Local fixture comparison; no inference, credentials or repository discovery. */
import { performance } from "node:perf_hooks";
import { classify } from "../../plugins/dotbabel/src/adaptive-session-routing/classifier/index.mjs";
import { tasks } from "../../plugins/dotbabel/tests/fixtures/adaptive-session-routing/tasks.mjs";
function lexical({ prompt }) {
  const text = prompt.toLowerCase();
  const system = /architecture|distributed|redesign/.test(text);
  const high = /production|security|authentication|race|idempotency/.test(text);
  const integration = /integration|persistence|webhook/.test(text);
  const mechanical = /format|rename|sort|lint/.test(text);
  const demand = system ? "exceptional" : high ? "frontier" : integration ? "deep" : mechanical ? "mechanical" : "routine";
  return { status: "classified", requirement: { requirement: demand }, effortIntent: system || high ? "high" : demand === "mechanical" ? "low" : "medium" };
}
function agrees(result, expected) {
  return expected.status === "uncertain" ? result.status === "uncertain" : result.status === "classified" && result.requirement.requirement === expected.requirement && result.effortIntent === expected.effortIntent;
}
const approaches = {};
for (const [name, classifyTask] of [["lexical", lexical], ["contextual", classify]]) {
  const cases = tasks.map(task => {
    const result = classifyTask(task);
    return { id: task.id, agreement: agrees(result, task.expected), status: result.status,
      confidence: result.confidence ?? "unavailable", requirement: result.requirement?.requirement,
      effortIntent: result.effortIntent, reasonCodes: (result.reasons ?? []).map(reason => reason.code) };
  });
  for (const task of tasks) classifyTask(task);
  const samples = Array.from({ length: 1000 }, (_, index) => { const start = performance.now(); classifyTask(tasks[index % tasks.length]); return performance.now() - start; }).sort((a, b) => a - b);
  approaches[name] = { agreement: cases.filter(item => item.agreement).length, count: tasks.length, p95ms: samples[949], cases };
}
console.log(JSON.stringify({ fixtureKind: "authored implementation fixtures; not held-out accuracy", approaches, modelAssisted: { evaluated: false, reason: "additional provider inference is not authorized or needed by the default", calls: 0 } }, null, 2));
