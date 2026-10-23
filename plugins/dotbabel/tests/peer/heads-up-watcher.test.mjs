import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { makeTempDir } from "../fixtures/temp-dir.mjs";
import { PeerStore } from "../../src/peer/store.mjs";
import { registerMain, pairAdvisor } from "../../src/peer/state.mjs";
import { tick } from "../../src/peer/relay.mjs";
import {
  MEASURED_CLAUDE_VERSIONS,
  attribute,
  claudeVersion,
  createHeadsUpWatcher,
  headsUpStatus,
  openOffers,
  readHeadsUpMode,
  readStore,
  storeFile,
} from "../../src/peer/heads-up-store.mjs";

const MAIN = "11111111-1111-4111-8111-111111111111",
  ADVISOR = "22222222-2222-4222-8222-222222222222",
  OTHER = "33333333-3333-4333-8333-333333333333";
const turn = (n) => `0000000${n}-0000-4000-8000-000000000000`;
const ORIGIN = {
  forwardedBy: "the relay watcher",
  main: "claude:11111111",
  repo: "repo",
  worktree: "/w",
  head: "abc1234",
  tree: "clean",
};
const closed = (id, t, tag = "Heads up") => ({ id, askedTurn: t, offeredTurn: t, tag });
const offer = (id, t, line, explanation = "Why it matters.", tag = "Heads up") => ({
  ...closed(id, t, tag),
  view: { kind: "offer", line, explanation, shownAt: 1760000000000 },
});
const doc = (sessions = [], seen = []) => ({
  sessions,
  seen,
  known: [],
  typedPastInARow: 0,
  looksToSkip: 0,
});

function config() {
  const dir = makeTempDir("peer-hu-config-");
  const env = { CLAUDE_CONFIG_DIR: dir };
  const file = storeFile(env);
  const write = (document) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, typeof document === "string" ? document : JSON.stringify(document));
  };
  return { dir, env, file, write };
}

async function world({ mainHarness = "claude", mainVersion = "2.1.309" } = {}) {
  const store = new PeerStore(makeTempDir("peer-hu-ledger-"), "repo");
  const main = {
    harness: mainHarness,
    sessionId: MAIN,
    key: `${mainHarness}:${MAIN}`,
    repo: "repo",
    worktree: "/w",
    version: mainVersion,
  };
  const advisor = { harness: "claude", sessionId: ADVISOR, key: `claude:${ADVISOR}`, repo: "repo" };
  let id;
  await store.transaction((s) => {
    const p = registerMain(s, main, { alive: () => true });
    id = p.id;
    pairAdvisor(s, advisor, p.code, { alive: () => true });
  });
  return { store, id };
}

function watcherFor(env, overrides = {}) {
  const calls = { version: 0 };
  let mode = { mode: "enqueue" };
  const watcher = createHeadsUpWatcher({
    env,
    version: () => {
      calls.version++;
      return overrides.version ?? "2.1.309";
    },
    readMode: () => mode,
    origin: () => ORIGIN,
    ...overrides.options,
  });
  return { watcher, calls, setMode: (m) => (mode = m) };
}

const quiet = { alive: () => false, transport: async () => ({ state: "transport_accepted" }) };
async function run(store, id, watcher) {
  await tick(store, id, { ...quiet, watcher });
  return (await store.read()).pairs.find((p) => p.id === id);
}

