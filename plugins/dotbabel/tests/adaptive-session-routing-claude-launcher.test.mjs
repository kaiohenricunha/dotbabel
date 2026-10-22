import { expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { runClaudeTerminal } from "../src/adaptive-session-routing/claude-launcher.mjs";

const enabled = async () => ({ enabled: true, routingEnabled: true });
it("opens the native UI with a private temporary plugin and exactly the user's native axes", async () => {
  let plugin;
  const startNative = vi.fn(async ({ args, cwd }) => {
    expect(cwd).toBe("/project");
    expect(args.slice(-4)).toEqual(["--model", "opaque-native-selector", "--effort", "high"]);
    expect(args).not.toContain("--permission-mode"); expect(args).not.toContain("--dangerously-skip-permissions");
    plugin = args[1]; expect(fs.statSync(plugin).mode & 0o777).toBe(0o700);
    expect(JSON.parse(fs.readFileSync(path.join(plugin, ".claude-plugin/plugin.json"))).name).toBe("dotbabel-adaptive-session-routing");
    const entry = fs.readFileSync(path.join(plugin, "hooks/register.js"), "utf8");
    expect(entry).toContain('"source":"manual"'); expect(entry).not.toContain("ANTHROPIC_API_KEY");
    expect(fs.existsSync(path.join(plugin, "hooks/claude-mod-prepare.mjs"))).toBe(true);
    return 7;
  });
  const code = await runClaudeTerminal({ repoRoot: "/project", model: "opaque-native-selector", effort: "high" }, { readActivation: enabled, runtimeVersion: async () => "2.1.302", startNative });
  expect(code).toBe(7); expect(startNative).toHaveBeenCalledTimes(1); expect(fs.existsSync(plugin)).toBe(false);
});
it("represents auto per axis without forwarding auto as a native model or effort value", async () => {
  const startNative = vi.fn(async ({ args }) => {
    expect(args).toHaveLength(2);
    const entry = fs.readFileSync(path.join(args[1], "hooks/register.js"), "utf8"); expect(entry.match(/"source":"inherited"/g)).toHaveLength(2);
    return 0;
  });
  await runClaudeTerminal({ repoRoot: "/project", model: "auto", effort: "auto" }, { readActivation: enabled, runtimeVersion: async () => "2.1.302", startNative });
});
it("preserves native initial provenance when an axis was not specified", async () => {
  await runClaudeTerminal({ repoRoot: "/project" }, { readActivation: enabled, runtimeVersion: async () => "2.1.302", startNative: async ({ args }) => {
    const entry = fs.readFileSync(path.join(args[1], "hooks/register.js"), "utf8"); expect(entry.match(/"source":"native-initial"/g)).toHaveLength(2); return 0;
  } });
});
it("does not probe or launch a runtime for a disabled project", async () => {
  const runtimeVersion = vi.fn(); const startNative = vi.fn();
  await expect(runClaudeTerminal({ repoRoot: "/project" }, { readActivation: async () => ({ enabled: false }), runtimeVersion, startNative })).rejects.toMatchObject({ code: "routing_disabled" });
  expect(runtimeVersion).not.toHaveBeenCalled(); expect(startNative).not.toHaveBeenCalled();
});
it.each(["99.0.0", "2.1.303", "2.1.306"])("does not claim support or launch native UI on unmeasured runtime %s", async version => {
  const startNative = vi.fn();
  await expect(runClaudeTerminal({ repoRoot: "/project" }, { readActivation: enabled, runtimeVersion: async () => version, startNative })).rejects.toMatchObject({ code: "routing_unverified" }); expect(startNative).not.toHaveBeenCalled();
});
it.each(["2.1.304", "2.1.307"])("launches native UI on the separately measured %s runtime", async version => {
  const startNative = vi.fn(async () => 0);
  expect(await runClaudeTerminal({ repoRoot: "/project" }, { readActivation: enabled, runtimeVersion: async () => version, startNative })).toBe(0); expect(startNative).toHaveBeenCalledOnce();
});
it("cleans up its plugin and bridge after native startup failure", async () => {
  let plugin;
  await expect(runClaudeTerminal({ repoRoot: "/project" }, { readActivation: enabled, runtimeVersion: async () => "2.1.302", startNative: async ({ args }) => { plugin = args[1]; throw Error("native startup failed"); } })).rejects.toThrow("native startup failed");
  expect(fs.existsSync(plugin)).toBe(false);
});

it.each([{ enabled: true, routingEnabled: false }, { enabled: false, routingEnabled: true }, { enabled: true }, { routingEnabled: true }])("requires both project opt-ins before native startup: %j", async activation => {
  const runtimeVersion = vi.fn(); const startNative = vi.fn();
  await expect(runClaudeTerminal({ repoRoot: "/project" }, { readActivation: async () => activation, runtimeVersion, startNative })).rejects.toMatchObject({ code: "routing_disabled" });
  expect(runtimeVersion).not.toHaveBeenCalled(); expect(startNative).not.toHaveBeenCalled();
});

it.each(["model", "effort"])("rejects invalid %s values before probing or opening any native session", async axis => {
  const runtimeVersion = vi.fn(); const startNative = vi.fn();
  for (const value of [3, "", "bad\nvalue", "bad\u200dvalue", "-option"]) {
    await expect(runClaudeTerminal({ repoRoot: "/project", [axis]: value }, { readActivation: enabled, runtimeVersion, startNative })).rejects.toMatchObject({ code: "session_axis_invalid" });
  }
  expect(runtimeVersion).not.toHaveBeenCalled(); expect(startNative).not.toHaveBeenCalled();
});

it("starts the plugin through its native hook manifest with independent automatic and manual axes", async () => {
  await runClaudeTerminal({ repoRoot: "/project", model: "auto", effort: "low" }, { readActivation: enabled, runtimeVersion: async () => "2.1.302", startNative: async ({ args, socketPath }) => {
    expect(args.slice(2)).toEqual(["--effort", "low"]);
    const hooks = JSON.parse(fs.readFileSync(path.join(args[1], "hooks/hooks.json"), "utf8")); expect(hooks.modules).toEqual(["./register.js"]);
    const module = await import(path.join(args[1], "hooks", hooks.modules[0]));
    const registered = new Map(); module.register((name, handler) => { registered.set(name, handler); return { catch() {} }; });
    expect(registered.has("turn.step")).toBe(true); expect(registered.has("prompt.submit")).toBe(true);
    const entry = fs.readFileSync(path.join(args[1], "hooks/register.js"), "utf8");
    expect(entry).toContain(JSON.stringify(socketPath)); expect(entry).toContain('"freshSession":true');
    for (const file of [".claude-plugin/plugin.json", "hooks/hooks.json", "hooks/register.js", "hooks/claude-mod.mjs", "hooks/claude-mod-prepare.mjs"]) expect(fs.statSync(path.join(args[1], file)).mode & 0o777).toBe(0o600);
    return 0;
  } });
});
