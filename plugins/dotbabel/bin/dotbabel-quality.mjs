#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { version } from "../src/index.mjs";
import { parse } from "../src/lib/argv.mjs";
import { ERROR_CODES, ValidationError, formatError } from "../src/lib/errors.mjs";
import { EXIT_CODES } from "../src/lib/exit-codes.mjs";
import { createQualityBaseline, writeQualityBaseline } from "../src/quality/baseline.mjs";
import { resolveQualityPolicy } from "../src/quality/config.mjs";
import { detectQualityCapabilities, planQualityCheck } from "../src/quality/discovery.mjs";
import { runQualityCheck } from "../src/quality/index.mjs";
import { QUALITY_PROFILES } from "../src/quality/types.mjs";
import { qualityEnvelope, renderQualityHuman } from "../src/quality/reporters.mjs";
import { isRepoTrusted } from "../src/trust-allowlist.mjs";

const COMMANDS = ["check", "detect", "explain", "baseline"];
const FLAGS = {
  repo: { type: "string" }, profile: { type: "string" }, base: { type: "string" },
  head: { type: "string" }, jobs: { type: "string" }, "allow-project-commands": { type: "boolean" },
  "pass-env": { type: "string", multiple: true }, rule: { type: "string" }, write: { type: "boolean" },
};

function usage() {
  return `dotbabel-quality [check|detect|explain|baseline] [OPTIONS]\n\n` +
    `Commands:\n  check     execute the selected quality profile\n  detect    inspect components and tools without execution\n  explain   show resolved rules and provenance\n  baseline  print a candidate baseline; use --write to save it\n\n` +
    `Options:\n  --repo <path>\n  --profile <fast|pr|deep>\n  --base <revision>\n  --head <revision>\n  --jobs <count>\n  --allow-project-commands\n  --pass-env <name>\n  --rule <id>\n  --write\n  --json\n  --verbose\n  --no-color\n  --help\n  --version\n\n` +
    `Exit codes: 0 no error verdict, 1 policy failure, 2 environment failure, 64 invalid usage.\n`;
}

let argv;
try { argv = parse(process.argv.slice(2), FLAGS); }
catch (error) { process.stderr.write(`${error.message}\n`); process.exit(EXIT_CODES.USAGE); }
if (argv.help) { process.stdout.write(usage()); process.exit(EXIT_CODES.OK); }
if (argv.version) { process.stdout.write(`${version}\n`); process.exit(EXIT_CODES.OK); }

const first = argv.positional[0];
const command = first ?? "check";
if (!COMMANDS.includes(command) || argv.positional.length > (first ? 1 : 0)) {
  process.stderr.write(`dotbabel quality: unknown command '${command}'\n`);
  process.exit(EXIT_CODES.USAGE);
}
const repoRoot = path.resolve(String(argv.flags.repo ?? process.cwd()));
const profileFlag = argv.flags.profile === undefined ? undefined : String(argv.flags.profile);
if (profileFlag !== undefined && !QUALITY_PROFILES.includes(profileFlag)) { process.stderr.write(`unknown quality profile: ${profileFlag}\n`); process.exit(EXIT_CODES.USAGE); }
const jobs = argv.flags.jobs === undefined ? undefined : Number(argv.flags.jobs);
if (jobs !== undefined && (!Number.isInteger(jobs) || jobs < 1 || jobs > 8)) { process.stderr.write("--jobs must be an integer from 1 through 8\n"); process.exit(EXIT_CODES.USAGE); }
const passEnv = Array.isArray(argv.flags["pass-env"]) ? argv.flags["pass-env"] : argv.flags["pass-env"] ? [String(argv.flags["pass-env"])] : [];

function print(report) {
  writeAll(argv.json ? `${JSON.stringify(report, null, 2)}\n` : renderQualityHuman(report));
}

function writeAll(text) {
  const buffer = Buffer.from(text);
  let offset = 0;
  while (offset < buffer.length) offset += fs.writeSync(process.stdout.fd, buffer, offset);
}

