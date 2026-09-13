/**
 * Verify the active `acceptance_criteria` of one spec and build the evidence
 * payload (P-B1, Flow 2, KD-1, KD-2, KD-3, KD-15).
 *
 * Shared work: criteria that declare the identical `argv` run through one
 * execution (`runQualityPlans` already dedups by command key), and the same
 * result confirms every one of those criteria (REL-4). Every configured
 * report path is deleted once before its command runs, so a report a run
 * does not rewrite is unambiguous — but only once this run has passed the
 * same trust check `runQualityPlans` enforces before it executes anything,
 * so an untrusted repository's `spec.json` can never cause a delete. Output
 * never reaches the payload as text — only a SHA-256 hash of a redacted,
 * size-capped tail does (SEC-4, OPS-3).
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runQualityPlans } from "../quality/runner.mjs";
import { isRepoTrusted } from "../trust-allowlist.mjs";
import { findPackageJson } from "../lib/package-root.mjs";
import { loadCriteria } from "./load.mjs";
import { parseJUnitReport, CriteriaReportError, confirmTest } from "./confirm.mjs";

const TAIL_LINES = 40;
const TAIL_CHARS = 2000;

// Read from the root package.json rather than duplicating a literal here, so
// the payload's tool.version can never drift from the installed package (as
// a hardcoded string once did). Resolved independently of `src/index.mjs`'s
// own copy of this same read, rather than importing it from there, so this
// module never becomes a circular dependency of the top-level barrel.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
// fs.readFileSync without an encoding returns a Buffer, and JSON.parse
// coerces its argument to a string the same way Buffer#toString() defaults
// to (utf8) — so the explicit "utf8" here is for clarity only, not behavior.
const TOOL_VERSION = JSON.parse(fs.readFileSync(findPackageJson(__dirname), "utf8")).version;

/**
 * @param {object} ctx Harness context from `createHarnessContext`.
 * @param {object} opts
 * @param {string} opts.specId
 * @param {boolean} [opts.allowProjectCommands]
 * @param {string[]} [opts.passEnv]
 * @param {NodeJS.ProcessEnv} [opts.env]
 * @param {number} [opts.jobs]
 * @param {number} [opts.timeoutSeconds]
 * @param {string} [opts.headSha]
 * @param {number} [opts.pr]
 * @returns {Promise<{ payload: object }>}
 */
export async function verifyCriteria(ctx, opts = {}) {
  const { specId, allowProjectCommands = false, passEnv = [], env, jobs, timeoutSeconds = 600, headSha, pr } = opts;
  const { runnable, resolved } = loadCriteria(ctx, specId);

  // Mirror the trust check `runQualityPlans` enforces before it executes
  // anything, so the delete below never runs ahead of it: an untrusted
  // repository's `spec.json` must not cause an unlink before the run
  // predictably throws QUALITY_TRUST_REQUIRED.
  if (allowProjectCommands || isRepoTrusted({ repoRoot: ctx.repoRoot, env: env ?? process.env }).trusted) {
    deleteConfiguredReports(ctx, runnable);
  }

  const groups = groupByCommand(runnable, ctx.repoRoot);
  const plans = [...groups.values()].map((g) => g.plan);
  // An empty plans array is a safe, fast no-op in runQualityPlans (it never
  // reaches the trust check or the worker loop), so this always runs — one
  // fewer branch than special-casing "nothing to verify" here too.
  const results = await runQualityPlans({ repoRoot: ctx.repoRoot, plans, allowProjectCommands, passEnv, env, jobs, timeoutSeconds });
  const resultByPlanId = new Map(results.map((r) => [r.id, r]));

  const finished = [];
  for (const group of groups.values()) {
    const result = resultByPlanId.get(group.plan.id);
    for (const criterion of group.criteria) {
      finished.push(evaluateCriterion(ctx, criterion, result));
    }
  }
  for (const criterion of resolved) {
    if (criterion.preStatus === "pending") {
      finished.push({ id: criterion.id, status: "pending" });
    } else {
      finished.push({ id: criterion.id, status: "error", error_message: criterion.errorMessage });
    }
  }
  finished.sort((a, b) => criterionNumber(a.id) - criterionNumber(b.id));

  const verdict = finished.every((c) => c.status === "pass" || c.status === "pending")
    ? "pass"
    : finished.some((c) => c.status === "fail" || c.status === "error")
      ? finished.some((c) => c.status === "fail")
        ? "fail"
        : "error"
      : "unconfirmed";

  const payload = {
    schema_version: 1,
    tool: { name: "dotbabel", version: TOOL_VERSION },
    ...(headSha ? { head_sha: headSha } : {}),
    ...(pr ? { pr } : {}),
    generated_at: new Date().toISOString(),
    verdict,
    specs: [{ id: specId, criteria: finished }],
  };

  return { payload };
}

function deleteConfiguredReports(ctx, runnable) {
  const relPaths = new Set(runnable.filter((c) => c.report).map((c) => c.report.path));
  for (const relPath of relPaths) {
    const abs = path.join(ctx.repoRoot, relPath);
    try {
      fs.unlinkSync(abs);
    } catch {
      // Nothing to delete is the common case (no earlier run); any other
      // failure surfaces later as "report was not rewritten by this run".
    }
  }
}

