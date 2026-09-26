// Behavior tests for the event feed of `dotbabel fleet`: event files, the
// per-session seen marker, which merges matter to which session, the text a
// session reads, and the parser that spots a `gh pr merge` command.

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { makeTempDir } from "./fixtures/temp-dir.mjs";
import { ownClaimsByRepo, repoDir, writeOwnerRecord } from "../src/fleet/ledger.mjs";
import {
  EVENT_TTL_MS,
  deliverEvents,
  eventFromPr,
  eventName,
  formatEventContext,
  recordMerge,
  listEventNames,
  parseMergeCommand,
  readEvents,
  readSeen,
  relevantEvents,
  repoKeyFromPrUrl,
  writeEvent,
  writeSeen,
} from "../src/fleet/events.mjs";

const T0 = Date.parse("2026-09-26T12:00:00.000Z");
const REPO = "github.com/acme/widget";

function merge(overrides = {}) {
  return {
    schema: 1,
    type: "merge",
    repo: REPO,
    pr: 426,
    title: "feat(fleet): CPU lanes",
    base: "main",
    head: "feat/fleet-lanes",
    sha: "39b71272b8b1458fc8a411ced57d1fc1efce09d8",
    files: ["docs/hooks.md", "docs/cli-reference.md", "plugins/dotbabel/src/fleet/lanes.mjs"],
    filesTruncated: false,
    by: { key: "100-1", name: "merger-pane" },
    at: new Date(T0).toISOString(),
    ...overrides,
  };
}

describe("event files", () => {
  it("names events so that name order is time order", () => {
    expect(eventName(T0, 42)).toBe(`${String(T0).padStart(15, "0")}-42.json`);
    expect(eventName(9, 1) < eventName(10, 1)).toBe(true);
  });

  it("writes an event atomically and reads it back", () => {
    const root = makeTempDir("fleet-events-");
    const name = writeEvent(root, merge(), { now: T0, pid: 7 });
    expect(name).toBe(eventName(T0, 7));
    expect(fs.readdirSync(path.join(root, "events"))).toEqual([name]);
    expect(readEvents(root, [name])).toEqual([{ name, event: merge() }]);
  });

  it("lists only event files, in order", () => {
    const root = makeTempDir("fleet-events-");
    writeEvent(root, merge({ pr: 2 }), { now: T0 + 2, pid: 1 });
    writeEvent(root, merge({ pr: 1 }), { now: T0 + 1, pid: 1 });
    fs.writeFileSync(path.join(root, "events", "notes.txt"), "x");
    fs.writeFileSync(path.join(root, "events", ".tmp.json"), "x");
    expect(listEventNames(root)).toEqual([eventName(T0 + 1, 1), eventName(T0 + 2, 1)]);
    expect(listEventNames(path.join(root, "missing"))).toEqual([]);
  });

  it("skips malformed events and events of another schema", () => {
    const root = makeTempDir("fleet-events-");
    const good = writeEvent(root, merge(), { now: T0, pid: 1 });
    const bad = eventName(T0 + 1, 1);
    const other = eventName(T0 + 2, 1);
    fs.writeFileSync(path.join(root, "events", bad), "{");
    fs.writeFileSync(path.join(root, "events", other), JSON.stringify(merge({ schema: 99 })));
    expect(readEvents(root, [good, bad, other]).map((e) => e.name)).toEqual([good]);
  });

  it("prunes events older than the retention window when it writes", () => {
    const root = makeTempDir("fleet-events-");
    const old = writeEvent(root, merge({ pr: 1 }), { now: T0, pid: 1 });
    const fresh = writeEvent(root, merge({ pr: 2 }), { now: T0 + EVENT_TTL_MS + 1000, pid: 1 });
    expect(listEventNames(root)).toEqual([fresh]);
    expect(listEventNames(root)).not.toContain(old);
  });
});

describe("seen markers", () => {
  it("starts empty and round-trips", () => {
    const root = makeTempDir("fleet-events-");
    expect(readSeen(root, "sess-1")).toBeNull();
    writeSeen(root, "sess-1", eventName(T0, 1));
    expect(readSeen(root, "sess-1")).toBe(eventName(T0, 1));
  });

  it("refuses a session id that is not a plain token", () => {
    const root = makeTempDir("fleet-events-");
    expect(readSeen(root, "../etc")).toBeNull();
    expect(() => writeSeen(root, "../etc", "x")).toThrow(/session id/i);
  });
});

describe("repoKeyFromPrUrl", () => {
  it("maps a PR URL to the repo key the ledger uses", () => {
    expect(repoKeyFromPrUrl("https://github.com/Acme/widget/pull/426")).toBe("github.com/Acme/widget");
    expect(repoKeyFromPrUrl("not a url")).toBeNull();
    expect(repoKeyFromPrUrl("https://github.com/acme")).toBeNull();
  });
});

