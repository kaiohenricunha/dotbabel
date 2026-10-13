#!/usr/bin/env node
// fleet-lane-check.mjs — does the shell command on stdin need a CPU lane?
//
// hooks/fleet-shell-prefix.sh pipes a Bash tool command here. It prints the
// heavy-command label (such as "npm test") and exits 0 when the command is a
// heavy test run, built in or listed in the repo's fleet.heavy, and exits 1
// with no output otherwise. It imports only the
// detector, so it costs little more than starting Node.

import { readFileSync } from "node:fs";
import { findCustomHeavy, findHeavyCommand, parseHeavyConfig } from "../src/fleet/heavy.mjs";

let label = null;
try {
  const command = readFileSync(0, "utf8");
  label = findHeavyCommand(command);
  // The repo's own heavy commands: fleet.heavy in its .dotbabel.json, which
  // fleet-shell-prefix.sh found and names here.
  const config = process.env.DOTBABEL_FLEET_HEAVY_CONFIG;
  if (!label && config) label = findCustomHeavy(command, parseHeavyConfig(readFileSync(config, "utf8")));
} catch {
  // Unreadable stdin or config: not heavy, so the command runs at once.
}
if (label) process.stdout.write(`${label}\n`);
process.exitCode = label ? 0 : 1;