describe("store reader", () => {
  it("locates the store under CLAUDE_CONFIG_DIR or ~/.claude", () => {
    expect(storeFile({ CLAUDE_CONFIG_DIR: "/c" }, "/h")).toBe(
      "/c/plugins/store/cc-plugin-you-should-know_builtin-19776595df2c.json",
    );
    expect(storeFile({}, "/h")).toBe(
      "/h/.claude/plugins/store/cc-plugin-you-should-know_builtin-19776595df2c.json",
    );
  });

  it("returns an open offer and nothing for a closed record", () => {
    const { file, write } = config();
    write(doc([offer(MAIN, turn(1), "The cache may be stale."), closed(OTHER, turn(2))], ["x"]));
    const read = readStore(file);
    expect(read.state).toBe("ok");
    expect(openOffers(read.snapshot)).toEqual([
      {
        sessionId: MAIN,
        offeredTurn: turn(1),
        tag: "Heads up",
        line: "The cache may be stale.",
        explanation: "Why it matters.",
        shownAt: 1760000000000,
      },
    ]);
    write(doc([closed(MAIN, turn(1)), { id: OTHER, askedTurn: turn(3) }], ["x"]));
    expect(openOffers(readStore(file).snapshot)).toEqual([]);
  });

  it("reports a missing file, refuses a symlink and an oversized file, and retries partial JSON", () => {
    const { dir, file, write } = config();
    expect(readStore(file).state).toBe("store_missing");
    const real = path.join(dir, "real.json");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(real, JSON.stringify(doc()));
    fs.symlinkSync(real, file);
    expect(readStore(file).state).toBe("unknown_format");
    fs.rmSync(file);
    write(" ".repeat(1024 * 1024 + 1));
    expect(readStore(file).state).toBe("unknown_format");
    write('{"sessions": [');
    expect(readStore(file).state).toBe("unreadable");
    fs.rmSync(file);
    fs.mkdirSync(file);
    expect(readStore(file).state).toBe("unknown_format");
  });

  it.each([
    ["an extra top-level key", { ...doc(), extra: 1 }],
    ["an array document", []],
    ["sessions that are not an array", { ...doc(), sessions: {} }],
    ["seen that is not an array of strings", doc([], [1])],
    [
      "seen longer than 50",
      doc(
        [],
        Array.from({ length: 51 }, (_, n) => `l${n}`),
      ),
    ],
    ["known that is not an array", { ...doc(), known: "x" }],
    ["a counter that is not a number", { ...doc(), looksToSkip: "1" }],
    ["a session with an extra key", doc([{ ...closed(MAIN, turn(1)), extra: 1 }])],
    ["a session id that is not a UUID", doc([closed("main", turn(1))])],
    ["a turn that is not a UUID", doc([closed(MAIN, "t1")])],
    ["an unknown tag", doc([closed(MAIN, turn(1), "Tip")])],
    [
      "an offered turn without a tag",
      doc([{ id: MAIN, askedTurn: turn(1), offeredTurn: turn(1) }]),
    ],
    ["duplicate session ids", doc([closed(MAIN, turn(1)), closed(MAIN, turn(2))])],
    ["a view without a kind", doc([{ ...closed(MAIN, turn(1)), view: {} }])],
    [
      "an offer with an extra key",
      doc([{ ...offer(MAIN, turn(1), "l"), view: { ...offer(MAIN, turn(1), "l").view, x: 1 } }]),
    ],
    [
      "an offer without an explanation",
      doc([{ ...closed(MAIN, turn(1)), view: { kind: "offer", line: "l", shownAt: 1 } }]),
    ],
    ["an offer with an empty line", doc([offer(MAIN, turn(1), "")])],
    [
      "an offer without an offered turn",
      doc([
        { id: MAIN, askedTurn: turn(1), tag: "Heads up", view: offer(MAIN, turn(1), "l").view },
      ]),
    ],
  ])("refuses %s as unknown_format", (_, document) => {
    const { file, write } = config();
    write(document);
    expect(readStore(file).state).toBe("unknown_format");
  });

  it("accepts a view of another kind and only reads offers", () => {
    const { file, write } = config();
    write(doc([{ ...closed(MAIN, turn(1)), view: { kind: "explaining", anything: true } }]));
    const read = readStore(file);
    expect(read.state).toBe("ok");
    expect(openOffers(read.snapshot)).toEqual([]);
  });
});

describe("fallback attribution", () => {
  const snap = (sessions, seen) => ({ sessions, seen });
  it("attributes one new line to the one session whose offered turn changed", () => {
    const prev = snap([closed(MAIN, turn(1)), closed(OTHER, turn(2))], ["a"]);
    expect(
      attribute(prev, snap([closed(MAIN, turn(3)), closed(OTHER, turn(2))], ["a", "b"])),
    ).toEqual({
      kind: "single",
      sessionId: MAIN,
      offeredTurn: turn(3),
      tag: "Heads up",
      line: "b",
    });
    // A new session record counts as a change; a full window slides by one.
    const full = Array.from({ length: 50 }, (_, n) => `l${n}`);
    expect(
      attribute(snap([], full), snap([closed(OTHER, turn(4))], [...full.slice(1), "new"])),
    ).toEqual({
      kind: "single",
      sessionId: OTHER,
      offeredTurn: turn(4),
      tag: "Heads up",
      line: "new",
    });
  });

  it("waits for the record after the line, and refuses two changes", () => {
    const prev = snap([closed(MAIN, turn(1)), closed(OTHER, turn(2))], ["a"]);
    expect(attribute(prev, snap(prev.sessions, ["a", "b"]))).toEqual({ kind: "pending" });
    expect(attribute(prev, prev)).toEqual({ kind: "none" });
    expect(
      attribute(prev, snap([closed(MAIN, turn(3)), closed(OTHER, turn(4))], ["a", "b"])),
    ).toEqual({ kind: "ambiguous", sessions: [MAIN, OTHER] });
    expect(
      attribute(prev, snap([closed(MAIN, turn(3)), closed(OTHER, turn(2))], ["a", "b", "c"])),
    ).toEqual({ kind: "ambiguous", sessions: [MAIN] });
  });
});