function groupByCommand(runnable, repoRoot) {
  const groups = new Map();
  for (const criterion of runnable) {
    const [executable, ...argv] = criterion.argv;
    const key = `${executable}\0${argv.join("\0")}`;
    if (!groups.has(key)) {
      groups.set(key, {
        criteria: [],
        plan: {
          // A short, readable id — not the NUL-joined `key` itself, which
          // `runner.mjs` interpolates verbatim into a user-facing message
          // (e.g. the trust-required error) and which would otherwise show
          // up there as an unreadable raw command line with embedded NULs.
          id: `criteria:${createHash("sha256").update(key).digest("hex").slice(0, 12)}`,
          // One "component" per distinct command, not a shared constant —
          // runQualityPlans batches by componentId and only parallelizes
          // across components, so a constant here would silently serialize
          // every criterion command regardless of --jobs.
          componentId: key,
          capability: "criteria",
          ruleIds: [],
          executable,
          argv,
          cwd: repoRoot,
          availability: "available",
          requiresTrust: true,
        },
      });
    }
    groups.get(key).criteria.push(criterion);
  }
  return groups;
}

function evaluateCriterion(ctx, criterion, result) {
  if (!result || result.state === "unavailable") {
    return { id: criterion.id, status: "error", error_message: "the command could not be spawned" };
  }
  if (result.timedOut) {
    return { id: criterion.id, status: "error", error_message: "the command timed out" };
  }

  // `result.truncated` is one shared flag set when EITHER stream hit the
  // runner's byte cap, and each stream is cut independently — so the partial
  // line has to be dropped from each stream on its own, before joining them.
  // Dropping it from the already-concatenated string instead (the original
  // approach here) only works when stderr happens to be empty; otherwise the
  // inserted separator becomes the "last newline" and the actual dangling
  // fragment survives untouched. `result.stdout`/`result.stderr` are already
  // redacted by `runQualityPlans` (`quality/runner.mjs`), so no further
  // `redactOutput` call belongs here.
  const stdout = dropPartialLastLine(result.stdout ?? "", result.truncated);
  const stderr = dropPartialLastLine(result.stderr ?? "", result.truncated);
  const rawOutput = `${stdout}\n${stderr}`;
  const tail = computeTail(rawOutput);
  const outputSha256 = createHash("sha256").update(tail).digest("hex");

  let report = null;
  let reportError = null;
  if (criterion.report) {
    const abs = path.join(ctx.repoRoot, criterion.report.path);
    try {
      report = parseJUnitReport(abs);
    } catch (error) {
      reportError = error instanceof CriteriaReportError ? error.message : String(error?.message ?? error);
    }
  }

  if (reportError) {
    return { id: criterion.id, status: "error", error_message: reportError, exit_code: result.exitCode, truncated: result.truncated === true };
  }

  // Sorted by file then name (REL-5), independent of spec.json declaration
  // order, so the payload is deterministic for the same inputs.
  const sortedTests = [...(criterion.tests ?? [])].sort((a, b) => a.file.localeCompare(b.file) || a.name.localeCompare(b.name));
  const confirmed = sortedTests.map((test) => ({
    file: test.file,
    name: test.name,
    ...confirmTest(test, report, rawOutput),
  }));

  const anyFailed = confirmed.some((t) => t.result === "failed" || t.result === "error");
  const anyUnconfirmed = confirmed.some((t) => t.result === "absent" || t.result === "skipped");
  const exitFailed = result.exitCode !== 0;

  const status = anyFailed || exitFailed ? "fail" : anyUnconfirmed ? "unconfirmed" : "pass";

  return {
    id: criterion.id,
    status,
    argv: criterion.argv,
    exit_code: result.exitCode,
    duration_ms: result.durationMs,
    timed_out: false,
    truncated: result.truncated === true,
    tests: confirmed.map(({ file, name, found_in_file, confirmed_by, result: r }) => ({ file, name, found_in_file, confirmed_by, result: r })),
    output_sha256: outputSha256,
  };
}

/**
 * Drop the trailing, possibly-partial line of a truncated stream before
 * redaction (SEC-4), so a secret cut mid-token can never leak.
 *
 * @param {string} text
 * @param {boolean} truncated
 * @returns {string}
 */
export function dropPartialLastLine(text, truncated) {
  if (!truncated) return text;
  const index = text.lastIndexOf("\n");
  return index === -1 ? "" : text.slice(0, index);
}

/**
 * The last `TAIL_LINES` lines of `text`, further capped at `TAIL_CHARS`
 * characters from the end (OPS-3).
 *
 * @param {string} text
 * @returns {string}
 */
export function computeTail(text) {
  // slice(-N) on a string no longer than N is a no-op, so capping unconditionally
  // is safe and needs no length check first.
  return text.split("\n").slice(-TAIL_LINES).join("\n").slice(-TAIL_CHARS);
}

/**
 * The numeric part of an `AC-<number>` id, for REL-5's sort-by-number rule.
 * An id that does not match the shape sorts last.
 *
 * @param {string} id
 * @returns {number}
 */
export function criterionNumber(id) {
  const match = /^AC-(\d+)$/.exec(id);
  return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER;
}
