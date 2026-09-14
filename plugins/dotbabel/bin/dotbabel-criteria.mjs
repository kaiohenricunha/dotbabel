#!/usr/bin/env node
/**
 * `dotbabel criteria` — run and report a spec's `acceptance_criteria` (P-B2).
 *
 *   dotbabel criteria list   [--spec <id>] [--json]
 *   dotbabel criteria verify (--spec <id> | --pr <N>) [--criterion <id>]...
 *                            [--post] [--allow-project-commands]
 *                            [--pass-env <name>]... [--timeout <seconds>] [--json]
 *
 * Exit codes: 0 ok (or nothing active), 1 a criterion failed/unconfirmed/errored,
 * 2 an environment problem (trust, fork, head mismatch, dirty tree, untrusted
 * argv change, unknown spec), 64 a usage error.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";

import { version } from "../src/index.mjs";
import { parse, helpText } from "../src/lib/argv.mjs";
import { ValidationError, formatError, ERROR_CODES } from "../src/lib/errors.mjs";
import { EXIT_CODES } from "../src/lib/exit-codes.mjs";
import { GIT_MAX_BUFFER } from "../src/lib/limits.mjs";
import { createHarnessContext, listSpecDirs } from "../src/spec-harness-lib.mjs";
import { verifyCriteria } from "../src/criteria/verify.mjs";
import { listCriteria } from "../src/criteria/list.mjs";
import { loadCriteriaConfig } from "../src/criteria/config.mjs";
import { checkPrPreconditions } from "../src/criteria/preconditions.mjs";
import { renderEvidenceComment, postEvidenceComment } from "../src/criteria/comment.mjs";

const COMMANDS = ["list", "verify"];
const FLAGS = {
  spec: { type: "string" },
  pr: { type: "string" },
  criterion: { type: "string", multiple: true },
  post: { type: "boolean" },
  "allow-project-commands": { type: "boolean" },
  "pass-env": { type: "string", multiple: true },
  timeout: { type: "string" },
};

function usage() {
  return helpText({
    name: "dotbabel-criteria",
    synopsis: "dotbabel criteria list|verify [OPTIONS]",
    description: "Run and report a spec's acceptance_criteria (qa-verification-harness P-B2).",
    flags: FLAGS,
  });
}

function toArray(value) {
  return Array.isArray(value) ? value : value !== undefined ? [String(value)] : [];
}

function combineVerdicts(verdicts) {
  if (verdicts.every((v) => v === "pass")) return "pass";
  if (verdicts.some((v) => v === "fail")) return "fail";
  if (verdicts.some((v) => v === "error")) return "error";
  return "unconfirmed";
}

/**
 * Merge one payload per spec (`verifyCriteria` only ever verifies one spec at
 * a time) into the single combined payload `--pr` mode's multiple linked
 * specs produce. Specs sorted by id (REL-5).
 */
function combinePayloads(payloads, { headSha, pr }) {
  const specs = payloads.flatMap((p) => p.specs).sort((a, b) => a.id.localeCompare(b.id));
  return {
    schema_version: 1,
    tool: { name: "dotbabel", version },
    ...(headSha ? { head_sha: headSha } : {}),
    ...(pr ? { pr } : {}),
    generated_at: new Date().toISOString(),
    verdict: combineVerdicts(payloads.map((p) => p.verdict)),
    specs,
  };
}

function realCapture(argv) {
  const r = spawnSync(argv[0], argv.slice(1), { shell: false, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: GIT_MAX_BUFFER });
  if (r.status !== 0) throw new Error(`command failed (${r.status}): ${JSON.stringify(argv)}\n${r.stderr || ""}`);
  return (r.stdout || "").trim();
}

