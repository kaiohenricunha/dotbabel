/** OpenCode v2 native plugin. No provider, model, or permission defaults are changed. */
import fs from "node:fs";
import { createNativeIntegration, PEER_TOOL } from "../integration.mjs";

const READ_TOOLS = new Set(["read", "glob", "grep", "webfetch", "websearch"]);
const EXECUTE_GUIDANCE =
  'Use dotbabel_peer for coordination. In the Advisor role, execute may contain only one literal tool call: return await tools["dotbabel_peer"]({"argv":["status"]});. Use JSON literal arguments and no other JavaScript. Read tools and safe shell inspection use the same single-call form.';

function literalExecute(code) {
  if (typeof code !== "string" || Buffer.byteLength(code) > 24576) return null;
  const call =
    '(?:tools\\.([a-zA-Z_][a-zA-Z0-9_]*)|tools\\["([a-zA-Z_][a-zA-Z0-9_]*)"\\])\\((\\{[\\s\\S]*\\})\\)';
  const direct = new RegExp(`^\\s*(?:return\\s+)?await\\s+${call}\\s*;?\\s*$`).exec(code);
  const assigned = new RegExp(
    `^\\s*const\\s+([a-zA-Z_][a-zA-Z0-9_]*)\\s*=\\s*await\\s+${call}\\s*;\\s*return\\s+\\1\\s*;?\\s*$`,
  ).exec(code);
  const match = direct ?? assigned;
  if (!match) return null;
  const offset = direct ? 0 : 1;
  try {
    const input = JSON.parse(match[3 + offset]);
    return { tool: match[1 + offset] ?? match[2 + offset], input };
  } catch {
    return null;
  }
}
function canonicalTool(tool, input) {
  if (tool === "execute") {
    const literal = literalExecute(input?.code);
    if (!literal || literal.tool === "execute")
      return { tool_name: "NativeJavaScript", tool_input: {} };
    return canonicalTool(literal.tool, literal.input);
  }
  if (READ_TOOLS.has(tool) || tool === PEER_TOOL.name)
    return { tool_name: "Read", tool_input: input };
  if (["shell", "bash"].includes(tool))
    return { tool_name: "Bash", tool_input: { command: input?.command } };
  return { tool_name: tool, tool_input: input };
}
function permissionTool(input) {
  if (READ_TOOLS.has(input.action) || input.action === "list")
    return [{ tool_name: "Read", tool_input: {} }];
  if (input.action === "shell" && input.resources?.length)
    return input.resources.map((command) => ({ tool_name: "Bash", tool_input: { command } }));
  return [{ tool_name: input.action, tool_input: {} }];
}

/** Install scoped native tools, guards, role context, and queued ingress. @param {object} ctx native v2 plugin context @param {object} [options] @returns {Promise<Function>} cleanup */
export async function setupOpenCodePeer(ctx, { env = process.env } = {}) {
  if (!/^2\./.test(ctx.app.version)) throw new Error("Dotbabel peer requires OpenCode v2");
  const directory = fs.realpathSync(ctx.location.directory);
  async function localSession(sessionID) {
    const session = await ctx.session.get({ sessionID });
    let actual;
    try {
      actual = fs.realpathSync(session.location.directory);
    } catch {
      throw new Error("native peer session location is unavailable");
    }
    if (actual !== directory) throw new Error("peer session belongs to another plugin location");
    return sessionID;
  }
  const host = createNativeIntegration({
    harness: "opencode",
    worktree: directory,
    version: ctx.app.version,
    env,
    notify: async (sessionID, text) => {
      await localSession(sessionID);
      await ctx.session.prompt({ sessionID, text, delivery: "queue" });
    },
  });
  const controller = new AbortController();
  try {
    await ctx.tool.transform((editor) =>
      editor.add({
        name: PEER_TOOL.name,
        description: PEER_TOOL.description,
        input: PEER_TOOL.parameters,
        execute: async (input, context) => ({
          content: JSON.stringify(
            await host.invoke(await localSession(context.sessionID), input.argv),
          ),
        }),
      }),
    );
    await ctx.tool.hook("execute.before", async (input) => {
      if (["shell", "bash"].includes(input.tool)) {
        const coordinated = await host.coordinate(input.sessionID, {
          hook_event_name: "PreToolUse",
          ...canonicalTool(input.tool, input.input),
        });
        const replacement = coordinated?.hookSpecificOutput?.updatedInput;
        if (replacement) {
          input.input.command = replacement.command;
          return;
        }
      }
      const result = await host.hook(input.sessionID, {
        hook_event_name: "PreToolUse",
        ...canonicalTool(input.tool, input.input),
      });
      const output = result?.hookSpecificOutput;
      if (output?.permissionDecision === "deny") throw new Error(output.permissionDecisionReason);
    });
    await ctx.permission.hook("evaluate", async (input) => {
      for (const tool of permissionTool(input)) {
        const result = await host.hook(input.sessionID, { hook_event_name: "PreToolUse", ...tool });
        if (result?.hookSpecificOutput?.permissionDecision === "deny") {
          input.effect = "deny";
          input.message = result.hookSpecificOutput.permissionDecisionReason;
          return;
        }
      }
    });
    await ctx.session.hook("context", async (input) => {
      const context = await host.context(input.sessionID);
      if (context) input.system.push({ type: "text", text: `${context}\n${EXECUTE_GUIDANCE}` });
    });
    for (const sessionID of await host.pairedSessions()) {
      try {
        await localSession(sessionID);
      } catch {
        console.error(`Dotbabel peer: paired native session is unavailable: ${sessionID}`);
        continue;
      }
      await host.context(sessionID);
    }
    void consumeEvents(ctx, host, controller.signal).catch((error) => {
      if (!controller.signal.aborted)
        console.error(`Dotbabel peer event stream stopped: ${error.message}`);
    });
    return async () => {
      controller.abort();
      await host.close();
    };
  } catch (error) {
    controller.abort();
    await host.close();
    throw error;
  }
}

async function consumeEvents(ctx, host, signal) {
  for await (const event of ctx.event.subscribe({ signal })) {
    const sessionID = event.data?.sessionID ?? event.sessionID ?? event.properties?.sessionID;
    if (!sessionID) continue;
    if (event.type === "session.deleted") await host.closeSession(sessionID);
    if (
      ["session.error", "session.execution.failed", "session.execution.interrupted"].includes(
        event.type,
      )
    )
      await host.hook(sessionID, { hook_event_name: "StopFailure" });
    if (["session.idle", "session.execution.succeeded"].includes(event.type)) {
      const reason = await host.idle(sessionID);
      if (reason) await ctx.session.prompt({ sessionID, text: reason, delivery: "queue" });
    }
  }
}

export default { id: "dotbabel.peer", setup: setupOpenCodePeer };
