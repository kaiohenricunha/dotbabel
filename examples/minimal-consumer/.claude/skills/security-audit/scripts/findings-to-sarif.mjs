#!/usr/bin/env node
/**
 * findings-to-sarif — convert a finished security-audit run into SARIF 2.1.0.
 *
 * Usage: node findings-to-sarif.mjs --run-dir <audit-run-dir> --out <file.sarif>
 *
 * The run dir is the upstream output directory (default
 * ~/security-audit-skill/<repo>/run-<N>). The converter:
 *   1. refuses a run whose run-metadata.json `run_status` is not "complete";
 *   2. validates findings.json with the vendored upstream validator
 *      (../references/upstream/validate-findings.cjs);
 *   3. emits one SARIF result per `confirmed` record. `needs_validation` and
 *      `rejected` records are left out.
 *
 * `security-severity` follows the GitHub code-scanning bands, so
 * `dotbabel quality` maps critical and high to security.high_confidence.
 *
 * Self-contained on purpose: scaffolded copies of this skill have no
 * plugins/dotbabel/src to import from.
 *
 * Exits: 0 SARIF written, 2 run not usable (missing file, incomplete run,
 * invalid findings), 64 usage error.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const EXIT = Object.freeze({ OK: 0, ENV: 2, USAGE: 64 });
const RULE_ID = "security-audit/confirmed";
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const VALIDATOR = path.join(SCRIPT_DIR, "..", "references", "upstream", "validate-findings.cjs");

/** overall_severity → [security-severity, SARIF level]. */
const SEVERITY = Object.freeze({
  critical: ["9.5", "error"],
  high: ["8.0", "error"],
  medium: ["5.5", "warning"],
  low: ["3.0", "note"],
  informational: ["0.0", "note"],
});

const USAGE = "usage: findings-to-sarif.mjs --run-dir <audit-run-dir> --out <file.sarif>";

function location(step, text) {
  const loc = { physicalLocation: { artifactLocation: { uri: step.file }, region: { startLine: step.line } } };
  if (text !== undefined) loc.message = { text };
  return loc;
}

function toResult(record) {
  const sinkIndex = record.trace.findLastIndex((step) => step.kind === "sink");
  const primaryIndex = sinkIndex === -1 ? record.trace.length - 1 : sinkIndex;
  const related = [
    ...record.trace.filter((_, index) => index !== primaryIndex).map((step) => location(step, `${step.kind}: ${step.description}`)),
    ...record.evidence.map((item) => location(item, `evidence: ${item.description}`)),
  ].map((loc, index) => ({ id: index + 1, ...loc }));
  const [score, level] = SEVERITY[record.severity.overall_severity];
  return {
    ruleId: RULE_ID,
    level,
    message: { text: `${record.title}: ${record.description}` },
    locations: [location(record.trace[primaryIndex])],
    relatedLocations: related,
    partialFingerprints: { primaryLocationLineHash: record.fingerprint },
    properties: {
      "security-severity": score,
      confidence: record.confidence.score,
      root_cause: record.root_cause,
      remediation: record.remediation.strategy,
    },
  };
}

/**
 * Convert validated upstream findings into a SARIF 2.1.0 log.
 * @param {Array<object>} findings  Records that passed validate-findings.cjs.
 * @returns {object}
 */
export function findingsToSarif(findings) {
  return {
    $schema: "https://json.schemastore.org/sarif-2.1.0.json",
    version: "2.1.0",
    runs: [
      {
        tool: {
          driver: {
            name: "security-audit",
            informationUri: "https://github.com/cloudflare/security-audit-skill",
            rules: [
              {
                id: RULE_ID,
                shortDescription: { text: "Confirmed finding from an independently verified security audit" },
              },
            ],
          },
        },
        results: findings.filter((record) => record.verdict === "confirmed").map(toResult),
      },
    ],
  };
}

/** A run problem that must not read as a pass. */
class RunError extends Error {}

function readJson(file) {
  if (!existsSync(file)) throw new RunError(`missing ${path.basename(file)} in ${path.dirname(file)}`);
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    throw new RunError(`${path.basename(file)} is not valid JSON: ${err.message}`);
  }
}

function convertRun(runDir, outFile) {
  const metadata = readJson(path.join(runDir, "run-metadata.json"));
  if (metadata.run_status !== "complete") {
    const reason = metadata.incomplete_reason ? ` (${metadata.incomplete_reason})` : "";
    throw new RunError(`run_status is "${metadata.run_status}"${reason}; only a complete run converts`);
  }
  const findingsFile = path.join(runDir, "findings.json");
  const findings = readJson(findingsFile);
  const check = spawnSync(process.execPath, [VALIDATOR, findingsFile], { encoding: "utf8" });
  if (check.error || check.status !== 0) {
    const detail = (check.error?.message ?? check.stderr).trim();
    throw new RunError(`validate-findings.cjs rejected ${findingsFile}:\n${detail}`);
  }
  const sarif = findingsToSarif(findings);
  mkdirSync(path.dirname(outFile), { recursive: true });
  writeFileSync(outFile, `${JSON.stringify(sarif, null, 2)}\n`);
  return sarif.runs[0].results.length;
}

function main(argv) {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: { "run-dir": { type: "string" }, out: { type: "string" }, help: { type: "boolean", short: "h" } },
      strict: true,
    }));
  } catch (err) {
    process.stderr.write(`${err.message}\n${USAGE}\n`);
    return EXIT.USAGE;
  }
  if (values.help) {
    process.stdout.write(`${USAGE}\n`);
    return EXIT.OK;
  }
  if (!values["run-dir"] || !values.out) {
    process.stderr.write(`${USAGE}\n`);
    return EXIT.USAGE;
  }
  try {
    const count = convertRun(path.resolve(values["run-dir"]), path.resolve(values.out));
    process.stdout.write(`wrote ${count} confirmed finding(s) to ${values.out}\n`);
    return EXIT.OK;
  } catch (err) {
    if (!(err instanceof RunError)) throw err;
    process.stderr.write(`findings-to-sarif: ${err.message}\n`);
    return EXIT.ENV;
  }
}

// Run-direct guard, symlink-safe: bootstrap.sh symlinks skills into
// ~/.claude/skills/, and Node realpath-resolves the entry module while argv[1]
// keeps the symlink. Compare realpaths on both sides (same as deploy-ops.mjs).
let runDirect = false;
if (process.argv[1]) {
  const self = fileURLToPath(import.meta.url);
  runDirect = self === process.argv[1];
  if (!runDirect) {
    try {
      runDirect = realpathSync(self) === realpathSync(process.argv[1]);
    } catch {
      runDirect = false;
    }
  }
}
if (runDirect) process.exitCode = main(process.argv.slice(2));
