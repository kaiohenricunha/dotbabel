import { it, expect } from "vitest";
import { peerHook } from "../../src/peer/hooks.mjs";
import {
  createState,
  registerMain,
  pairAdvisor,
  enqueue,
  nextRequest,
  finishRequest,
  sendMessage,
  receiveMessages,
  nativeMessage,
} from "../../src/peer/state.mjs";
function world() {
  const s = createState("r"),
    main = { key: "m", repo: "r" },
    advisor = { key: "a", repo: "r" };
  const p = registerMain(s, main, { alive: () => true });
  pairAdvisor(s, advisor, p.code, { alive: () => true });
  return { p, main, advisor };
}
it("allows read tools and bounded shell inspection, but refuses writes and shell execution tricks", () => {
  const { p, advisor } = world();
  for (const tool of ["Read", "Grep", "Glob", "ListAgents", "WebSearch", "WebFetch"])
    expect(peerHook(p, advisor, { hook_event_name: "PreToolUse", tool_name: tool })).toBe(null);
  for (const command of [
    "pwd",
    "ls src",
    "rg race src",
    "git diff --stat",
    "git --no-pager -C /repo status",
    "git show HEAD:a",
    "dotbabel peer next",
    "dotbabel peer send main 'finding; x && y'",
    `node '${new URL("../../bin/dotbabel-peer.mjs", import.meta.url).pathname}' queue`,
  ]) {
    expect(
      peerHook(p, advisor, {
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command },
      }),
      command,
    ).toBe(null);
  }
  for (const command of [
    null,
    "",
    "'unclosed",
    "git status; touch x",
    "git status > x",
    "echo x",
    "$(rm x)",
    "LD_PRELOAD=x cat a",
    "env cat a",
    "rg --pre rm a",
    "git diff --output=x",
    "dotbabel peer setup --harness both",
    // Unpairing would end this guard, so only Main or the user can do it.
    "dotbabel peer unpair",
    `node '${new URL("../../bin/dotbabel-peer.mjs", import.meta.url).pathname}' unpair`,
    `node '${new URL("../../bin/dotbabel.mjs", import.meta.url).pathname}' peer unpair`,
    'dotbabel peer send main "$(rm x)"',
    "git\nstatus",
    "cat a | tee b",
    "node /untrusted/dotbabel-peer.mjs queue",
    "node /untrusted/dotbabel.mjs peer queue",
    "/untrusted/cat src/main.mjs",
    "/untrusted/git status",
  ]) {
    expect(
      peerHook(p, advisor, {
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command },
      })?.hookSpecificOutput?.permissionDecision,
      String(command),
    ).toBe("deny");
  }
  expect(
    peerHook(p, advisor, {
      hook_event_name: "PreToolUse",
      tool_name: "exec_command",
      tool_input: { cmd: "git status" },
    }),
  ).toBe(null);
});
it("does not constrain Main and ends only the invoking role", () => {
  const { p, main, advisor } = world();
  expect(peerHook(p, main, { hook_event_name: "PreToolUse", tool_name: "Write" })).toBe(null);
  peerHook(p, main, { hook_event_name: "SessionEnd" });
  expect(p.main.ended).toBe(true);
  expect(p.advisor.ended).toBeUndefined();
  expect(peerHook(p, advisor, { hook_event_name: "Other" })).toBe(null);
});
it("continues queued work, reminds once about unfinished work, then pauses without an infinite loop", () => {
  const { p, advisor } = world();
  expect(peerHook(p, advisor, { hook_event_name: "Stop" })).toBe(null);
  const r = enqueue(p, "review");
  expect(peerHook(p, advisor, { hook_event_name: "Stop" }).decision).toBe("block");
  expect(r.state).toBe("running");
  expect(
    peerHook(p, advisor, { hook_event_name: "Stop", stop_hook_active: false }).reason,
  ).toContain(r.id);
  expect(peerHook(p, advisor, { hook_event_name: "Stop", stop_hook_active: true })).toBe(null);
  expect(p.paused).toBe(true);
  expect(peerHook(p, advisor, { hook_event_name: "Stop" })).toBe(null);
});
it("pauses and fences work after model failure and restores role context after compaction", () => {
  const { p, advisor } = world();
  const r = enqueue(p, "review");
  nextRequest(p, advisor);
  const old = r.lease;
  peerHook(p, advisor, { hook_event_name: "StopFailure" });
  expect(r.state).toBe("queued");
  expect(p.paused).toBe(true);
  expect(() => finishRequest(p, advisor, r.id, old, "completed", "late")).toThrow();
  expect(
    peerHook(p, advisor, { hook_event_name: "SessionStart" }).hookSpecificOutput.additionalContext,
  ).toContain(p.id);
});

