/** Managed Antigravity stream sessions and the CLI's native camelCase hook contract. */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createNativeIntegration } from "../integration.mjs";
import {
  currentNativeSession,
  readNativeRegistration,
  validateNativeId,
} from "../native-registry.mjs";
import { repository, peerRoot } from "../identity.mjs";
import { PeerStore } from "../store.mjs";
import { peerHook } from "../hooks.mjs";
import { coordinatePeer } from "../cli.mjs";
import { assertAntigravityHooks } from "../native-setup.mjs";

const BIN = fileURLToPath(new URL("../../../bin/dotbabel-peer.mjs", import.meta.url));
const quote = (text) => `'${text.replaceAll("'", "'\\''")}'`;
const READ_TOOLS = new Set([
  "view_file",
  "list_dir",
  "find_by_name",
  "grep_search",
  "search_web",
  "read_url_content",
  "list_permissions",
]);
const STREAM_GUIDANCE =
  "Antigravity stream mode cannot prompt for native permissions. Inspect this workspace with view_file, list_dir, find_by_name, and grep_search. Use literal peer commands for coordination; use peer --help for syntax instead of reading package source outside the workspace. Do not run ordinary shell commands such as git status unless native policy already permits them. Ask Main for restricted Git evidence through a correlated peer question and wait. Preserve every native permission denial; never add a bypass flag.";

/** Apply a native hook only to a process-owned, registered Antigravity conversation. @param {string} event @param {object} input @param {object} [options] @returns {Promise<object>} */
export async function antigravityHook(
  event,
  input,
  { env = process.env, startPid = process.ppid } = {},
) {
  const root = peerRoot(env),
    key = `antigravity:${input.conversationId}`;
  if (!readNativeRegistration(root, key) && env.DOTBABEL_PEER_MANAGED !== "antigravity") return {};
  const repo = repository(input.workspacePaths?.[0] || process.cwd());
  const who = currentNativeSession(repo, { root, key, startPid });
  const store = new PeerStore(root, repo.key);
  const canonical = {
    hook_event_name: ["PreInvocation", "SessionStart"].includes(event) ? "SessionStart" : event,
    tool_name:
      input.toolCall?.name === "run_command"
        ? "Bash"
        : READ_TOOLS.has(input.toolCall?.name)
          ? "Read"
          : input.toolCall?.name,
    tool_input:
      input.toolCall?.name === "run_command"
        ? { command: input.toolCall.args?.CommandLine }
        : input.toolCall?.args,
  };
  if (event === "PreToolUse" && input.toolCall?.name === "run_command") {
    if (repository(input.toolCall.args?.Cwd || repo.worktree).worktree !== repo.worktree)
      return {
        decision: "deny",
        reason: "Peer command workspace does not match its registered session.",
      };
    const coordinated = await coordinatePeer(store, who, canonical, env);
    const output = coordinated?.hookSpecificOutput;
    if (output?.updatedInput)
      return {
        decision: "auto_approve",
        reason: output.permissionDecisionReason,
        overwrite: { CommandLine: output.updatedInput.command },
      };
    if (output?.permissionDecision === "deny")
      return { decision: "deny", reason: output.permissionDecisionReason };
  }
  const result = await store.transaction((state) => {
    const pair = state.pairs.find(
      (p) => !p.closed && [p.main?.key, p.advisor?.key].includes(who.key),
    );
    if (!pair) return null;
    if (event === "Stop") {
      if (
        input.error ||
        ["error", "max_steps_exceeded", "interrupted"].includes(input.terminationReason)
      )
        return peerHook(pair, who, { hook_event_name: "StopFailure" });
      if (!input.fullyIdle) return null;
      const running = pair.requests.find((r) => r.state === "running");
      canonical.stop_hook_active = Boolean(
        running?.lease && pair.nativeStopReminder === running.lease,
      );
      const stopped = peerHook(pair, who, canonical);
      pair.nativeStopReminder =
        stopped?.decision === "block"
          ? pair.requests.find((r) => r.state === "running")?.lease
          : null;
      return stopped;
    }
    return peerHook(pair, who, canonical);
  });
  const output = result?.hookSpecificOutput;
  if (event === "PreToolUse")
    return output?.permissionDecision === "deny"
      ? { decision: "deny", reason: output.permissionDecisionReason }
      : { decision: "allow" };
  if (output?.additionalContext)
    return {
      injectSteps: [{ ephemeralMessage: `${output.additionalContext}\n${STREAM_GUIDANCE}` }],
    };
  if (result?.decision === "block") return { decision: "continue", reason: result.reason };
  return {};
}