describe("relay watcher", () => {
  it("forwards a Main offer once, through the heads-up path", async () => {
    const { env, write } = config();
    const { store, id } = await world();
    const { watcher } = watcherFor(env);
    write(
      doc(
        [offer(MAIN, turn(1), "The retry loop may charge twice.")],
        ["The retry loop may charge twice."],
      ),
    );
    await run(store, id, watcher);
    const p = await run(store, id, watcher);
    expect(p.requests).toHaveLength(1);
    const [r] = p.requests;
    expect(r.body).toContain("Source: claude-you-should-know (Heads up)");
    expect(r.body).toContain("Forwarded by: the relay watcher");
    expect(r.body).toMatch(/\nNote:\nThe retry loop may charge twice\.\nWhy it matters\.$/);
    expect(p.heads_up).toEqual({
      mode: "enqueue",
      state: "watching",
      claudeVersion: "2.1.309",
      forwarded: 1,
      ambiguous: 0,
    });
  });

  it("ignores Advisor and unpaired offers", async () => {
    const { env, write } = config();
    const { store, id } = await world();
    const { watcher } = watcherFor(env);
    write(doc([offer(ADVISOR, turn(1), "advisor note"), offer(OTHER, turn(2), "other note")]));
    expect((await run(store, id, watcher)).requests).toEqual([]);
  });

  it("forwards a note that closed between ticks through the fallback, without its explanation", async () => {
    const { env, write } = config();
    const { store, id } = await world();
    const { watcher } = watcherFor(env);
    write(doc([closed(MAIN, turn(1)), closed(OTHER, turn(2))], ["old"]));
    expect((await run(store, id, watcher)).requests).toEqual([]);
    write(
      doc(
        [closed(MAIN, turn(3), "You should know"), closed(OTHER, turn(2))],
        ["old", "Closed fast."],
      ),
    );
    const p = await run(store, id, watcher);
    expect(p.requests).toHaveLength(1);
    expect(p.requests[0].body).toContain("Source: claude-you-should-know (You should know)");
    expect(p.requests[0].body).toMatch(/\nNote:\nClosed fast\.$/);
  });

  it("counts two changed sessions as ambiguous and forwards nothing", async () => {
    const { env, write } = config();
    const { store, id } = await world();
    const { watcher } = watcherFor(env);
    write(doc([closed(MAIN, turn(1)), closed(OTHER, turn(2))], ["old"]));
    await run(store, id, watcher);
    write(doc([closed(MAIN, turn(3)), closed(OTHER, turn(4))], ["old", "Which one?"]));
    await run(store, id, watcher);
    const p = await run(store, id, watcher);
    expect(p.requests).toEqual([]);
    expect(p.heads_up.ambiguous).toBe(1);
    // An ambiguous change in other sessions only is not counted.
    write(
      doc(
        [closed(MAIN, turn(3)), closed(OTHER, turn(5)), closed(ADVISOR, turn(6))],
        ["old", "Which one?", "n"],
      ),
    );
    expect((await run(store, id, watcher)).heads_up.ambiguous).toBe(1);
  });

  it("queues the two ordered store writes once", async () => {
    const { env, write } = config();
    const { store, id } = await world();
    const { watcher } = watcherFor(env);
    write(doc([closed(MAIN, turn(1))], ["old"]));
    await run(store, id, watcher);
    write(doc([closed(MAIN, turn(1))], ["old", "Two writes."]));
    expect((await run(store, id, watcher)).requests).toEqual([]);
    write(doc([offer(MAIN, turn(2), "Two writes.")], ["old", "Two writes."]));
    await run(store, id, watcher);
    write(doc([closed(MAIN, turn(2))], ["old", "Two writes."]));
    const p = await run(store, id, watcher);
    expect(p.requests).toHaveLength(1);
    expect(p.requests[0].body).toContain("Two writes.\nWhy it matters.");
  });

  it("returns the first request for the same text with a new offered turn", async () => {
    const { env, write } = config();
    const { store, id } = await world();
    const { watcher } = watcherFor(env);
    write(doc([offer(MAIN, turn(1), "Same note.")], ["Same note."]));
    await run(store, id, watcher);
    write(doc([offer(MAIN, turn(2), "Same note.")], ["Same note.", "Same note."]));
    const p = await run(store, id, watcher);
    expect(p.requests).toHaveLength(1);
    expect(p.heads_up.forwarded).toBe(1);
  });

  it("does not replay closed notes after a relay restart, and keeps the count", async () => {
    const { env, write } = config();
    const { store, id } = await world();
    write(doc([offer(MAIN, turn(1), "Still open.")], ["Still open."]));
    await run(store, id, watcherFor(env).watcher);
    write(
      doc(
        [closed(MAIN, turn(1)), closed(OTHER, turn(2))],
        ["Still open.", "Closed before restart."],
      ),
    );
    const restarted = watcherFor(env).watcher;
    await run(store, id, restarted);
    const p = await run(store, id, restarted);
    expect(p.requests).toHaveLength(1);
    expect(p.heads_up.forwarded).toBe(1);
    // An offer still open at the restart dedupes to its first request.
    write(doc([offer(MAIN, turn(1), "Still open.")], ["Still open."]));
    expect((await run(store, id, watcherFor(env).watcher)).requests).toHaveLength(1);
  });

  it("does nothing when the setting is absent or off, and stops when it is removed", async () => {
    const { env, write } = config();
    const { store, id } = await world();
    const { watcher, calls, setMode } = watcherFor(env);
    setMode({ mode: "off" });
    write(doc([offer(MAIN, turn(1), "Not forwarded.")]));
    const p = await run(store, id, watcher);
    expect(p.requests).toEqual([]);
    expect(p.heads_up).toBeUndefined();
    expect(calls.version).toBe(0);
    setMode({ mode: "enqueue" });
    expect((await run(store, id, watcher)).requests).toHaveLength(1);
    setMode({ mode: "off" });
    write(doc([offer(MAIN, turn(2), "Next note.")]));
    const off = await run(store, id, watcher);
    expect(off.requests).toHaveLength(1);
    expect(off.heads_up).toMatchObject({ mode: "off", state: "off", forwarded: 1 });
  });

  it("reports an invalid setting as off with a diagnostic", async () => {
    const { env, write } = config();
    const { store, id } = await world();
    const { watcher, setMode } = watcherFor(env);
    write(doc([offer(MAIN, turn(1), "x")]));
    await run(store, id, watcher);
    setMode({ mode: "off", diagnostic: "invalid peer.heads_up.mode in .dotbabel.json" });
    expect((await run(store, id, watcher)).heads_up).toMatchObject({
      mode: "off",
      state: "off",
      diagnostic: "invalid peer.heads_up.mode in .dotbabel.json",
    });
  });

  it("forwards nothing on an unmeasured version and reads the version once", async () => {
    const { env, write } = config();
    const { store, id } = await world();
    const { watcher, calls } = watcherFor(env, { version: "2.1.300" });
    write(doc([offer(MAIN, turn(1), "x")]));
    await run(store, id, watcher);
    const p = await run(store, id, watcher);
    expect(p.requests).toEqual([]);
    expect(p.heads_up).toMatchObject({ state: "unsupported_version", claudeVersion: "2.1.300" });
    expect(calls.version).toBe(1);
    expect(MEASURED_CLAUDE_VERSIONS).toEqual(["2.1.307", "2.1.309"]);
  });

  it("refuses a Main that runs an unmeasured version or is not Claude Code", async () => {
    const { env, write } = config();
    write(doc([offer(MAIN, turn(1), "x")]));
    const older = await world({ mainVersion: "2.1.200" });
    const p = await run(older.store, older.id, watcherFor(env).watcher);
    expect(p.requests).toEqual([]);
    expect(p.heads_up.state).toBe("unsupported_version");
    expect(p.heads_up.diagnostic).toMatch(/Main runs Claude Code 2\.1\.200/);
    const codex = await world({ mainHarness: "codex" });
    const q = await run(codex.store, codex.id, watcherFor(env).watcher);
    expect(q.requests).toEqual([]);
    expect(q.heads_up).toMatchObject({
      state: "off",
      diagnostic: "Main is not a Claude Code session",
    });
  });

  it("reports a missing or unknown store, and skips an unreadable read", async () => {
    const { env, file, write } = config();
    const { store, id } = await world();
    const { watcher } = watcherFor(env);
    expect((await run(store, id, watcher)).heads_up.state).toBe("store_missing");
    write({ wrong: true });
    expect((await run(store, id, watcher)).heads_up.state).toBe("unknown_format");
    write(doc([offer(MAIN, turn(1), "x")]));
    expect((await run(store, id, watcher)).heads_up.state).toBe("watching");
    fs.writeFileSync(file, "{");
    const p = await run(store, id, watcher);
    expect(p.heads_up.state).toBe("watching");
    expect(p.requests).toHaveLength(1);
  });

  it("never stops the relay when the watcher fails", async () => {
    const { env, write } = config();
    const { store, id } = await world();
    write(doc([offer(MAIN, turn(1), "x")]));
    const broken = watcherFor(env, {
      options: {
        origin: () => {
          throw new Error("git failed");
        },
      },
    }).watcher;
    expect(await tick(store, id, { ...quiet, watcher: broken })).toBe(true);
    const throwing = {
      prepare: () => {
        throw new Error("boom");
      },
      apply: () => {
        throw new Error("boom");
      },
    };
    expect(await tick(store, id, { ...quiet, watcher: throwing })).toBe(true);
    expect((await store.read()).pairs[0].requests).toEqual([]);
  });

  it("records a note that cannot be queued without retrying it each tick", async () => {
    const { env, write } = config();
    const { store, id } = await world();
    const { watcher } = watcherFor(env);
    write(doc([offer(MAIN, turn(1), "x", "y".repeat(16384))]));
    const p = await run(store, id, watcher);
    expect(p.requests).toEqual([]);
    expect(p.heads_up.diagnostic).toBe("a note could not be queued");
    expect(JSON.stringify(p.heads_up)).not.toContain("yyyy");
  });
});

