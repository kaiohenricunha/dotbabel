// Behavior tests for the fair CPU share of `dotbabel fleet`: each Claude Code
// session's systemd scope gets an equal CPUWeight, so a light session keeps its
// CPUs next to a heavy one. Unit tests for the helpers, and end-to-end tests of
// the SessionStart hook and `dotbabel-fleet cpu-share` with a fake systemctl
// and a fake /proc tree.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { makeTempDir } from "./fixtures/temp-dir.mjs";
import { cpuWeightSetting, sessionScope, setPropertyArgs } from "../src/fleet/cpushare.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.resolve(__dirname, "../bin/dotbabel-fleet.mjs");
const APP = "/user.slice/user-1000.slice/user@1000.service/app.slice";

describe("sessionScope", () => {
  it("finds the systemd scope of a session in the user manager's app.slice", () => {
    expect(sessionScope(`0::${APP}/tmux-spawn-33bc.scope\n`)).toEqual({
      path: `${APP}/tmux-spawn-33bc.scope`,
      unit: "tmux-spawn-33bc.scope",
    });
  });

  it.each([
    ["a system service", "0::/system.slice/docker.service\n"],
    ["the root cgroup", "0::/\n"],
    ["a user service that is not a scope", `0::${APP}/foo.service\n`],
    ["a scope outside app.slice", "0::/user.slice/user-1000.slice/session-3.scope\n"],
    ["cgroup v1 lines only", "12:cpu,cpuacct:/user.slice\n"],
    ["empty text", ""],
  ])("finds no scope for %s", (_label, text) => {
    expect(sessionScope(text)).toBeNull();
  });
});

describe("cpuWeightSetting", () => {
  it.each([
    [undefined, 100],
    ["", 100],
    ["300", 300],
    ["1", 1],
    ["10000", 10000],
  ])("reads %j as weight %j", (value, weight) => {
    expect(cpuWeightSetting({ DOTBABEL_FLEET_CPU_WEIGHT: value })).toBe(weight);
  });

  it.each(["off", "0", "10001", "-5", "abc", "1.5"])("turns the share off for %j", (value) => {
    expect(cpuWeightSetting({ DOTBABEL_FLEET_CPU_WEIGHT: value })).toBeNull();
  });
});

describe("setPropertyArgs", () => {
  it("sets the weight until the next boot only", () => {
    expect(setPropertyArgs("tmux-spawn-1.scope", 100)).toEqual([
      "--user",
      "set-property",
      "--runtime",
      "tmux-spawn-1.scope",
      "CPUWeight=100",
    ]);
  });
});

/** A fake /proc entry: stat with a start time, and a cgroup line. */
function fakeProc(root, pid, cgroupPath, start = "4242") {
  const dir = path.join(root, String(pid));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "stat"), `${pid} (claude) S 1 ${pid} ${pid} 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 ${start} 0 0\n`);
  fs.writeFileSync(path.join(dir, "cgroup"), `0::${cgroupPath}\n`);
}

function world() {
  const root = makeTempDir("fleet-cpushare-");
  const bin = path.join(root, "bin");
  const proc = path.join(root, "proc");
  const sessions = path.join(root, "cfg", "sessions");
  fs.mkdirSync(bin);
  fs.mkdirSync(sessions, { recursive: true });
  const log = path.join(root, "systemctl.log");
  fs.writeFileSync(path.join(bin, "systemctl"), `#!/bin/sh\necho "$*" >>"${log}"\n`, { mode: 0o755 });
  const env = {
    ...process.env,
    PATH: `${bin}${path.delimiter}${process.env.PATH}`,
    CLAUDE_CONFIG_DIR: path.join(root, "cfg"),
    DOTBABEL_FLEET_STATE_DIR: path.join(root, "state"),
    DOTBABEL_FLEET_PROC_ROOT: proc,
  };
  delete env.DOTBABEL_FLEET_CPU_WEIGHT;
  const calls = () => (fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean) : []);
  const run = (args, { input = "", extra = {} } = {}) =>
    spawnSync(process.execPath, [BIN, ...args], { env: { ...env, ...extra }, input, encoding: "utf8", cwd: root });
  return { root, proc, sessions, calls, run };
}

