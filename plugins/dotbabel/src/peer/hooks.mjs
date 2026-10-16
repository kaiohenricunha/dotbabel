/** Read-only Advisor guard and recovery context for the two supported hook protocols. */
import { simpleCommands } from "../fleet/heavy.mjs";
import { nextRequest, recoverRequests } from "./state.mjs";

function readOnlyShell(command) {
  if (typeof command !== "string") return false;
  let quote = null;
  for (const c of command) {
    if (c === "\n" || c === "\r") return false;
    if (quote === "'") {
      if (c === "'") quote = null;
      continue;
    }
    if (quote === '"') {
      if (c === '"') quote = null;
      else if (/[`$\\]/.test(c)) return false;
      continue;
    }
    if (c === "'" || c === '"') quote = c;
    else if (/[`$<>|&;(){}\\#]/.test(c)) return false;
  }
  if (quote) return false;
  const commands = simpleCommands(command);
  if (!commands || commands.length !== 1) return false;
  const words = commands[0];
  const first = /^\s*(?:'([^']+)'|"([^"]+)"|([^\s'"]+))/.exec(command);
  if (!first || (first[1] ?? first[2] ?? first[3]) !== words[0]) return false;
  const bin = words[0]?.split("/").at(-1);
  if (["cat", "head", "tail", "wc", "ls", "pwd", "rg"].includes(bin))
    return !words.some((w) => /^(?:--pre|--hostname-bin|--search-zip)(?:=|$)/.test(w));
  if (bin === "git") {
    let i = 1;
    if (words[i] === "--no-pager") i++;
    if (words[i] === "-C") i += 2;
    return (
      ["status", "diff", "show", "log", "ls-files", "rev-parse"].includes(words[i]) &&
      !words.some((w) => /^(?:--output|--ext-diff|--textconv|--exec-path)(?:=|$)/.test(w))
    );
  }
  const cli =
    bin === "dotbabel"
      ? words.slice(1)
      : bin === "node" && words[1]?.endsWith("/dotbabel-peer.mjs")
        ? ["peer", ...words.slice(2)]
        : [];
  return (
    cli[0] === "peer" &&
    [
      "next",
      "receive",
      "ack",
      "complete",
      "fail",
      "wait",
      "send",
      "queue",
      "history",
      "status",
      "ask",
      "inspect",
      "priority",
      "cancel",
      "pause",
      "resume",
      "retry",
      "retry-delivery",
      "unpair",
    ].includes(cli[1])
  );
}
function deny(reason) {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason,
    },
  };
}

/** Apply a hook only to this pair's member. @param {object} pair @param {object} who @param {object} input @returns {object|null} */
export function peerHook(pair, who, input) {
  const advisor = pair.advisor?.key === who.key;
  const event = input.hook_event_name;
  if (event === "SessionEnd") {
    const role = advisor ? "advisor" : "main";
    pair[role].ended = true;
    return null;
  }
  if (event === "SessionStart") {
    const role = advisor ? "advisor" : "main";
    pair[role] = { ...who, ended: false };
    return {
      hookSpecificOutput: {
        hookEventName: event,
        additionalContext: advisor
          ? `Persistent peer Advisor: ${pair.id}. Load the peer skill. Run dotbabel peer status, receive, and next. Read Main's worktree without edits. Use saved results and the current lease after compaction; never infer completion from a finished turn.`
          : `Persistent peer Main: ${pair.id}. Load the peer skill and run dotbabel peer receive. Retain implementation authority and local permission boundaries.`,
      },
    };
  }
  if (!advisor) return null;
  if (event === "PreToolUse") {
    const tool = input.tool_name;
    if (["Read", "Grep", "Glob", "ListAgents", "WebSearch", "WebFetch"].includes(tool)) return null;
    if (
      ["Bash", "exec_command"].includes(tool) &&
      readOnlyShell(input.tool_input?.command ?? input.tool_input?.cmd)
    )
      return null;
    return deny(
      "Peer Advisor is read-only. Inspect files and send findings through dotbabel peer. Main owns implementation. Ask the user to unpair before changing role or permissions.",
    );
  }
  if (["Interrupt", "StopFailure"].includes(event)) {
    recoverRequests(pair, `${event}: explicit retry required`);
    pair.paused = true;
    return null;
  }
  if (event === "Stop" && !pair.paused) {
    const running = pair.requests.find((r) => r.state === "running");
    if (running) {
      // One reminder avoids infinite Stop loops after model/API failures.
      if (input.stop_hook_active) {
        pair.paused = true;
        running.recovery = "stopped without completion; inspect then resume";
        return null;
      }
      return {
        decision: "block",
        reason: `Peer request ${running.id} is still running. Record complete, fail, or wait with its lease. Then run dotbabel peer next.`,
      };
    }
    const next = nextRequest(pair, who);
    if (next)
      return {
        decision: "block",
        reason: `Peer work is queued: ${next.id}. Load the peer skill and run dotbabel peer next. Complete the read-only investigation and continue the queue.`,
      };
  }
  return null;
}
