/** Subprocess fixture: implements only the native methods the managed CLI uses. */
import { createInterface } from "node:readline";
import { readFileSync, appendFileSync } from "node:fs";
const log = process.argv[2], command = process.argv[3];
const catalog = JSON.parse(readFileSync(new URL("../model-intelligence/codex/debug-models.json", import.meta.url)));
if (command === "debug") { process.stdout.write(JSON.stringify(catalog)); process.exit(0); }
if (command === "--version") { process.stdout.write("codex-cli 0.163.0\n"); process.exit(0); }
let count = 0, model = "native-default", effort = "medium";
const emit = value => process.stdout.write(`${JSON.stringify(value)}\n`);
for await (const line of createInterface({ input: process.stdin })) {
  const message = JSON.parse(line);
  if (message.id === undefined) continue;
  const { id, method, params } = message;
  let result;
  if (method === "initialize") result = { userAgent: "dotbabel-managed-session/0.163.0 (fixture)" };
  else if (method === "config/read") result = { config: {}, origins: {} };
  else if (method === "thread/start") result = { thread: { id: "same-thread", turns: [] }, model, reasoningEffort: effort, approvalPolicy: "on-request", sandbox: { type: "readOnly" } };
  else if (method === "model/list") result = { data: catalog.models.map(row => ({ model: row.slug, hidden: false })) };
  else if (method === "thread/read") result = { thread: { id: "same-thread", model, reasoningEffort: effort, modelProvider: "fixture-provider" } };
  else if (method === "turn/start") {
    appendFileSync(log, JSON.stringify(params) + "\n");
    model = params.model ?? model; effort = params.effort ?? effort;
    const turnId = `fixture-turn-${++count}`;
    emit({ id, result: { turn: { id: turnId, status: "inProgress" } } });
    emit({ method: "item/agentMessage/delta", params: { threadId: "same-thread", turnId, delta: "fixture response" } });
    emit({ method: "turn/completed", params: { threadId: "same-thread", turn: { id: turnId, status: "completed" } } });
    continue;
  } else { emit({ id, error: { code: -32601, message: "Unsupported fixture method" } }); continue; }
  emit({ id, result });
}