describe("parseMergeCommand", () => {
  it.each([
    ["gh pr merge 424 --squash --delete-branch --subject 'x (#424)' --body-file b.md", { target: "424", repo: null }],
    ["gh pr merge 426 --repo kaiohenricunha/dotbabel --squash", { target: "426", repo: "kaiohenricunha/dotbabel" }],
    ["gh pr merge -R acme/widget 9", { target: "9", repo: "acme/widget" }],
    ["gh pr merge https://github.com/acme/widget/pull/7", { target: "https://github.com/acme/widget/pull/7", repo: null }],
    ["gh pr merge --squash", { target: null, repo: null }],
    ["cd x && gh pr merge 5 --squash 2>&1 | tail -3", { target: "5", repo: null }],
    ["STRIP=1 gh pr merge 5 -t 'feat: y' -b body", { target: "5", repo: null }],
  ])("reads %j", (command, parsed) => {
    expect(parseMergeCommand(command)).toEqual(parsed);
  });

  it.each(["gh pr view 5", "echo 'gh pr merge 5'", "git merge main", "gh pr merge", "", null])(
    "finds no merge in %j unless it is a real gh pr merge",
    (command) => {
      const parsed = parseMergeCommand(command);
      if (command === "gh pr merge") expect(parsed).toEqual({ target: null, repo: null });
      else expect(parsed).toBeNull();
    },
  );
});

describe("relevantEvents", () => {
  const claims = (patterns, active = true) => patterns.map((pattern) => ({ pattern, active }));

  it("pairs each event with the files this session claims", () => {
    const items = relevantEvents([{ name: "a", event: merge() }], {
      selfKey: "200-2",
      claimsByRepo: { [REPO]: claims(["docs/hooks.md", "plugins/dotbabel/src/fleet"]) },
    });
    expect(items).toHaveLength(1);
    expect(items[0].overlap).toEqual(["docs/hooks.md", "plugins/dotbabel/src/fleet/lanes.mjs"]);
  });

  it("keeps an event with no overlap, so the session still learns main moved", () => {
    const items = relevantEvents([{ name: "a", event: merge() }], {
      selfKey: "200-2",
      claimsByRepo: { [REPO]: claims(["src/**"]) },
    });
    expect(items).toEqual([{ event: merge(), overlap: [] }]);
  });

  it("skips this session's own merges, other repos, and inactive claims", () => {
    const events = [
      { name: "own", event: merge({ by: { key: "200-2", name: "me" } }) },
      { name: "elsewhere", event: merge({ repo: "github.com/acme/other" }) },
    ];
    expect(relevantEvents(events, { selfKey: "200-2", claimsByRepo: { [REPO]: claims(["docs"]) } })).toEqual([]);
    const inactive = relevantEvents([{ name: "a", event: merge() }], {
      selfKey: "200-2",
      claimsByRepo: { [REPO]: claims(["docs/hooks.md"], false) },
    });
    expect(inactive).toEqual([]);
  });
});

describe("formatEventContext", () => {
  it("tells the session what merged, what it claims there, and to rebase", () => {
    const text = formatEventContext([{ event: merge(), overlap: ["docs/hooks.md"] }]);
    expect(text).toContain("#426");
    expect(text).toContain("feat(fleet): CPU lanes");
    expect(text).toContain("39b7127");
    expect(text).toContain(REPO);
    expect(text).toContain('"merger-pane"');
    expect(text).toContain("docs/hooks.md");
    expect(text).toMatch(/rebase/i);
    expect(text).toContain("git fetch origin && git rebase origin/main");
  });

  it("says so when none of the merged files are claimed here", () => {
    const text = formatEventContext([{ event: merge(), overlap: [] }]);
    expect(text).toMatch(/none of them/i);
    expect(text).not.toContain("git rebase");
  });

  it("caps long lists of events and files", () => {
    const files = Array.from({ length: 12 }, (_, i) => `f${i}.md`);
    const items = Array.from({ length: 7 }, (_, i) => ({ event: merge({ pr: i + 1, files }), overlap: files }));
    const text = formatEventContext(items);
    expect(text).toContain("+2 more merges");
    expect(text).toContain("+4 more");
    expect(text).not.toContain("f11.md");
  });

  it("uses the base branch of the merge", () => {
    const text = formatEventContext([{ event: merge({ base: "develop" }), overlap: ["docs/hooks.md"] }]);
    expect(text).toContain("git fetch origin && git rebase origin/develop");
  });
});

function pr(overrides = {}) {
  return {
    number: 426,
    title: "feat(fleet): CPU lanes",
    state: "MERGED",
    mergeCommit: { oid: "39b71272b8b1458fc8a411ced57d1fc1efce09d8" },
    baseRefName: "main",
    headRefName: "feat/fleet-lanes",
    files: [{ path: "docs/hooks.md" }, { path: "docs/cli-reference.md" }, { path: "plugins/dotbabel/src/fleet/lanes.mjs" }],
    url: "https://github.com/acme/widget/pull/426",
    ...overrides,
  };
}
const BY = { key: "100-1", name: "merger-pane" };