try {
  const policy = resolveQualityPolicy({ repoRoot, profile: profileFlag, base: argv.flags.base, head: argv.flags.head, jobs });
  const profile = profileFlag ?? (first === undefined ? "fast" : policy.default_profile);
  if (command === "explain") {
    const ruleId = argv.flags.rule === undefined ? undefined : String(argv.flags.rule);
    if (ruleId && !policy.rules[ruleId]) { process.stderr.write(`unknown quality rule: ${ruleId}\n`); process.exit(EXIT_CODES.USAGE); }
    const shown = ruleId ? { ...policy, rules: { [ruleId]: policy.rules[ruleId] } } : policy;
    print(qualityEnvelope("explain", { state: policy.enabled ? "configured" : "disabled", profile, policy: shown, results: [] }));
    process.exit(EXIT_CODES.OK);
  }
  if (command === "detect") {
    const detection = detectQualityCapabilities({ repoRoot, policy });
    const planned = planQualityCheck({ repoRoot, policy, changeSet: { changedFiles: [] }, profile, detection });
    print(qualityEnvelope("detect", { state: policy.enabled ? "configured" : "disabled", profile, policy_hash: policy.policy_hash, components: detection.components, plans: planned.plans, trust: detection.trust, exclusions: detection.exclusions, rejected_candidates: detection.rejectedCandidates, results: [] }));
    process.exit(EXIT_CODES.OK);
  }
  if (command === "baseline" && argv.flags.write) {
    const dirty = execFileSync("git", ["-C", repoRoot, "status", "--porcelain"], { encoding: "utf8" }).trim();
    if (dirty) throw new ValidationError({ code: ERROR_CODES.QUALITY_BASELINE_INVALID, category: "quality", message: "baseline --write requires a clean worktree" });
    if (!argv.flags["allow-project-commands"] && !isRepoTrusted({ repoRoot }).trusted) throw new ValidationError({ code: ERROR_CODES.QUALITY_TRUST_REQUIRED, category: "quality", message: "baseline --write requires explicit project-command trust" });
  }
  const report = await runQualityCheck({ repoRoot, policy, profile, base: argv.flags.base, head: argv.flags.head, jobs, allowProjectCommands: Boolean(argv.flags["allow-project-commands"]), passEnv });
  if (command === "baseline") {
    const revision = execFileSync("git", ["-C", repoRoot, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    const baseline = createQualityBaseline({
      sourceRevision: revision,
      policyHash: policy.policy_hash,
      components: Object.fromEntries((report.components ?? []).map((item) => [item.id, { root: item.root, language: item.language }])),
      metrics: report.results.filter((item) => item.actual !== undefined && item.key).map((item) => ({ rule: item.rule, component: item.component, path: item.path, actual: item.actual, covered: item.covered, total: item.total, report_format: item.report_format, key: item.key })),
      findings: report.results.filter((item) => item.fingerprint).map((item) => ({ rule: item.rule, component: item.component, path: item.path, fingerprint: item.fingerprint, verdict: item.verdict })),
    });
    if (argv.flags.write) {
      writeQualityBaseline({ repoRoot, baselineFile: policy.baseline_file, baseline });
    }
    print(qualityEnvelope("baseline", { state: argv.flags.write ? "written" : "candidate", profile, baseline, results: report.results, verdict: report.verdict }));
  } else print(report);
  process.exit(report.environment_error ? EXIT_CODES.ENV : report.verdict === "fail" ? EXIT_CODES.VALIDATION : EXIT_CODES.OK);
} catch (error) {
  const rendered = error instanceof ValidationError ? formatError(error, { verbose: argv.verbose }) : `quality failed: ${error.message}`;
  if (argv.json) process.stdout.write(`${JSON.stringify(qualityEnvelope(command, { state: "error", error: error instanceof ValidationError ? error.toJSON() : { code: ERROR_CODES.QUALITY_EXECUTION_FAILED, message: error.message } }), null, 2)}\n`);
  else process.stderr.write(`${rendered}\n`);
  process.exit(error?.code === "USAGE_UNKNOWN_FLAG" ? EXIT_CODES.USAGE : EXIT_CODES.ENV);
}
