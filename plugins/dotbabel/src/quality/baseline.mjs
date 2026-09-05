import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

import { ERROR_CODES, ValidationError } from "../lib/errors.mjs";
import { QUALITY_BASELINE_SCHEMA_VERSION } from "./types.mjs";

const NEVER_BASELINE = new Set(["correctness.compile", "correctness.types", "correctness.tests", "correctness.format", "correctness.lint", "security.high_confidence"]);

/** Create a deterministic baseline candidate without hard correctness failures. */
export function createQualityBaseline({ sourceRevision, policyHash, components = {}, toolVersions = {}, metrics = [], findings = [] }) {
  return {
    schema_version: QUALITY_BASELINE_SCHEMA_VERSION,
    source_revision: sourceRevision,
    policy_hash: policyHash,
    components,
    tool_versions: toolVersions,
    metrics: [...metrics].sort((a, b) => String(a.key ?? "").localeCompare(String(b.key ?? ""))),
    findings: findings.filter((item) => !NEVER_BASELINE.has(item.rule)).sort((a, b) => String(a.fingerprint).localeCompare(String(b.fingerprint))),
  };
}

/** Apply a changed-code ratchet to one metric. */
export function evaluateMetricAgainstBaseline({ actual, threshold, baseline, direction }) {
  const meets = direction === "min" ? actual >= threshold : actual <= threshold;
  const noWorse = baseline === undefined || (direction === "min" ? actual >= baseline : actual <= baseline);
  return { verdict: meets || noWorse ? "pass" : "fail", improved: baseline !== undefined && (direction === "min" ? actual > baseline : actual < baseline), actual, threshold, baseline };
}

/** Load and validate a baseline file. */
export function loadQualityBaseline({ repoRoot, baselineFile = ".dotbabel/quality-baseline.json" } = {}) {
  const absolute = path.resolve(repoRoot, baselineFile);
  const relative = path.relative(repoRoot, absolute);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new ValidationError({ code: ERROR_CODES.QUALITY_BASELINE_INVALID, category: "quality", message: "baseline path escapes the repository" });
  if (!fs.existsSync(absolute)) return null;
  return parseBaseline(fs.readFileSync(absolute, "utf8"));
}

function parseBaseline(text) {
  let body;
  try { body = JSON.parse(text); } catch (error) { throw new ValidationError({ code: ERROR_CODES.QUALITY_BASELINE_INVALID, category: "quality", message: `baseline is not valid JSON: ${error.message}` }); }
  if (body.schema_version !== 1 || !Array.isArray(body.metrics) || !Array.isArray(body.findings)) throw new ValidationError({ code: ERROR_CODES.QUALITY_BASELINE_INVALID, category: "quality", message: "baseline schema is invalid" });
  return body;
}

/** Load the baseline committed at a Git revision, or null when absent. */
export function loadQualityBaselineAtRevision({ repoRoot, baselineFile = ".dotbabel/quality-baseline.json", revision } = {}) {
  const normalized = path.posix.normalize(baselineFile.replaceAll("\\", "/"));
  if (path.isAbsolute(baselineFile) || normalized === ".." || normalized.startsWith("../")) throw new ValidationError({ code: ERROR_CODES.QUALITY_BASELINE_INVALID, category: "quality", message: "baseline path escapes the repository" });
  let text;
  try { text = execFileSync("git", ["-C", repoRoot, "show", `${revision}:${normalized}`], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 8 * 1024 * 1024 }); }
  catch { return null; }
  return parseBaseline(text);
}

/** Write an explicitly approved baseline file inside the repository. */
export function writeQualityBaseline({ repoRoot, baselineFile, baseline }) {
  const absolute = path.resolve(repoRoot, baselineFile);
  const relative = path.relative(repoRoot, absolute);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new ValidationError({ code: ERROR_CODES.QUALITY_BASELINE_INVALID, category: "quality", message: "baseline path escapes the repository" });
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, `${JSON.stringify(baseline, null, 2)}\n`);
  return absolute;
}