describe("SessionStart: the session's own scope gets the weight", () => {
  it("sets CPUWeight=100 on the scope of the hook's parent session", () => {
    const w = world();
    fakeProc(w.proc, "self", `${APP}/tmux-spawn-abc.scope`);
    const r = w.run(["hook", "session-start"], { input: "{}" });
    expect(r.status).toBe(0);
    expect(w.calls()).toEqual(["--user set-property --runtime tmux-spawn-abc.scope CPUWeight=100"]);
  });

  it("uses DOTBABEL_FLEET_CPU_WEIGHT, and does nothing when it is off", () => {
    const w = world();
    fakeProc(w.proc, "self", `${APP}/tmux-spawn-abc.scope`);
    w.run(["hook", "session-start"], { input: "{}", extra: { DOTBABEL_FLEET_CPU_WEIGHT: "300" } });
    w.run(["hook", "session-start"], { input: "{}", extra: { DOTBABEL_FLEET_CPU_WEIGHT: "off" } });
    expect(w.calls()).toEqual(["--user set-property --runtime tmux-spawn-abc.scope CPUWeight=300"]);
  });

  it("does nothing outside a user app scope, and exits 0 when systemctl fails", () => {
    const w = world();
    fakeProc(w.proc, "self", "/system.slice/docker.service");
    expect(w.run(["hook", "session-start"], { input: "{}" }).status).toBe(0);
    expect(w.calls()).toEqual([]);
    const v = world();
    fakeProc(v.proc, "self", `${APP}/tmux-spawn-abc.scope`);
    const r = v.run(["hook", "session-start"], { input: "{}", extra: { PATH: "/nonexistent" } });
    expect(r.status).toBe(0);
  });
});

describe("dotbabel-fleet cpu-share", () => {
  function register(w, pid, name, cgroupPath) {
    fakeProc(w.proc, pid, cgroupPath);
    fs.writeFileSync(
      path.join(w.sessions, `${pid}.json`),
      JSON.stringify({ pid, sessionId: `s-${pid}`, procStart: "4242", name, status: "idle" }),
    );
  }

  it("applies the weight to the scope of every live session, once per scope", () => {
    const w = world();
    register(w, 101, "pane-a", `${APP}/tmux-spawn-a.scope`);
    register(w, 102, "pane-b", `${APP}/tmux-spawn-b.scope`);
    register(w, 103, "pane-docker", "/system.slice/docker.service");
    fs.writeFileSync(path.join(w.sessions, "999.json"), JSON.stringify({ pid: 999, procStart: "1", name: "gone" }));
    const r = w.run(["cpu-share", "--json"]);
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.weight).toBe(100);
    expect(out.sessions.map((s) => [s.name, s.unit, s.applied])).toEqual([
      ["pane-a", "tmux-spawn-a.scope", true],
      ["pane-b", "tmux-spawn-b.scope", true],
      ["pane-docker", null, false],
    ]);
    expect(w.calls().sort()).toEqual([
      "--user set-property --runtime tmux-spawn-a.scope CPUWeight=100",
      "--user set-property --runtime tmux-spawn-b.scope CPUWeight=100",
    ]);
  });

  it("only reports with --status, and says when the share is off", () => {
    const w = world();
    register(w, 101, "pane-a", `${APP}/tmux-spawn-a.scope`);
    const r = w.run(["cpu-share", "--status"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("pane-a");
    expect(w.calls()).toEqual([]);
    const off = w.run(["cpu-share"], { extra: { DOTBABEL_FLEET_CPU_WEIGHT: "off" } });
    expect(off.status).toBe(0);
    expect(off.stdout).toMatch(/off/i);
    expect(w.calls()).toEqual([]);
  });
});
