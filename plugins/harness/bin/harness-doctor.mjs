#!/usr/bin/env node
/**
 * harness-doctor — diagnostic self-check.
 *
 * Walks through every invariant a consumer repo (or the harness repo itself,
 * when dogfooding) must satisfy for validators to run:
 *
 *   env          Node >= 20, git on PATH
 *   repo         git rev-parse --show-toplevel resolves; repoRoot usable
 *   facts        docs/repo-facts.json exists and parses
 *   manifest     .claude/skills-manifest.json checksums match (via validateManifest)
 *   specs        docs/specs/ scanned; validateSpecs clean
 *   drift        checkInstructionDrift clean
 *   hook         plugins/harness/hooks/guard-destructive-git.sh present + exec bit
 *
 * Exit codes: 0 all green, 1 one or more checks failed (validation), 2 env error.
 */

import { existsSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { parse, helpText } from "../src/lib/argv.mjs";
import { createOutput } from "../src/lib/output.mjs";
import { EXIT_CODES } from "../src/lib/exit-codes.mjs";
import { version } from "../src/index.mjs";
import {
  createHarnessContext,
  validateManifest,
  validateSpecs,
  checkInstructionDrift,
  pathExists,
} from "../src/index.mjs";

const META = {
  name: "harness-doctor",
  synopsis: "harness-doctor [OPTIONS]",
  description: "Run the harness self-diagnostic across env, repo, facts, manifest, specs, drift, and hooks.",
  flags: {
    "repo-root": { type: "string" },
  },
};

let argv;
try {
  argv = parse(process.argv.slice(2), META.flags);
} catch (err) {
  process.stderr.write(`${err.message}\n`);
  process.exit(EXIT_CODES.USAGE);
}

if (argv.help) {
  process.stdout.write(`${helpText(META)}\n`);
  process.exit(EXIT_CODES.OK);
}
if (argv.version) {
  process.stdout.write(`${version}\n`);
  process.exit(EXIT_CODES.OK);
}

const out = createOutput({
  json: argv.json,
  noColor: argv.noColor,
});

let envError = false;

// env: Node + git
const nodeMajor = Number(process.versions.node.split(".")[0]);
if (nodeMajor >= 20) {
  out.pass(`Node ${process.versions.node} (>=20 required)`);
} else {
  out.fail(`Node ${process.versions.node} is below the >=20 requirement`);
  envError = true;
}
try {
  const gitVersion = execFileSync("git", ["--version"], { encoding: "utf8" }).trim();
  out.pass(`git available — ${gitVersion}`);
} catch {
  out.fail("git is not on PATH");
  envError = true;
}

// repo: resolve context
const repoRoot = /** @type {string | undefined} */ (argv.flags["repo-root"]);
let ctx;
try {
  ctx = createHarnessContext({ repoRoot });
  out.pass(`repo root resolved to ${ctx.repoRoot}`);
} catch (err) {
  out.fail(`could not resolve repo root: ${err.message}`);
  envError = true;
}

if (envError) {
  out.flush();
  process.exit(EXIT_CODES.ENV);
}

// facts
if (pathExists(ctx, "docs/repo-facts.json")) {
  out.pass("docs/repo-facts.json present");
} else {
  out.warn("docs/repo-facts.json missing — coverage/drift checks will be no-ops");
}

// manifest
if (pathExists(ctx, ".claude/skills-manifest.json")) {
  const r = validateManifest(ctx);
  if (r.ok) out.pass(`manifest valid (${r.manifest.skills.length} skills)`);
  else out.fail(`manifest has ${r.errors.length} error(s)`, { errors: r.errors });
} else {
  out.warn(".claude/skills-manifest.json missing — skill inventory not indexed");
}

// specs
if (pathExists(ctx, "docs/specs")) {
  const r = validateSpecs(ctx);
  if (r.ok) out.pass("specs valid");
  else out.fail(`specs have ${r.errors.length} error(s)`, { errors: r.errors });
} else {
  out.warn("docs/specs/ missing — no specs to validate");
}

// drift
try {
  const r = checkInstructionDrift(ctx);
  if (r.ok) out.pass("instruction drift clean");
  else out.fail(`instruction drift: ${r.errors.length} issue(s)`, { errors: r.errors });
} catch (err) {
  out.warn(`drift check skipped: ${err.message}`);
}

// hook
const hookPath = resolve(ctx.repoRoot, "plugins/harness/hooks/guard-destructive-git.sh");
if (existsSync(hookPath)) {
  const mode = statSync(hookPath).mode & 0o111;
  if (mode) out.pass("guard-destructive-git.sh present + executable");
  else out.fail("guard-destructive-git.sh present but NOT executable (chmod +x)");
} else {
  out.warn("guard-destructive-git.sh missing — destructive git commands are unguarded");
}

out.flush();
const { fail } = out.counts();
process.exit(fail > 0 ? EXIT_CODES.VALIDATION : EXIT_CODES.OK);
