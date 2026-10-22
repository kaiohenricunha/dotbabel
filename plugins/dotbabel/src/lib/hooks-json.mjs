/**
 * Add command hooks to a hooks settings file (Claude `settings.json` or Codex
 * `hooks.json`), additively: existing hooks and other keys stay, a command
 * that is already present is not added again, and the file is replaced
 * atomically. A symbolic link is refused, so a write never lands somewhere
 * the user did not choose. No trust or permission setting is changed.
 */
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

/** Quote one shell word for a hook command line. @param {string} value @returns {string} */
export function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/**
 * @param {string} file
 * @param {Array<{event: string, command: string, matcher?: string, timeout: number}>} entries
 * @returns {{file: string, added: number}}
 */
export function addHookCommands(file, entries) {
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
  let added = 0;
  for (const { event, command, matcher, timeout } of entries) {
    existing.hooks[event] ??= [];
    if (!Array.isArray(existing.hooks[event])) throw new Error(`invalid ${event} hooks`);
    if (existing.hooks[event].some((g) => g.hooks?.some((h) => h.command === command))) continue;
    existing.hooks[event].push({
      ...(matcher === undefined ? {} : { matcher }),
      hooks: [{ type: "command", command, timeout }],
    });
    added += 1;
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
  return { file, added };
}
