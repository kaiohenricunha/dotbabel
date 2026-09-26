// Behavior tests for the text `dotbabel fleet` shows: the deny and ask reasons
// a blocked session reads, the SessionStart context, and the board. These
// strings are the whole interface a model sees, so the tests pin what each one
// must tell it to do, not the exact wording.

import { describe, expect, it } from "vitest";
import {
  formatAge,
  formatAskReason,
  formatBoard,
  formatDenyReason,
  formatSessionContext,
} from "../src/fleet/format.mjs";

const T0 = Date.parse("2026-09-25T12:00:00.000Z");
const iso = (ms) => new Date(ms).toISOString();
const MIN = 60_000;

const peer = {
  key: "200-2",
  name: "dotbabel-45",
  status: "busy",
  alive: true,
  self: false,
  claims: [
    {
      pattern: "docs/hooks.md",
      source: "auto",
      claimedAt: iso(T0 - 12 * MIN),
      branch: "feat/guard",
      worktree: "/repo/.claude/worktrees/guard",
      note: null,
      active: true,
    },
  ],
};
const me = {
  key: "100-1",
  name: "kaiohenricunha-a9",
  status: "busy",
  alive: true,
  self: true,
  claims: [
    {
      pattern: "plugins/dotbabel/src/fleet/**",
      source: "explicit",
      claimedAt: iso(T0 - 3 * MIN),
      branch: "feat/fleet-claims",
      worktree: "/repo/.claude/worktrees/fleet-claims",
      note: "fleet ledger",
      active: true,
    },
  ],
};

describe("formatAge", () => {
  it.each([
    [0, "just now"],
    [59_000, "just now"],
    [90_000, "1m"],
    [3 * 60 * MIN + 5 * MIN, "3h 5m"],
    [50 * 60 * MIN, "2d"],
  ])("%d ms → %s", (ms, text) => {
    expect(formatAge(ms)).toBe(text);
  });
});

describe("formatDenyReason", () => {
  const conflict = { owner: peer, claim: peer.claims[0] };

  it("names the owner and the path, and tells the session to message it", () => {
    const text = formatDenyReason({
      rel: "docs/hooks.md",
      repoKey: "github.com/kaiohenricunha/dotbabel",
      conflict,
      cli: "dotbabel fleet",
      escalateAt: iso(T0 + 15 * MIN),
      now: T0,
    });
    expect(text).toContain('"dotbabel-45"');
    expect(text).toContain("docs/hooks.md");
    expect(text).toContain("feat/guard");
    expect(text).toMatch(/SendMessage/);
    expect(text).toContain("dotbabel fleet release docs/hooks.md");
    expect(text).toMatch(/do not/i);
    expect(text).toMatch(/your user/);
  });

  it("says nothing about escalation when escalation is off", () => {
    const text = formatDenyReason({
      rel: "docs/hooks.md",
      repoKey: "k",
      conflict,
      cli: "dotbabel fleet",
      escalateAt: null,
      now: T0,
    });
    expect(text).not.toMatch(/your user/);
  });
});

describe("formatAskReason", () => {
  it("tells the user who holds the path and for how long", () => {
    const text = formatAskReason({
      rel: "docs/hooks.md",
      conflict: { owner: peer, claim: peer.claims[0] },
      since: iso(T0 - 16 * MIN),
      now: T0,
    });
    expect(text).toContain('"dotbabel-45"');
    expect(text).toContain("docs/hooks.md");
    expect(text).toContain("16m");
  });
});

describe("formatSessionContext", () => {
  it("is empty when nobody holds a claim, so a quiet repo costs no context", () => {
    expect(formatSessionContext({ repoKey: "k", owners: [], cli: "dotbabel fleet" })).toBe("");
  });

  it("lists peer claims and this session's own claims", () => {
    const text = formatSessionContext({ repoKey: "github.com/x/y", owners: [peer, me], cli: "dotbabel fleet" });
    expect(text).toContain("github.com/x/y");
    expect(text).toContain('"dotbabel-45"');
    expect(text).toContain("docs/hooks.md");
    expect(text).toContain("plugins/dotbabel/src/fleet/**");
    expect(text).toMatch(/this session/i);
    expect(text).toMatch(/SendMessage/);
    expect(text).toContain("dotbabel fleet release --all");
  });

  it("caps a long claim list", () => {
    const many = {
      ...peer,
      claims: Array.from({ length: 12 }, (_, i) => ({ ...peer.claims[0], pattern: `docs/f${i}.md` })),
    };
    const text = formatSessionContext({ repoKey: "k", owners: [many], cli: "dotbabel fleet" });
    expect(text).toContain("+4 more");
    expect(text).not.toContain("docs/f11.md");
  });

  it("leaves out claims that are no longer active", () => {
    const done = { ...peer, claims: [{ ...peer.claims[0], active: false }] };
    expect(formatSessionContext({ repoKey: "k", owners: [done], cli: "dotbabel fleet" })).toBe("");
  });
});

describe("formatBoard", () => {
  it("shows every owner, marks this session, and flags inactive claims", () => {
    const stale = { ...peer, claims: [...peer.claims, { ...peer.claims[0], pattern: "docs/old.md", active: false }] };
    const text = formatBoard({ repoKey: "github.com/x/y", owners: [stale, me], removed: 1, now: T0 });
    expect(text).toContain("github.com/x/y");
    expect(text).toContain("dotbabel-45");
    expect(text).toMatch(/kaiohenricunha-a9 \(you/);
    expect(text).toContain("fleet ledger");
    expect(text).toMatch(/docs\/old\.md.*worktree removed/);
    expect(text).toMatch(/1 claim record of an exited session/);
  });

  it("says so when there are no claims", () => {
    expect(formatBoard({ repoKey: "k", owners: [], removed: 0, now: T0 })).toMatch(/no claims/i);
  });
});