describe("eventFromPr", () => {
  it("builds a merge event from `gh pr view` JSON", () => {
    expect(eventFromPr(pr(), BY, T0)).toEqual(merge());
  });

  it.each([
    ["an open pull request", { state: "OPEN" }],
    ["a merge with no merge commit", { mergeCommit: null }],
    ["a URL with no repo", { url: "https://github.com/acme" }],
  ])("returns null for %s", (_, overrides) => {
    expect(eventFromPr(pr(overrides), BY, T0)).toBeNull();
  });

  it("caps a very long file list and says so", () => {
    const files = Array.from({ length: 600 }, (_, i) => ({ path: `f${i}` }));
    const event = eventFromPr(pr({ files }), null, T0);
    expect(event.files).toHaveLength(500);
    expect(event.filesTruncated).toBe(true);
    expect(event.by).toBeNull();
  });
});

describe("recordMerge", () => {
  it("records a merge once per repo, pull request, and merge commit", () => {
    const root = makeTempDir("fleet-events-");
    const first = recordMerge(root, pr(), { by: BY, now: T0, pid: 1 });
    expect(first.recorded).toBe(true);
    expect(recordMerge(root, pr(), { by: BY, now: T0 + 5, pid: 2 }).recorded).toBe(false);
    expect(listEventNames(root)).toEqual([first.name]);
  });

  it("records nothing for a pull request that is not merged", () => {
    const root = makeTempDir("fleet-events-");
    expect(recordMerge(root, pr({ state: "CLOSED" }), { by: BY, now: T0 })).toEqual({ recorded: false, reason: "not-merged" });
    expect(listEventNames(root)).toEqual([]);
  });
});

describe("deliverEvents", () => {
  const claimsByRepo = { [REPO]: [{ pattern: "docs/hooks.md", active: true }] };

  it("skips history on first contact, then delivers each new event once", () => {
    const root = makeTempDir("fleet-events-");
    writeEvent(root, merge({ pr: 1 }), { now: T0, pid: 1 });
    expect(deliverEvents(root, "sess-a", { selfKey: "200-2", claimsByRepo })).toBe("");
    writeEvent(root, merge({ pr: 2 }), { now: T0 + 1, pid: 1 });
    const text = deliverEvents(root, "sess-a", { selfKey: "200-2", claimsByRepo });
    expect(text).toContain("#2");
    expect(text).not.toContain("#1 ");
    expect(deliverEvents(root, "sess-a", { selfKey: "200-2", claimsByRepo })).toBe("");
  });

  it("advances the marker past events that do not matter to the session", () => {
    const root = makeTempDir("fleet-events-");
    deliverEvents(root, "sess-a", { selfKey: "200-2", claimsByRepo });
    const own = writeEvent(root, merge({ by: { key: "200-2", name: "me" } }), { now: T0, pid: 1 });
    expect(deliverEvents(root, "sess-a", { selfKey: "200-2", claimsByRepo })).toBe("");
    expect(readSeen(root, "sess-a")).toBe(own);
  });

  it("delivers nothing for an unsafe session id", () => {
    const root = makeTempDir("fleet-events-");
    expect(deliverEvents(root, "../x", { selfKey: "200-2", claimsByRepo })).toBe("");
  });
});

describe("ownClaimsByRepo", () => {
  it("collects this session's claims in every repo, with the active flag", () => {
    const root = makeTempDir("fleet-events-");
    const live = makeTempDir("fleet-events-wt-");
    const record = (key, repo, claims) => ({
      schema: 1,
      repo,
      owner: { key, pid: 1, procStart: "1", sessionId: "s", name: key },
      claims,
      updatedAt: new Date(T0).toISOString(),
    });
    writeOwnerRecord(repoDir(root, REPO), record("200-2", REPO, [
      { pattern: "docs/a.md", worktree: live },
      { pattern: "docs/b.md", worktree: `${live}-gone` },
    ]));
    writeOwnerRecord(repoDir(root, "github.com/acme/other"), record("200-2", "github.com/acme/other", [{ pattern: "x" }]));
    writeOwnerRecord(repoDir(root, REPO), record("300-3", REPO, [{ pattern: "not-mine" }]));
    expect(ownClaimsByRepo(root, "200-2")).toEqual({
      [REPO]: [
        { pattern: "docs/a.md", worktree: live, active: true },
        { pattern: "docs/b.md", worktree: `${live}-gone`, active: false },
      ],
      "github.com/acme/other": [{ pattern: "x", active: true }],
    });
  });
});
