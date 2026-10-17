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