describe("setting reader and status", () => {
  const project = (text) => {
    const dir = makeTempDir("peer-hu-project-");
    if (text !== undefined) fs.writeFileSync(path.join(dir, ".dotbabel.json"), text);
    return dir;
  };

  it("reads peer.heads_up.mode from .dotbabel.json and fails closed", () => {
    expect(readHeadsUpMode(project())).toEqual({ mode: "off" });
    expect(readHeadsUpMode(project("{}"))).toEqual({ mode: "off" });
    expect(readHeadsUpMode(project('{"peer":{"heads_up":{"mode":"off"}}}'))).toEqual({
      mode: "off",
    });
    expect(
      readHeadsUpMode(project('{"peer":{"heads_up":{"mode":"enqueue"}},"fan_out":[]}')),
    ).toEqual({
      mode: "enqueue",
    });
    for (const bad of [
      '{"peer":{"heads_up":{"mode":"confirm"}}}',
      '{"peer":{"heads_up":{"mode":"enqueue","x":1}}}',
      '{"peer":[]}',
      "{",
      "[]",
      " ".repeat(1024 * 1024 + 1),
    ])
      expect(readHeadsUpMode(project(bad))).toEqual({
        mode: "off",
        diagnostic: "invalid or unreadable peer.heads_up in .dotbabel.json; the watcher is off",
      });
    const linked = project();
    fs.writeFileSync(path.join(linked, "real.json"), '{"peer":{"heads_up":{"mode":"enqueue"}}}');
    fs.symlinkSync(path.join(linked, "real.json"), path.join(linked, ".dotbabel.json"));
    expect(readHeadsUpMode(linked).mode).toBe("off");
  });

  it("shows the watcher fields with the current setting and never the note text", () => {
    const on = project('{"peer":{"heads_up":{"mode":"enqueue"}}}');
    const stored = {
      mode: "enqueue",
      state: "watching",
      claudeVersion: "2.1.309",
      forwarded: 2,
      ambiguous: 1,
    };
    expect(headsUpStatus({ main: { worktree: on }, heads_up: stored })).toEqual(stored);
    expect(headsUpStatus({ main: { worktree: on } })).toEqual({
      mode: "enqueue",
      state: "off",
      claudeVersion: null,
      forwarded: 0,
      ambiguous: 0,
    });
    // Removing the setting shows off at once, before the relay's next tick.
    expect(headsUpStatus({ main: { worktree: project() }, heads_up: stored })).toEqual({
      ...stored,
      mode: "off",
      state: "off",
    });
    expect(headsUpStatus({ main: { worktree: project("{") } }).diagnostic).toMatch(/invalid/);
  });

  it("reads the Claude Code version without a shell and refuses odd output", () => {
    const seen = [];
    const run = (out) => (file, args, opts) => {
      seen.push([file, args, opts.shell, opts.timeout]);
      if (out instanceof Error) throw out;
      return out;
    };
    expect(claudeVersion(run("2.1.309 (Claude Code)\n"))).toBe("2.1.309");
    expect(seen[0]).toEqual(["claude", ["--version"], false, 5000]);
    expect(claudeVersion(run("2.1.309"))).toBeNull();
    expect(claudeVersion(run("v2.1.309 (Claude Code)"))).toBeNull();
    expect(claudeVersion(run(new Error("ENOENT")))).toBeNull();
  });
});
