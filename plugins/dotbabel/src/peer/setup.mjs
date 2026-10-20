/** Explicit, additive user hook installation. No permissions or trust decisions are changed. */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { setupNative } from "./native-setup.mjs";
const BIN = fileURLToPath(new URL("../../bin/dotbabel-peer.mjs", import.meta.url));
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
function install(file, events) {
  let existing = {};
  try {
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink()) throw new Error(`refusing settings symlink: ${file}`);
    existing = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!existing || typeof existing !== "object" || Array.isArray(existing))
      throw new Error("settings must be an object");
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }
  existing.hooks ??= {};
  if (typeof existing.hooks !== "object" || Array.isArray(existing.hooks))
    throw new Error("malformed hooks settings");
  for (const event of events) {
    const command = `${quote(process.execPath)} ${quote(BIN)} hook ${event}`;
    existing.hooks[event] ??= [];
    if (!Array.isArray(existing.hooks[event])) throw new Error(`invalid ${event} hooks`);
    if (existing.hooks[event].some((g) => g.hooks?.some((h) => h.command === command))) continue;
    existing.hooks[event].push({
      hooks: [
        { type: "command", command, timeout: ["SessionEnd", "Interrupt"].includes(event) ? 3 : 10 },
      ],
    });
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${randomUUID()}.tmp`,
    fd = fs.openSync(tmp, "wx", 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify(existing, null, 2) + "\n");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
  return file;
}

/** Install peer hooks after explicit setup invocation; native trust remains the user's decision. @param {string} harness @param {NodeJS.ProcessEnv} [env] @param {string} [directory] @returns {object} */
export function setupHooks(harness, env = process.env, directory = process.cwd()) {
  if (["opencode", "copilot", "antigravity"].includes(harness))
    return setupNative(harness, directory);
  if (!["claude", "codex", "both"].includes(harness))
    throw new Error("harness must be claude, codex, or both");
  const files = [];
  if (harness !== "codex")
    files.push(
      install(
        path.join(env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude"), "settings.json"),
        ["SessionStart", "SessionEnd", "PreToolUse", "Stop", "StopFailure", "UserPromptSubmit"],
      ),
    );
  if (harness !== "claude")
    files.push(
      install(path.join(env.CODEX_HOME || path.join(os.homedir(), ".codex"), "hooks.json"), [
        "SessionStart",
        "SessionEnd",
        "PreToolUse",
        "Stop",
        "Interrupt",
      ]),
    );
  return {
    files,
    next: "In Codex, review and trust these definitions with /hooks, then restart or resume. The trusted PreToolUse hook handles literal peer coordination on the host and prints its result. Other tool commands retain existing sandbox and permission checks.",
  };
}
