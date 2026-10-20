import fs from "node:fs";
import path from "node:path";
import { it, expect } from "vitest";
import { makeTempDir } from "../fixtures/temp-dir.mjs";
import { setupHooks } from "../../src/peer/setup.mjs";
it("installs additive hooks for both harnesses, preserves settings, and is idempotent", () => {
  const root = makeTempDir("peer-setup-"),
    claude = path.join(root, "claude"),
    codex = path.join(root, "codex");
  fs.mkdirSync(claude);
  fs.writeFileSync(
    path.join(claude, "settings.json"),
    JSON.stringify({
      model: "keep",
      hooks: { Stop: [{ hooks: [{ type: "command", command: "existing" }] }] },
    }),
  );
  const env = { CLAUDE_CONFIG_DIR: claude, CODEX_HOME: codex };
  setupHooks("both", env);
  setupHooks("both", env);
  const a = JSON.parse(fs.readFileSync(path.join(claude, "settings.json"))),
    b = JSON.parse(fs.readFileSync(path.join(codex, "hooks.json")));
  expect(a.model).toBe("keep");
  expect(a.hooks.Stop).toHaveLength(2);
  expect(b.hooks.PreToolUse).toHaveLength(1);
  expect(b.hooks.Interrupt).toHaveLength(1);
  expect(a.hooks.SessionEnd[0].hooks[0].timeout).toBe(3);
  expect(a.hooks.UserPromptSubmit).toHaveLength(1);
  expect(b.hooks.UserPromptSubmit).toBeUndefined();
});
it("refuses malformed settings, symlinks, and unknown harnesses without losing data", () => {
  const root = makeTempDir("peer-settings-"),
    file = path.join(root, "settings.json");
  fs.writeFileSync(file, "broken");
  expect(() => setupHooks("claude", { CLAUDE_CONFIG_DIR: root })).toThrow();
  expect(fs.readFileSync(file, "utf8")).toBe("broken");
  fs.unlinkSync(file);
  fs.symlinkSync("/tmp/missing", file);
  expect(() => setupHooks("claude", { CLAUDE_CONFIG_DIR: root })).toThrow(/symlink/);
  expect(() => setupHooks("invalid", {})).toThrow(/harness/);
});

it("installs project-scoped native adapters and skills without model or permission settings", () => {
  const root = makeTempDir("peer-native-setup-");
  const expected = {
    opencode: ".opencode/plugins/dotbabel-peer/index.mjs",
    copilot: ".github/extensions/dotbabel-peer/extension.mjs",
    antigravity: ".agents/hooks.json",
  };
  for (const harness of Object.keys(expected)) {
    const first = setupHooks(harness, {}, root),
      second = setupHooks(harness, {}, root);
    expect(second.files).toEqual(first.files);
    expect(fs.existsSync(path.join(root, expected[harness]))).toBe(true);
    expect(fs.existsSync(path.join(root, ".agents/skills/peer/SKILL.md"))).toBe(true);
  }
  const hooks = JSON.parse(fs.readFileSync(path.join(root, ".agents/hooks.json")));
  expect(hooks["dotbabel-peer"].PreToolUse[0].matcher).toBe(".*");
  expect(hooks["dotbabel-peer"].Stop[0].command).toContain("--harness antigravity");
  expect(fs.existsSync(path.join(root, ".github/copilot/settings.json"))).toBe(false);
});
it("preserves foreign native files and refuses symlinked integration directories", () => {
  const root = makeTempDir("peer-native-foreign-");
  const dir = path.join(root, ".github/extensions/dotbabel-peer");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "extension.mjs");
  fs.writeFileSync(file, "foreign");
  expect(() => setupHooks("copilot", {}, root)).toThrow(/managed|overwrite/);
  expect(fs.readFileSync(file, "utf8")).toBe("foreign");
  const other = makeTempDir("peer-native-link-");
  fs.symlinkSync(root, path.join(other, ".opencode"));
  expect(() => setupHooks("opencode", {}, other)).toThrow(/symlink/);
});
