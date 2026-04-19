// Programmatic JSONL builders for Claude / Copilot / Codex session trees.
// Used by vitest unit tests that need realistic inputs for the shell-script
// callers without shelling out to bash. Each builder writes files under
// <root> and returns the absolute path(s) it created.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

function writeFile(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  return path;
}

/**
 * Build a Claude session JSONL under <root>/.claude/projects/<slug>/<uuid>.jsonl.
 * @param {string} root - hermetic $HOME root
 * @param {object} opts
 * @param {string} opts.uuid
 * @param {string} [opts.slug] - defaults to `-home-user-projects-demo`
 * @param {string} [opts.cwd] - defaults to `/home/user/projects/demo`
 * @param {string} [opts.customTitle] - adds a custom-title record if set
 * @param {string[]} [opts.prompts] - user prompts appended as records
 * @returns {string} absolute path to the JSONL file
 */
export function makeClaudeSession(root, opts = {}) {
  const {
    uuid,
    slug = "-home-user-projects-demo",
    cwd = "/home/user/projects/demo",
    customTitle,
    prompts = [],
  } = opts;
  if (!uuid) throw new Error("makeClaudeSession: uuid required");
  const file = join(root, ".claude", "projects", slug, `${uuid}.jsonl`);
  const lines = [
    JSON.stringify({ cwd, sessionId: uuid, version: "2.1" }),
  ];
  if (customTitle) {
    lines.push(JSON.stringify({
      type: "custom-title",
      customTitle,
      sessionId: uuid,
    }));
  }
  for (const text of prompts) {
    lines.push(JSON.stringify({
      type: "user",
      message: { content: text },
    }));
  }
  return writeFile(file, lines.join("\n") + "\n");
}

/**
 * Build a Copilot session JSONL under
 * <root>/.copilot/session-state/<uuid>/events.jsonl.
 */
export function makeCopilotSession(root, opts = {}) {
  const {
    uuid,
    cwd = "/work",
    model = "gpt-4",
    prompts = [],
  } = opts;
  if (!uuid) throw new Error("makeCopilotSession: uuid required");
  const file = join(root, ".copilot", "session-state", uuid, "events.jsonl");
  const lines = [
    JSON.stringify({
      type: "session.start",
      data: { cwd, model, sessionId: uuid },
    }),
  ];
  for (const text of prompts) {
    lines.push(JSON.stringify({
      type: "user.message",
      data: { content: text },
    }));
  }
  return writeFile(file, lines.join("\n") + "\n");
}

/**
 * Build a Codex rollout under
 * <root>/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl.
 */
export function makeCodexSession(root, opts = {}) {
  const {
    uuid,
    cwd = "/work",
    timestamp = "2026-04-18T10-00-00",
    threadName,
    prompts = [],
  } = opts;
  if (!uuid) throw new Error("makeCodexSession: uuid required");
  const [year, month, day] = timestamp.split("T")[0].split("-");
  const file = join(
    root, ".codex", "sessions", year, month, day,
    `rollout-${timestamp}-${uuid}.jsonl`
  );
  const lines = [
    JSON.stringify({
      type: "session_meta",
      payload: { id: uuid, cwd },
    }),
  ];
  if (threadName) {
    lines.push(JSON.stringify({
      type: "event_msg",
      payload: { thread_id: uuid, thread_name: threadName, type: "thread_renamed" },
    }));
  }
  for (const text of prompts) {
    lines.push(JSON.stringify({
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text }],
      },
    }));
  }
  return writeFile(file, lines.join("\n") + "\n");
}
