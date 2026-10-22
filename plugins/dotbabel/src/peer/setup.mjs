/** Explicit, additive user hook installation. No permissions or trust decisions are changed. */
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { addHookCommands, shellQuote as quote } from "../lib/hooks-json.mjs";
import { setupNative } from "./native-setup.mjs";
const BIN = fileURLToPath(new URL("../../bin/dotbabel-peer.mjs", import.meta.url));
function install(file, events) {
  const entries = events.map((event) => ({
    event,
    command: `${quote(process.execPath)} ${quote(BIN)} hook ${event}`,
    timeout: ["SessionEnd", "Interrupt"].includes(event) ? 3 : 10,
  }));
  return addHookCommands(file, entries).file;
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
