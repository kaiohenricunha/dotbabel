#!/usr/bin/env node
// fleet-lane-check.mjs — does the shell command on stdin need a CPU lane?
//
// hooks/fleet-shell-prefix.sh pipes a Bash tool command here. It prints the
// heavy-command label (such as "npm test") and exits 0 when the command is a
// heavy test run, and exits 1 with no output otherwise. It imports only the
// detector, so it costs little more than starting Node.

import { readFileSync } from "node:fs";
import { findHeavyCommand } from "../src/fleet/heavy.mjs";

let label = null;
try {
  label = findHeavyCommand(readFileSync(0, "utf8"));
} catch {
  // Unreadable stdin: not heavy, so the command runs at once.
}
if (label) process.stdout.write(`${label}\n`);
process.exitCode = label ? 0 : 1;
