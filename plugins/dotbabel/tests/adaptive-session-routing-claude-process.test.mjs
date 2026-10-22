import { expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { readClaudeVersion, startClaudeNative } from "../src/adaptive-session-routing/claude-launcher.mjs";

it("reads a bounded native version without starting an inference or exposing errors", async () => {
  const execute = vi.fn(async () => ({ stdout: "2.1.302 (Claude Code)\n" }));
  expect(await readClaudeVersion(execute)).toBe("2.1.302");
  expect(execute).toHaveBeenCalledExactlyOnceWith("claude", ["--version"], { timeout: 5000, maxBuffer: 4096 });
  await expect(readClaudeVersion(async () => { throw Error("private native failure"); })).rejects.toMatchObject({ code: "native_runtime_unavailable", message: "native_runtime_unavailable" });
  expect(await readClaudeVersion(async () => ({ stdout: "unknown runtime" }))).toBeUndefined();
});

it("preserves the native terminal, forwards termination once and leaves Ctrl-C with the terminal", async () => {
  const child = new EventEmitter(); child.kill = vi.fn();
  const before = Object.fromEntries(["SIGINT", "SIGTERM"].map(signal => [signal, process.listeners(signal)]));
  const spawn = vi.fn(() => child);
  const running = startClaudeNative({ args: ["--plugin-dir", "/private/plugin"], cwd: "/project" }, spawn);
  expect(spawn).toHaveBeenCalledExactlyOnceWith("claude", ["--plugin-dir", "/private/plugin"], { cwd: "/project", stdio: "inherit", shell: false });
  const added = signal => process.listeners(signal).filter(fn => !before[signal].includes(fn));
  for (const fn of added("SIGINT")) fn(); expect(child.kill).not.toHaveBeenCalled();
  for (const fn of added("SIGTERM")) fn(); expect(child.kill).toHaveBeenCalledExactlyOnceWith("SIGTERM");
  child.emit("close", 7, null); expect(await running).toBe(7);
  expect(added("SIGINT")).toEqual([]); expect(added("SIGTERM")).toEqual([]);
});
it.each([["SIGINT", 130], ["SIGTERM", 143], ["SIGKILL", 137]])("reports native termination %s without restarting", async (signal, expected) => {
  const child = new EventEmitter(); child.kill = vi.fn(); const spawn = vi.fn(() => child);
  const running = startClaudeNative({ args: [], cwd: "/project" }, spawn); child.emit("close", null, signal);
  expect(await running).toBe(expected); expect(spawn).toHaveBeenCalledTimes(1);
});
it("removes signal handlers and reports a sanitized native spawn failure", async () => {
  const child = new EventEmitter(); child.kill = vi.fn(); const before = process.listenerCount("SIGTERM");
  const running = startClaudeNative({ args: [], cwd: "/project" }, () => child);
  child.emit("error", Error("private system details"));
  await expect(running).rejects.toMatchObject({ code: "native_runtime_unavailable", message: "native_runtime_unavailable" });
  expect(process.listenerCount("SIGTERM")).toBe(before);
});

it.each([[" 12.34.567 ", "12.34.567"], ["12.34.567", "12.34.567"], ["banner 2.1.302", undefined], ["2.1.302suffix", undefined]])("requires an exact version prefix and token boundary: %s", async (stdout, expected) => {
  expect(await readClaudeVersion(async () => ({ stdout }))).toBe(expected);
});