/** Start one owned native stream; the init event supplies identity and no permission/model flag is overridden. @param {object} options @returns {object} */
export function startAntigravityPeer({
  worktree,
  role,
  code,
  pair: pairId,
  conversation,
  env = process.env,
  onEvent = () => {},
  spawnChild = spawn,
}) {
  if (!["main", "advisor"].includes(role)) throw new Error("launch role must be main or advisor");
  if (role === "advisor" && !code && !pairId)
    throw new Error("advisor launch requires a Main pairing code or --pair ID");
  if (conversation) {
    if (!pairId) throw new Error("native conversation resume requires --pair ID");
    validateNativeId("antigravity", conversation);
  }
  assertAntigravityHooks(worktree);
  const childEnv = { ...env, DOTBABEL_PEER_MANAGED: "antigravity" };
  for (const key of [
    "CODEX_THREAD_ID",
    "CODEX_SESSION_ID",
    "DOTBABEL_PEER_HOOK_SESSION",
    "DOTBABEL_PEER_NATIVE_SESSION",
  ])
    delete childEnv[key];
  let child,
    sessionId,
    stopping = false,
    closed,
    resolveReady,
    rejectReady,
    resolveDone,
    rejectDone;
  let firstError,
    registered = false;
  const ready = new Promise((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const done = new Promise((resolve, reject) => {
    resolveDone = resolve;
    rejectDone = reject;
  });
  // Callers can await readiness first without an unhandled rejection on early exit.
  done.catch(() => {});
  const send = async (text) => {
    if (stopping || !child || child.exitCode !== null || !child.stdin.writable)
      throw new Error("Antigravity input is unavailable");
    if (typeof text !== "string" || !text.trim() || Buffer.byteLength(text) > 16384)
      throw new Error("Antigravity prompt must be bounded text");
    await new Promise((resolve, reject) =>
      child.stdin.write(
        JSON.stringify({ event: "user", message: { content: text } }) + "\n",
        (err) => (err ? reject(err) : resolve()),
      ),
    );
  };
  const host = createNativeIntegration({
    harness: "antigravity",
    worktree,
    env,
    notify: async (id, text) => {
      if (id !== sessionId) throw new Error("Antigravity native conversation changed");
      await send(text);
    },
  });
  async function finish(error) {
    stopping = true;
    try {
      if (registered) {
        if (error) await host.hook(sessionId, { hook_event_name: "StopFailure" });
        await host.hook(sessionId, { hook_event_name: "SessionEnd" });
      }
    } catch (failure) {
      error ??= failure;
    }
    try {
      await host.close();
    } catch (failure) {
      error ??= failure;
    }
    rejectReady(error || new Error("Antigravity exited before native registration"));
    if (error) rejectDone(error);
    else resolveDone();
  }
  async function close() {
    if (!closed)
      closed = (async () => {
        stopping = true;
        if (child && child.exitCode === null) {
          child.kill("SIGTERM");
          const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
          timer.unref();
          try {
            await done;
          } catch {
          } finally {
            clearTimeout(timer);
          }
        } else {
          await host.close();
        }
      })();
    return closed;
  }
  const fail = (error) => {
    firstError ??= error;
    rejectReady(error);
    if (child) void close();
    else void finish(error).catch(rejectDone);
  };
  try {
    const nativeArgs = ["--input-format", "stream-json", "--output-format", "stream-json"];
    if (conversation) nativeArgs.push("--conversation", conversation);
    child = spawnChild("agy", nativeArgs, {
      cwd: worktree,
      env: childEnv,
      stdio: ["pipe", "pipe", "inherit"],
    });
  } catch (error) {
    fail(error);
    return { ready, done, send, close };
  }
  let pending = Promise.resolve(),
    buffered = "",
    deniedCount = 0;
  async function event(event) {
    if (event.event === "init") {
      if (sessionId) throw new Error("Antigravity emitted duplicate initialization");
      sessionId = event.conversation_id;
      validateNativeId("antigravity", sessionId);
      if (conversation && sessionId.toLowerCase() !== conversation.toLowerCase())
        throw new Error("Antigravity resumed a different native conversation");
      const pair = await host.invoke(
        sessionId,
        pairId
          ? ["reconnect", role, "--pair", pairId]
          : role === "main"
            ? ["main"]
            : ["advisor", code],
      );
      registered = true;
      onEvent(event);
      onEvent({ event: "dotbabel_peer", pair });
      const context = await host.context(sessionId);
      await send(
        `${context}\n${STREAM_GUIDANCE}\nUse one literal command: node ${quote(BIN)} receive, then next if Advisor. Load the peer skill. Process messages with explicit ACKs. Record complete, fail or wait using --lease TOKEN --result TEXT; continue FIFO. Do not infer completion from a finished turn.`,
      );
      resolveReady(pair);
      return;
    }
    if (!sessionId) throw new Error("Antigravity output precedes native initialization");
    const emitted = event.result?.conversation_id ?? event.step_update?.conversation_id;
    if (emitted && emitted !== sessionId)
      throw new Error("Antigravity changed its native conversation ID");
    if (event.event === "result") {
      // Stream results repeat cumulative run totals, including earlier denials.
      const count = event.result?.denied_actions?.length ?? 0;
      const newDenial = count > deniedCount;
      deniedCount = Math.max(deniedCount, count);
      if (event.result?.status !== "SUCCESS" || newDenial)
        await host.hook(sessionId, { hook_event_name: "StopFailure" });
    }
    onEvent(event);
  }
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffered += chunk;
    if (Buffer.byteLength(buffered) > 8 * 1024 * 1024) {
      fail(new Error("Antigravity output line exceeds its bound"));
      return;
    }
    let newline;
    while ((newline = buffered.indexOf("\n")) >= 0) {
      const line = buffered.slice(0, newline);
      buffered = buffered.slice(newline + 1);
      if (line.trim()) pending = pending.then(() => event(JSON.parse(line))).catch(fail);
    }
  });
  child.once("error", fail);
  child.once("close", (code, signal) => {
    pending
      .then(() =>
        finish(
          firstError ||
            (!stopping && (code !== 0 || signal)
              ? new Error(`Antigravity exited (${code ?? signal})`)
              : null),
        ),
      )
      .catch(fail);
  });
  return {
    ready,
    done,
    send,
    close,
    end() {
      stopping = true;
      child.stdin.end();
    },
  };
}