function realGhApiWithInput(argv, payload) {
  const r = spawnSync(argv[0], argv.slice(1), { shell: false, input: JSON.stringify(payload), encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
  if (r.status !== 0) throw new Error(`command failed (${r.status}): ${JSON.stringify(argv)}\n${r.stderr || ""}`);
  return r.stdout;
}

const deps = { capture: realCapture, ghApiWithInput: realGhApiWithInput, log: (msg) => process.stderr.write(`${msg}\n`) };

function writeAll(text) {
  const buffer = Buffer.from(text);
  let offset = 0;
  while (offset < buffer.length) offset += fs.writeSync(process.stdout.fd, buffer, offset);
}

function exitWithValidationError(error, verbose) {
  process.stderr.write(`${formatError(error, { verbose })}\n`);
  process.exit(EXIT_CODES.ENV);
}

let argv;
try {
  argv = parse(process.argv.slice(2), FLAGS);
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exit(EXIT_CODES.USAGE);
}
if (argv.help) {
  writeAll(`${usage()}\n`);
  process.exit(EXIT_CODES.OK);
}
if (argv.version) {
  writeAll(`${version}\n`);
  process.exit(EXIT_CODES.OK);
}

const command = argv.positional[0];
if (!COMMANDS.includes(command) || argv.positional.length > 1) {
  process.stderr.write(`dotbabel criteria: unknown command '${command ?? "(none)"}'. Use 'list' or 'verify'.\n`);
  process.exit(EXIT_CODES.USAGE);
}

const repoRoot = process.cwd();
const specFlag = argv.flags.spec === undefined ? undefined : String(argv.flags.spec);
const prFlag = argv.flags.pr === undefined ? undefined : String(argv.flags.pr);
const criterionFlag = toArray(argv.flags.criterion);
const post = Boolean(argv.flags.post);
const allowProjectCommands = Boolean(argv.flags["allow-project-commands"]);
const passEnvFlag = toArray(argv.flags["pass-env"]);

if (command === "verify") {
  if (specFlag === undefined && prFlag === undefined) {
    process.stderr.write("dotbabel criteria verify: one of --spec or --pr is required\n");
    process.exit(EXIT_CODES.USAGE);
  }
  if (specFlag !== undefined && prFlag !== undefined) {
    process.stderr.write("dotbabel criteria verify: --spec and --pr cannot be combined\n");
    process.exit(EXIT_CODES.USAGE);
  }
  if (post && prFlag === undefined) {
    process.stderr.write("dotbabel criteria verify: --post requires --pr\n");
    process.exit(EXIT_CODES.USAGE);
  }
  if (argv.flags.timeout !== undefined) {
    const t = Number(argv.flags.timeout);
    if (!Number.isInteger(t) || t < 1 || t > 3600) {
      process.stderr.write("dotbabel criteria verify: --timeout must be an integer from 1 through 3600\n");
      process.exit(EXIT_CODES.USAGE);
    }
  }
  if (prFlag !== undefined) {
    const pr = Number(prFlag);
    if (!Number.isInteger(pr) || pr < 1) {
      process.stderr.write("dotbabel criteria verify: --pr must be a positive integer\n");
      process.exit(EXIT_CODES.USAGE);
    }
  }
  if (passEnvFlag.some((name) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))) {
    process.stderr.write("dotbabel criteria verify: --pass-env must be an environment-variable-shaped name\n");
    process.exit(EXIT_CODES.USAGE);
  }
}

async function main() {
  const ctx = createHarnessContext({ repoRoot });

  if (command === "list") {
    let result;
    try {
      result = listCriteria(ctx, { specId: specFlag });
    } catch (error) {
      if (error instanceof ValidationError) return exitWithValidationError(error, argv.verbose);
      throw error;
    }
    if (argv.json) {
      writeAll(`${JSON.stringify(result, null, 2)}\n`);
    } else if (result.specs.length === 0) {
      writeAll("no spec declares any acceptance_criteria\n");
    } else {
      for (const spec of result.specs) {
        writeAll(`${spec.id}\n`);
        for (const criterion of spec.criteria) writeAll(`  ${criterion.id}  ${criterion.status}\n`);
      }
    }
    process.exit(EXIT_CODES.OK);
  }

  // command === "verify"
  let config;
  let specIds;
  let prNumber;
  let headSha;
  let repo;

  if (prFlag !== undefined) {
    prNumber = Number(prFlag);
    try {
      repo = deps.capture(["gh", "repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"]);
    } catch (error) {
      process.stderr.write(`dotbabel criteria verify: gh is not available or not authenticated: ${error.message}\n`);
      process.exit(EXIT_CODES.ENV);
    }
    let pre;
    try {
      pre = checkPrPreconditions(deps, {
        ctx,
        pr: prNumber,
        repo,
        allowProjectCommands,
        env: process.env,
      });
    } catch (error) {
      if (error instanceof ValidationError) return exitWithValidationError(error, argv.verbose);
      throw error;
    }
    headSha = pre.headSha;
    specIds = pre.specIds;
    config = pre.config;
  } else {
    specIds = [specFlag];
    try {
      config = loadCriteriaConfig(repoRoot);
    } catch (error) {
      if (error instanceof ValidationError) return exitWithValidationError(error, argv.verbose);
      throw error;
    }
  }

  let knownSpecIds;
  try {
    knownSpecIds = new Set(listSpecDirs(ctx));
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    knownSpecIds = new Set();
  }
  const unknownSpecId = specIds.find((id) => !knownSpecIds.has(id));
  if (unknownSpecId) {
    return exitWithValidationError(new ValidationError({ code: ERROR_CODES.CRITERIA_UNKNOWN_SPEC, category: "criteria", message: `unknown spec: ${unknownSpecId}` }), argv.verbose);
  }

  if (criterionFlag.length > 0) {
    const declared = new Set(
      specIds.flatMap((specId) => listCriteria(ctx, { specId }).specs.flatMap((spec) => spec.criteria.map((criterion) => criterion.id))),
    );
    const unknownCriterion = criterionFlag.find((id) => !declared.has(id));
    if (unknownCriterion) {
      process.stderr.write(`dotbabel criteria verify: unknown --criterion id: ${unknownCriterion}\n`);
      process.exit(EXIT_CODES.USAGE);
    }
  }

  const passEnv = [...new Set([...config.pass_env, ...passEnvFlag])];
  const timeoutSeconds = argv.flags.timeout !== undefined ? Number(argv.flags.timeout) : config.timeout_seconds;

  const perSpecResults = [];
  for (const specId of specIds) {
    let outcome;
    try {
      outcome = await verifyCriteria(ctx, {
        specId,
        allowProjectCommands,
        passEnv,
        timeoutSeconds,
        criterionIds: criterionFlag.length > 0 ? criterionFlag : undefined,
        headSha,
        pr: prNumber,
      });
    } catch (error) {
      if (error instanceof ValidationError) return exitWithValidationError(error, argv.verbose);
      throw error;
    }
    perSpecResults.push(outcome);
  }

  const payload = combinePayloads(perSpecResults.map((r) => r.payload), { headSha, pr: prNumber });
  const tails = Object.fromEntries(specIds.map((specId, index) => [specId, perSpecResults[index].tails]));

  const anyActiveDeclared = payload.specs.some((spec) => spec.criteria.some((c) => c.status !== "pending"));
  if (!anyActiveDeclared) {
    process.stderr.write("no linked spec declares an active criterion\n");
    if (argv.json) writeAll(`${JSON.stringify(payload, null, 2)}\n`);
    process.exit(EXIT_CODES.OK);
  }

  // A --criterion subset run never posts evidence (§5), regardless of --post.
  if (post && criterionFlag.length === 0) {
    const body = renderEvidenceComment(payload, tails);
    postEvidenceComment(deps, { repo, pr: prNumber, body });
  }

  if (argv.json) {
    writeAll(`${JSON.stringify(payload, null, 2)}\n`);
  } else {
    for (const spec of payload.specs) {
      for (const criterion of spec.criteria) writeAll(`${spec.id} ${criterion.id}: ${criterion.status}\n`);
    }
  }

  process.exit(payload.verdict === "pass" ? EXIT_CODES.OK : EXIT_CODES.VALIDATION);
}

main().catch((error) => {
  process.stderr.write(`dotbabel criteria: ${error.message}\n`);
  process.exit(EXIT_CODES.ENV);
});