it("rebinds the same resumed session without leaving it marked terminated", () => {
  const { p, advisor, main } = world();
  peerHook(p, advisor, { hook_event_name: "SessionEnd" });
  expect(p.advisor.ended).toBe(true);
  peerHook(p, advisor, { hook_event_name: "SessionStart" });
  expect(p.advisor.ended).toBe(false);
  peerHook(p, main, { hook_event_name: "SessionEnd" });
  expect(
    peerHook(p, main, { hook_event_name: "SessionStart" }).hookSpecificOutput.additionalContext,
  ).toContain("Main");
  expect(p.main.ended).toBe(false);
});

it("follows the same live session into another worktree of the same repository", () => {
  const s = createState("r"),
    main = { key: "m", repo: "r", pid: 1, procStart: "10", worktree: "/r/wt/es9" };
  const p = registerMain(s, { ...main }, { alive: () => true });
  pairAdvisor(s, { key: "a", repo: "r" }, p.code, { alive: () => true });
  const tool = { hook_event_name: "PreToolUse", tool_name: "Bash" };
  expect(peerHook(p, { ...main, worktree: "/r/wt/check-bc" }, tool)).toBe(null);
  expect(p.main.worktree).toBe("/r/wt/check-bc");
  peerHook(p, { ...main, pid: 2, worktree: "/r/wt/other-process" }, tool);
  peerHook(p, { ...main, repo: "other", worktree: "/other/repo" }, tool);
  peerHook(p, { ...main, worktree: undefined }, tool);
  expect(p.main.worktree).toBe("/r/wt/check-bc");
});

it("reminds Main once at Stop and on each prompt while Advisor messages are unread", () => {
  const { p, main, advisor } = world();
  const stop = (extra = {}) => peerHook(p, main, { hook_event_name: "Stop", ...extra });
  const prompt = () => peerHook(p, main, { hook_event_name: "UserPromptSubmit" });
  expect(stop()).toBe(null);
  expect(prompt()).toBe(null);
  sendMessage(p, main, "advisor", "to the Advisor");
  expect(stop()).toBe(null);
  sendMessage(p, advisor, "main", "UNTRUSTED-BODY", { kind: "finding" });
  expect(stop({ stop_hook_active: true })).toBe(null);
  const blocked = stop({ stop_hook_active: false });
  expect(blocked.decision).toBe("block");
  expect(blocked.reason).toContain("dotbabel peer receive");
  expect(blocked.reason).not.toContain("UNTRUSTED-BODY");
  expect(stop()).toBe(null);
  const context = prompt().hookSpecificOutput;
  expect(context.hookEventName).toBe("UserPromptSubmit");
  expect(context.additionalContext).toContain(p.id);
  expect(context.additionalContext).not.toContain("UNTRUSTED-BODY");
  sendMessage(p, advisor, "main", "second finding", { kind: "finding" });
  expect(stop().reason).toContain("2 unread");
  receiveMessages(p, main);
  expect(stop()).toBe(null);
  expect(prompt()).toBe(null);
});

it("reminds the Advisor about unread Main messages, also while paused, beside queued work", () => {
  const { p, main, advisor } = world();
  const stop = (extra = {}) => peerHook(p, advisor, { hook_event_name: "Stop", ...extra });
  const prompt = () => peerHook(p, advisor, { hook_event_name: "UserPromptSubmit" });
  expect(stop()).toBe(null);
  expect(prompt()).toBe(null);
  sendMessage(p, advisor, "main", "to Main");
  expect(stop()).toBe(null);
  sendMessage(p, main, "advisor", "UNTRUSTED-BODY");
  expect(stop({ stop_hook_active: true })).toBe(null);
  const blocked = stop({ stop_hook_active: false });
  expect(blocked.decision).toBe("block");
  expect(blocked.reason).toContain("Peer Main messages wait for Advisor: 1 unread");
  expect(blocked.reason).not.toContain("UNTRUSTED-BODY");
  expect(stop()).toBe(null);
  const context = prompt().hookSpecificOutput;
  expect(context.hookEventName).toBe("UserPromptSubmit");
  expect(context.additionalContext).toContain(p.id);
  sendMessage(p, main, "advisor", "second");
  const r = enqueue(p, "review");
  const both = stop();
  expect(both.decision).toBe("block");
  expect(both.reason).toContain(r.id);
  expect(both.reason).toContain("2 unread");
  receiveMessages(p, advisor);
  p.paused = true;
  sendMessage(p, main, "advisor", "while paused");
  expect(stop().reason).toContain("1 unread");
  receiveMessages(p, advisor);
  expect(prompt()).toBe(null);
});

