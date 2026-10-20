import { it, expect } from "vitest";
import { peerHook } from "../../src/peer/hooks.mjs";
import {
  createState,
  registerMain,
  pairAdvisor,
  enqueue,
  nextRequest,
  finishRequest,
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
    "dotbabel peer unpair",
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
