/** Ordinary newline prompts for the managed Codex client; no native configuration is written. */
import { createInterface } from "node:readline";
import { openCodexSession } from "./client.mjs";

/**
 * Run one managed terminal session. EOF closes it; an uncertain submission is never replayed.
 * Native approval requests require an explicit interactive answer. Piped input cannot approve tools.
 * JSON output is a stream of session, assistant-text and turn-result records, not one document.
 * @param {object} options repoRoot, model/effort options and json output mode.
 * @returns {Promise<void>}
 */
export async function runManagedTerminal(options) {
  const lines = createInterface({ input: process.stdin, output: process.stderr, terminal: Boolean(process.stdin.isTTY) });
  const iterator = lines[Symbol.asyncIterator]();
  let session;
  const interrupted = () => { lines.close(); session?.close(); process.exitCode = 130; };
  process.on("SIGINT", interrupted);
  const json = record => process.stdout.write(`${JSON.stringify(record)}\n`);
  try {
    session = await openCodexSession({ ...options,
      onServerRequest: async (method, params) => {
        if (!process.stdin.isTTY || !["item/commandExecution/requestApproval", "item/fileChange/requestApproval"].includes(method)) throw Error("native_handler_unavailable");
        process.stderr.write(`Native approval request: ${method}\n${JSON.stringify(params)}\nType accept to approve once; any other answer declines: `);
        const answer = await iterator.next();
        return { decision: !answer.done && answer.value === "accept" ? "accept" : "decline" };
      },
      onEvent: message => {
        if (message.method !== "item/agentMessage/delta" || typeof message.params?.delta !== "string") return;
        if (options.json) json({ type: "assistant-text", text: message.params.delta });
        else process.stdout.write(message.params.delta);
      },
    });
    if (options.json) json({ type: "session", runtime: "codex", mechanism: "managed-app-server", threadId: session.threadId, routing: session.routing, native: session.native });
    else process.stderr.write("Managed Codex session. Enter an ordinary prompt. End input to close.\n");
    while (process.exitCode !== 130) {
      if (process.stdin.isTTY) process.stderr.write("You> ");
      const line = await iterator.next();
      if (line.done) break;
      if (!line.value.trim()) continue;
      const result = await session.submit([{ type: "text", text: line.value, text_elements: [] }]);
      if (options.json) json({ type: "turn", ...result });
      else process.stderr.write(`\n${result.status}; requested ${JSON.stringify(result.requested ?? {})}; effective ${JSON.stringify(result.effective)}; diagnostics ${(result.decision?.diagnostics ?? result.diagnostics).map(item => item.code).join(",")}\n`);
      if (result.status === "blocked") process.exitCode = 1;
      if (["uncertain", "failed", "interrupted"].includes(result.status)) { process.exitCode = 2; break; }
    }
  } finally { session?.close(); lines.close(); process.removeListener("SIGINT", interrupted); }
}
