// Behavior tests for how `dotbabel fleet` finds Claude Code sessions: the
// session registry (~/.claude/sessions/<pid>.json), process liveness, and
// self-identification. A fake /proc tree keeps the tests hermetic.

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { makeTempDir } from "./fixtures/temp-dir.mjs";
import {
  findSelf,
  isOwnerAlive,
  ownerFromEntry,
  parseProcStat,
  processState,
  readRegistry,
  sessionsDir,
} from "../src/fleet/registry.mjs";

// /proc/<pid>/stat: "pid (comm) state ppid ... starttime(field 22) ...".
function statLine(pid, comm, ppid, startTime) {
  const rest = ["S", String(ppid), ...Array.from({ length: 17 }, () => "0"), String(startTime), "0", "0"];
  return `${pid} (${comm}) ${rest.join(" ")}\n`;
}

function fakeProc(procs) {
  const root = makeTempDir("fleet-proc-");
  for (const { pid, comm = "node", ppid, startTime } of procs) {
    fs.mkdirSync(path.join(root, String(pid)));
    fs.writeFileSync(path.join(root, String(pid), "stat"), statLine(pid, comm, ppid, startTime));
  }
  return root;
}

function writeRegistry(entries, extras = {}) {
  const dir = makeTempDir("fleet-sessions-");
  for (const e of entries) fs.writeFileSync(path.join(dir, `${e.pid}.json`), JSON.stringify(e));
  for (const [name, body] of Object.entries(extras)) fs.writeFileSync(path.join(dir, name), body);
  return dir;
}

describe("sessionsDir", () => {
  it("follows CLAUDE_CONFIG_DIR, like Claude Code does", () => {
    expect(sessionsDir({ CLAUDE_CONFIG_DIR: "/cfg" }, "/home/me")).toBe(path.join("/cfg", "sessions"));
    expect(sessionsDir({}, "/home/me")).toBe(path.join("/home/me", ".claude", "sessions"));
  });
});

describe("parseProcStat", () => {
  it("reads the parent pid and the start time", () => {
    expect(parseProcStat(statLine(42, "node", 7, 231406))).toEqual({ ppid: 7, startTime: "231406" });
  });

  it("survives a command name with spaces and parentheses", () => {
    expect(parseProcStat(statLine(42, "my (odd) proc", 7, 99))).toEqual({ ppid: 7, startTime: "99" });
  });

  it("returns null for text that is not a stat line", () => {
    expect(parseProcStat("")).toBeNull();
    expect(parseProcStat("42 node S")).toBeNull();
  });
});

describe("readRegistry", () => {
  it("keeps valid entries and skips files it cannot use", () => {
    const dir = writeRegistry(
      [
        { pid: 10, sessionId: "a", procStart: "1", name: "one", status: "busy" },
        { pid: 11, sessionId: "b", procStart: "2", name: "two", status: "idle" },
      ],
      { "12.json": "{ not json", "13.json": JSON.stringify({ sessionId: "no-pid" }), "notes.txt": "hi" },
    );
    const { ok, entries } = readRegistry(dir);
    expect(ok).toBe(true);
    expect(entries.map((e) => e.pid).sort()).toEqual([10, 11]);
  });

  it("reports ok: false when the registry directory is missing", () => {
    expect(readRegistry(path.join(makeTempDir("fleet-none-"), "sessions"))).toEqual({ ok: false, entries: [] });
  });
});

describe("processState and isOwnerAlive", () => {
  const procRoot = fakeProc([{ pid: 500, ppid: 1, startTime: 555 }]);

  it("finds a running process and its start time", () => {
    expect(processState(500, { procRoot })).toEqual({ exists: true, ppid: 1, startTime: "555" });
    expect(processState(501, { procRoot })).toEqual({ exists: false, ppid: null, startTime: null });
  });

  it("treats a reused pid as a different, dead owner", () => {
    expect(isOwnerAlive({ pid: 500, procStart: "555" }, { procRoot })).toBe(true);
    expect(isOwnerAlive({ pid: 500, procStart: "556" }, { procRoot })).toBe(false);
    expect(isOwnerAlive({ pid: 501, procStart: "555" }, { procRoot })).toBe(false);
  });

  it("accepts a running owner with no recorded start time", () => {
    expect(isOwnerAlive({ pid: 500 }, { procRoot })).toBe(true);
  });

  it("falls back to signal 0 where there is no /proc", () => {
    const noProc = path.join(makeTempDir("fleet-noproc-"), "proc");
    const esrch = () => {
      throw Object.assign(new Error("no such process"), { code: "ESRCH" });
    };
    const eperm = () => {
      throw Object.assign(new Error("not permitted"), { code: "EPERM" });
    };
    expect(processState(7, { procRoot: noProc, kill: () => true }).exists).toBe(true);
    expect(processState(7, { procRoot: noProc, kill: eperm }).exists).toBe(true);
    expect(processState(7, { procRoot: noProc, kill: esrch }).exists).toBe(false);
  });
});

describe("findSelf", () => {
  const procRoot = fakeProc([
    { pid: 300, ppid: 200, startTime: 30 },
    { pid: 200, ppid: 100, startTime: 20 },
    { pid: 100, ppid: 1, startTime: 10 },
    { pid: 1, ppid: 0, startTime: 1 },
    { pid: 400, ppid: 1, startTime: 40 },
  ]);
  const entries = [
    { pid: 100, sessionId: "sess-claude", procStart: "10", name: "pane-a" },
    { pid: 400, sessionId: "sess-other", procStart: "40", name: "pane-b" },
  ];

  it("matches the hook's session_id to a live registry entry", () => {
    expect(findSelf({ entries, sessionId: "sess-other", procRoot })?.name).toBe("pane-b");
  });

  it("walks up the process tree when there is no session_id", () => {
    expect(findSelf({ entries, startPid: 300, procRoot })?.name).toBe("pane-a");
  });

  it("falls back to the process tree when the session_id is unknown", () => {
    expect(findSelf({ entries, sessionId: "sess-new", startPid: 300, procRoot })?.name).toBe("pane-a");
  });

  it("returns null outside any Claude Code session", () => {
    expect(findSelf({ entries, startPid: 1, procRoot })).toBeNull();
    expect(findSelf({ entries: [], sessionId: "x", startPid: 300, procRoot })).toBeNull();
  });

  it("ignores a registry entry whose process is gone", () => {
    const dead = [{ pid: 999, sessionId: "sess-dead", procStart: "9", name: "gone" }];
    expect(findSelf({ entries: dead, sessionId: "sess-dead", procRoot })).toBeNull();
  });

  it("stops on a cycle in the parent chain", () => {
    const loop = fakeProc([
      { pid: 20, ppid: 21, startTime: 1 },
      { pid: 21, ppid: 20, startTime: 1 },
    ]);
    expect(findSelf({ entries, startPid: 20, procRoot: loop })).toBeNull();
  });
});

describe("ownerFromEntry", () => {
  it("keys an owner by pid and start time, so a reused pid is a new owner", () => {
    expect(ownerFromEntry({ pid: 100, procStart: "10", sessionId: "s", name: "pane-a" })).toEqual({
      key: "100-10",
      pid: 100,
      procStart: "10",
      sessionId: "s",
      name: "pane-a",
    });
  });

  it("falls back to startedAt, then to 0, when procStart is missing", () => {
    expect(ownerFromEntry({ pid: 5, startedAt: 1790362641466 }).key).toBe("5-1790362641466");
    expect(ownerFromEntry({ pid: 5 }).key).toBe("5-0");
  });
});
