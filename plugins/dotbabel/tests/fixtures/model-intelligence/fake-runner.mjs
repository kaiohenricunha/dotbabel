// Test doubles for the runtime adapters. Adapters take their subprocess runner as an injected
// dependency, so a unit test never spawns a real CLI (TEST-1, TEST-2): it supplies recorded output
// and inspects exactly what the adapter asked to run.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("./", import.meta.url));

/** Read a JSON fixture from a runtime's fixture directory. */
export const jsonFixture = (dir, name) => JSON.parse(readFileSync(join(ROOT, dir, name), "utf8"));

/** Read a text fixture from a runtime's fixture directory. */
export const textFixture = (dir, name) => readFileSync(join(ROOT, dir, name), "utf8");

/** A process outcome with every field a real runner returns. */
export const outcome = (over = {}) => ({ exitCode: 0, signal: null, stdout: "", stderr: "", truncated: false, stoppedEarly: false, aborted: false, ...over });

/** The error a spawn raises when the binary is not on PATH. */
export function enoent(command = "runtime") {
  return Object.assign(new Error(`spawn ${command} ENOENT`), { code: "ENOENT" });
}

/**
 * A runner that answers from `respond` and records every call.
 * `respond(spec, { signal })` may return an outcome, a promise, or throw.
 */
export function fakeRunner(respond) {
  const calls = [];
  async function runCommand(spec, { signal } = {}) {
    calls.push({ command: spec.command, args: [...spec.args], cwd: spec.cwd, env: { ...spec.env }, stopWhen: spec.stopWhen, signal });
    return respond(spec, { signal, calls });
  }
  return { runCommand, calls };
}

/** Walk a directory and record every entry's relative path, kind, size and mtime. */
export function snapshotTree(root) {
  const entries = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir).sort()) {
      const full = join(dir, name);
      const stat = statSync(full);
      entries.push(`${relative(root, full)}|${stat.isDirectory() ? "d" : "f"}|${stat.size}|${stat.mtimeMs}`);
      if (stat.isDirectory()) walk(full);
    }
  };
  walk(root);
  return entries;
}

/** A fixed clock, so `observedAt` is deterministic. */
export const fixedNow = () => "2026-09-19T00:00:00.000Z";
