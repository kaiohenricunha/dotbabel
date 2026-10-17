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
import {
  HOST_CAPABILITIES,
  SUPPORT_STATES,
  describeHostAdapter,
  hostAdapter,
  isSupported,
  listHostAdapters,
} from "../src/fleet/host-adapter.mjs";
import { RUNTIMES } from "../src/agents.mjs";

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


describe("host adapters", () => {
  it("the Claude Code host adapter reports identity and liveness as supported", () => {
    const claude = hostAdapter("claude");
    expect(claude.host).toBe("claude");
    expect(claude.adapter).toBe(true);
    expect(claude.capabilities.identity.support).toBe("supported");
    expect(claude.capabilities.liveness.support).toBe("supported");
    for (const name of HOST_CAPABILITIES) expect(isSupported(claude.capabilities[name].support)).toBe(true);
    // The adapter binds the session registry and the liveness check this module already has.
    const procRoot = fakeProc([{ pid: 100, ppid: 1, startTime: 5 }]);
    const dir = writeRegistry([{ pid: 100, procStart: "5", sessionId: "s-1", name: "one" }]);
    const env = { CLAUDE_CONFIG_DIR: path.dirname(dir) };
    fs.renameSync(dir, path.join(path.dirname(dir), "sessions"));
    expect(claude.identity({ sessionId: "s-1", env, procRoot })?.pid).toBe(100);
    expect(claude.identity({ sessionId: "s-2", env, procRoot })).toBe(null);
    expect(claude.isAlive({ pid: 100, procStart: "5" }, { procRoot })).toBe(true);
    expect(claude.isAlive({ pid: 100, procStart: "6" }, { procRoot })).toBe(false);
  });

  it("a host without an adapter reports every capability as unsupported", () => {
    for (const id of ["codex", "gemini", "antigravity", "opencode", "copilot", "not-a-cli", ""]) {
      const host = hostAdapter(id);
      expect(host.adapter).toBe(false);
      expect(Object.keys(host.capabilities).sort()).toEqual([...HOST_CAPABILITIES].sort());
      for (const name of HOST_CAPABILITIES) {
        expect(host.capabilities[name].support).toBe("unsupported");
        expect(isSupported(host.capabilities[name].support)).toBe(false);
      }
      expect(host.identity).toBe(null);
      expect(host.isAlive).toBe(null);
    }
    expect(hostAdapter("codex").label).toBe("Codex");
    expect(hostAdapter("not-a-cli").label).toBe("not-a-cli");
  });

  it("unverified never counts as supported (ARCH-4)", () => {
    expect(SUPPORT_STATES).toEqual(["supported", "unsupported", "unverified"]);
    expect(isSupported("supported")).toBe(true);
    expect(isSupported("unverified")).toBe(false);
    expect(isSupported("unsupported")).toBe(false);
    expect(isSupported("yes")).toBe(false);
  });

  it("every descriptor names the six capabilities in the operation-capability shape", () => {
    const hosts = listHostAdapters();
    expect(hosts.map((h) => h.host)).toEqual(Object.keys(RUNTIMES));
    expect(HOST_CAPABILITIES).toEqual(["identity", "liveness", "preEdit", "preBash", "postTool", "sessionStart"]);
    for (const host of hosts) {
      expect(Object.keys(host.capabilities)).toEqual([...HOST_CAPABILITIES]);
      for (const cap of Object.values(host.capabilities)) {
        expect(SUPPORT_STATES).toContain(cap.support);
        expect(["never", "optional", "required"]).toContain(cap.network);
        expect(["none", "optional-existing", "required-existing"]).toContain(cap.auth);
        expect(typeof cap.cacheable).toBe("boolean");
        expect(["read-only", "may-execute-model"]).toContain(cap.execution);
        expect(cap.evidence).toMatch(/\S/);
      }
    }
  });

  it("describes an adapter in one line for the doctor", () => {
    expect(describeHostAdapter(hostAdapter("claude"))).toBe(
      "host claude (Claude): identity supported, liveness supported, preEdit supported, preBash supported, postTool supported, sessionStart supported",
    );
    expect(describeHostAdapter(hostAdapter("codex"))).toBe(
      "host codex (Codex): every capability unsupported — no host adapter yet, so the fleet is off for this host",
    );
  });
});
