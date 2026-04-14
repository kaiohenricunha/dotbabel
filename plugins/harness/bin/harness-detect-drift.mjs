#!/usr/bin/env node
/**
 * harness-detect-drift — thin bin wrapping `plugins/harness/scripts/detect-branch-drift.mjs`
 * so `npx harness-detect-drift` works (fixes the broken invocation at
 * `plugins/harness/templates/workflows/detect-drift.yml:15`).
 *
 * Forwards every flag through. Owns --help / --version only.
 *
 * Exit codes: whatever detect-branch-drift.mjs returns.
 */

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { EXIT_CODES } from "../src/lib/exit-codes.mjs";
import { version } from "../src/index.mjs";

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  process.stdout.write(
    [
      "harness-detect-drift [OPTIONS]",
      "",
      "Flag .claude/commands/*.md and skills/**/SKILL.md that diverge from origin/main",
      "for longer than the drift threshold. Wraps plugins/harness/scripts/detect-branch-drift.mjs.",
      "",
      "Options:",
      "  --help, -h           show this help",
      "  --version, -V        print harness version",
      "  (all other flags are forwarded to the underlying script)",
      "",
      "Exit codes: 0 ok, 1 drift detected, 2 env error.",
      "",
    ].join("\n")
  );
  process.exit(EXIT_CODES.OK);
}
if (args.includes("--version") || args.includes("-V")) {
  process.stdout.write(`${version}\n`);
  process.exit(EXIT_CODES.OK);
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const scriptPath = resolve(__dirname, "..", "scripts", "detect-branch-drift.mjs");

const child = spawn(process.execPath, [scriptPath, ...args], { stdio: "inherit" });
child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? EXIT_CODES.ENV);
});
