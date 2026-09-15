// vitest globalSetup: one parent tempdir per run, removed whole at teardown.
//
// Pointing TMPDIR (and TMP/TEMP, which os.tmpdir() falls back to) at it before
// the workers start means every tempdir in the run lands inside it — including
// those created by the CLIs the tests spawn, which inherit the environment.
// That is the backstop for what per-test cleanup (temp-dir.mjs) cannot reach:
// a subprocess's own leftovers, or a worker killed mid-test before its hooks
// run. A run that is itself killed leaves this one directory, not thousands.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const VARS = ["TMPDIR", "TMP", "TEMP"];

export default function setup() {
  const root = mkdtempSync(join(tmpdir(), "dotbabel-vitest-"));
  const saved = Object.fromEntries(VARS.map((name) => [name, process.env[name]]));
  for (const name of VARS) process.env[name] = root;

  return () => {
    for (const name of VARS) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
    rmSync(root, { recursive: true, force: true });
  };
}
