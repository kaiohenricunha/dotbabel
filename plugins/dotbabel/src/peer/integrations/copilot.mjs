/** Foreground Copilot extension, using the SDK injected by the native CLI. */
import { createNativeIntegration, PEER_TOOL } from "../integration.mjs";

const READ_TOOLS = new Map([
  ["view", "Read"],
  ["glob", "Glob"],
  ["grep", "Grep"],
  ["rg", "Grep"],
  ["web_fetch", "WebFetch"],
  ["web_search", "WebSearch"],
  ["read_bash", "Read"],
  [PEER_TOOL.name, "Read"],
]);

function canonicalInput(input) {
  let args = input.toolArgs;
  if (typeof args === "string") {
    try {
      args = JSON.parse(args);
    } catch {
      args = {};
    }
  }
  const tool =
    input.toolName === "bash" ? "Bash" : (READ_TOOLS.get(input.toolName) ?? input.toolName);
  return { hook_event_name: "PreToolUse", tool_name: tool, tool_input: args };
}

/** Join the actual foreground session without replacing its permission handler or model. @param {Function} joinSession native extension API @param {object} [options] @returns {Promise<object>} */
export async function startCopilotPeer(
  joinSession,
  { directory = process.cwd(), env = process.env } = {},
) {
  let session;
  const host = createNativeIntegration({
    harness: "copilot",
    worktree: directory,
    env,
    notify: async (sessionId, prompt) => {
      if (!session || session.sessionId !== sessionId)
        throw new Error("Copilot foreground session changed");
      await session.send({ prompt, mode: "enqueue" });
    },
  });
  function foreground(sessionId) {
    if (!session || sessionId !== session.sessionId)
      throw new Error("peer tool session does not match the native foreground session");
    return sessionId;
  }
  const hooks = {
    async onPreToolUse(input, invocation) {
      if (input.toolName === "bash") {
        const coordinated = await host.coordinate(invocation.sessionId, canonicalInput(input));
        const output = coordinated?.hookSpecificOutput;
        if (output?.updatedInput)
          return {
            permissionDecision: output.permissionDecision,
            permissionDecisionReason: output.permissionDecisionReason,
            modifiedArgs: output.updatedInput,
          };
      }
      const result = await host.hook(invocation.sessionId, canonicalInput(input));
      const decision = result?.hookSpecificOutput;
      if (decision?.permissionDecision === "deny")
        return {
          permissionDecision: "deny",
          permissionDecisionReason: decision.permissionDecisionReason,
        };
    },
    async onUserPromptSubmitted(_input, invocation) {
      const context = await host.context(invocation.sessionId);
      if (context)
        return {
          additionalContext: `${context}\nUse the dotbabel_peer tool with an argv array for coordination. Preserve native permission prompts.`,
        };
    },
    async onSessionStart(_input, invocation) {
      const context = await host.context(invocation.sessionId);
      if (context) return { additionalContext: context };
    },
    async onSessionEnd(_input, invocation) {
      await host.hook(invocation.sessionId, { hook_event_name: "SessionEnd" });
      await host.closeSession(invocation.sessionId);
    },
    async onErrorOccurred(input, invocation) {
      if (!input.recoverable)
        await host.hook(invocation.sessionId, { hook_event_name: "StopFailure" });
    },
  };
  try {
    session = await joinSession({
      hooks,
      tools: [
        {
          ...PEER_TOOL,
          handler: async (input, invocation) => {
            const sessionId = foreground(invocation.sessionId);
            try {
              return JSON.stringify(await host.invoke(sessionId, input.argv));
            } catch (error) {
              const message = error instanceof Error ? error.message : "Peer operation failed";
              return {
                resultType: "failure",
                textResultForLlm: JSON.stringify({ error: { code: "PEER_OPERATION", message } }),
                error: message,
              };
            }
          },
        },
      ],
    });
    await host.context(session.sessionId);
    const unsubscribe = session.on("session.idle", async () => {
      try {
        const reason = await host.idle(session.sessionId);
        if (reason) await session.send({ prompt: reason, mode: "enqueue" });
      } catch {
        await session.log(
          "Dotbabel peer continuation failed. Inspect peer status before retrying.",
          { level: "error" },
        );
      }
    });
    return {
      session,
      async close() {
        unsubscribe();
        await host.close();
      },
    };
  } catch (error) {
    await host.close();
    throw error;
  }
}