it("lets the Advisor mirror its own ledger messages natively to the paired Main only", () => {
  const s = createState("r"),
    main = { key: "m", repo: "r", harness: "claude", socket: "/run/user/1/cc-socks/10.sock" },
    advisor = { key: "a", repo: "r", harness: "claude", socket: "/run/user/1/cc-socks/20.sock" };
  const p = registerMain(s, main, { alive: () => true });
  pairAdvisor(s, advisor, p.code, { alive: () => true });
  const mine = nativeMessage(p, sendMessage(p, advisor, "main", "finding"));
  const theirs = nativeMessage(p, sendMessage(p, main, "advisor", "note"));
  const send = (to, message, summary = mine.summary) =>
    peerHook(p, advisor, {
      hook_event_name: "PreToolUse",
      tool_name: "SendMessage",
      tool_input: { to, summary, message },
    });
  const decision = (r) => r?.hookSpecificOutput?.permissionDecision ?? "allow";
  expect(decision(send(mine.to, mine.message))).toBe("allow");
  expect(decision(send(mine.to, mine.message, "other words"))).toBe("deny");
  expect(decision(send("uds:/run/user/1/cc-socks/99.sock", mine.message))).toBe("deny");
  expect(decision(send("insights", mine.message))).toBe("deny");
  expect(decision(send(mine.to, "free text without a ledger record"))).toBe("deny");
  expect(decision(send(mine.to, mine.message.replace("finding", "other text")))).toBe("deny");
  expect(decision(send(mine.to, theirs.message))).toBe("deny");
  expect(
    decision(send(mine.to, "[peer msg-00000000-0000-0000-0000-000000000000 seq 9 status] x")),
  ).toBe("deny");
  expect(send(mine.to, "x").hookSpecificOutput.permissionDecisionReason).toContain(
    "dotbabel peer send",
  );
  const tool = (tool_name, tool_input) =>
    decision(peerHook(p, advisor, { hook_event_name: "PreToolUse", tool_name, tool_input }));
  expect(tool("ToolSearch", { query: "select:SendMessage" })).toBe("allow");
  expect(tool("Skill", { skill: "peer" })).toBe("allow");
  expect(tool("Skill", { skill: "deliver" })).toBe("deny");
  p.main.socket = null;
  expect(decision(send(mine.to, mine.message))).toBe("deny");
});
it("asks each member to handle unread messages in sequence and acknowledge each", () => {
  const { p, main, advisor } = world();
  sendMessage(p, advisor, "main", "first");
  const reason = peerHook(p, main, { hook_event_name: "Stop" }).reason;
  expect(reason).toContain("in seq order");
  expect(reason).toContain("dotbabel peer ack");
});

it("lets the Advisor search with grep, find, and read-only git, and delegate to Explore only", () => {
  const { p, advisor } = world();
  const bash = (command) =>
    peerHook(p, advisor, {
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command },
    })?.hookSpecificOutput?.permissionDecision ?? "allow";
  for (const command of [
    "grep -rn 'VITE_DATA_SOURCE' src --include='*.mjs' --exclude-dir=node_modules",
    "grep -rn 'build-full-auto\\|build:full' package.json vercel.json",
    "egrep -n 'a|b' src/a.mjs",
    "/usr/bin/grep -c x a",
    "find src -name '*.mjs' -newer package.json",
    "git grep -n -e build:full HEAD",
    "git grep -n 'VITE_DATA_SOURCE' HEAD -- ':!*.test.*'",
    "git -C /repo worktree list --porcelain",
    "git blame -L 1,5 a.mjs",
    "git ls-tree -r HEAD",
    "git cat-file -p HEAD:a.mjs",
    "git merge-base HEAD origin/main",
    "git rev-list --count HEAD",
  ])
    expect(bash(command), command).toBe("allow");
  for (const command of [
    "find . -delete",
    "find . -name a -execdir touch b +",
    "find . -exec cat {} +",
    "find . -ok rm {} +",
    "find . -fprint out.txt",
    "find . -fprintf out.txt %p",
    "find . -fls out.txt",
    "git grep -O less x",
    "git grep -Oless x",
    "git grep --open-files-in-pager=vim x",
    "git cat-file --filters HEAD:a",
    "git worktree add ../x",
    "git worktree remove ../x",
    "git worktree",
    "/untrusted/grep x a",
    "grep x a > b",
    'grep -rn "a\\|b" src',
    "grep -rn x src --include=*.mjs",
  ])
    expect(bash(command), command).toBe("deny");
  const reason = peerHook(p, advisor, {
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command: "grep -rn x src --include=*.mjs" },
  }).hookSpecificOutput.permissionDecisionReason;
  expect(reason).toContain("Peer Advisor is read-only");
  expect(reason).toContain("single quotes");
  expect(reason).toContain("Only Main or the user can unpair");
  const agent = (tool_input) =>
    peerHook(p, advisor, { hook_event_name: "PreToolUse", tool_name: "Agent", tool_input })
      ?.hookSpecificOutput?.permissionDecision ?? "allow";
  expect(agent({ subagent_type: "Explore", prompt: "find callers" })).toBe("allow");
  expect(agent({ subagent_type: "general-purpose", prompt: "x" })).toBe("deny");
  expect(agent({ subagent_type: "Explore", isolation: "worktree", prompt: "x" })).toBe("deny");
  expect(agent({ prompt: "x" })).toBe("deny");
});
