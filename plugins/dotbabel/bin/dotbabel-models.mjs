#!/usr/bin/env node
/**
 * dotbabel-models — Model Intelligence refresh, status, resolution, and migration analysis
 * (docs/specs/model-intelligence, §5 "CLI Surface").
 *
 * Verbs arrive with the library capability they expose (IMPL-4):
 *
 * - `refresh` (P-9) refreshes the capability cache from the sources that support discovery, under the
 *   per-key lock of ARCH-61. It writes only that reconstructible cache.
 * - `status` (P-9) reports each source's support, cached evidence, freshness, and refresh state, and
 *   the cache size. It never refreshes (ARCH-33) and writes nothing.
 * - `resolve` (P-11) explains artifact or ad hoc requirements using cached evidence only.
 *   It does not discover models, observe a session, or apply runtime configuration.
 * - `migrate` reports what migrating each artifact's legacy `model:` / `effort:` frontmatter would mean
 *   by default. Explicit `--write` and `--check` use reviewed decisions and preserve native
 *   controls behind the batching and preserved-behaviour gates of IMPL-2.
 *
 * Exits: 0 completed; 1 a declaration conflict (`migrate`) or a cache above the OPS-2 limit
 * (`status --check`); 2 a required source, runtime, or the repository is unavailable; 64 usage error.
 */

import { parse, helpText } from "../src/lib/argv.mjs";
import { createOutput } from "../src/lib/output.mjs";
import { EXIT_CODES } from "../src/lib/exit-codes.mjs";
import { version } from "../src/index.mjs";
import { parseFrontmatter, walkArtifacts } from "../src/build-index.mjs";
import {
  LEGACY_DISPOSITIONS,
  analyzeMigration,
  canCarryComputeDeclaration,
} from "../src/model-intelligence/compat/index.mjs";
import { readProjectActivation, setProjectActivation } from "../src/model-intelligence/activation/index.mjs";
import { PROVIDERS, RUNTIME_IDS, WORKLOAD_CLASSES, ARTIFACT_KINDS, checkOpaqueValue } from "../src/model-intelligence/domain/index.mjs";
import { SOURCE_ADAPTERS } from "../src/model-intelligence/sources/index.mjs";
import { resolve as resolveCompute } from "../src/model-intelligence/resolver/index.mjs";
import { makeObservedConfiguration } from "../src/model-intelligence/sources/evidence.mjs";
import { buildRecommendation } from "../src/model-intelligence/recommend/index.mjs";
import { resolveRequest } from "../src/model-intelligence/cli/resolve.mjs";
import { catalogStatus, refreshSources } from "../src/model-intelligence/catalog/index.mjs";
import { readSnapshot, updateSnapshot, collectReleaseEvidence, releaseSnapshotStatus, DEFAULT_SNAPSHOT_PATH } from "../src/model-intelligence/snapshot/index.mjs";
import { inspectWorkflowProjection } from "../src/model-intelligence/materialize/runtime/claude-workflow-status.mjs";
import { inspectClaudeProjection } from "../src/model-intelligence/materialize/runtime/claude-baseline.mjs";
import { fileURLToPath } from "node:url";
import { cacheRoot } from "../src/model-intelligence/catalog/cache.mjs";
import { spawnSync } from "node:child_process";
import { resolve, dirname, basename } from "node:path";

import { compatibleMigrationPaths } from "../src/model-intelligence/compat/compatibility.mjs";
import { loadCompatibilityContext } from "../src/model-intelligence/compat/release.mjs";
import { migrateArtifacts } from "../src/model-intelligence/compat/migrate.mjs";
import { openProjectionTree } from "../src/model-intelligence/materialize/projection-fs.mjs";
const META = {
  name: "dotbabel-models",
  synopsis: "dotbabel-models <verb> [OPTIONS]",
  description:
    "Model Intelligence. session [--runtime codex|claude] [--model auto|<native-id>] [--effort auto|<native-value>] — run an enabled project's managed Codex terminal or native Claude UI with session-only Mods; Claude effective-provider routing remains unverified; enable/disable [--routing] [--repo-root <path>] change project opt-ins only; resolve [artifact | --requirement <class>] --runtime <id> [--artifact-kind <kind>] — resolve and explain using cached evidence only; refresh [--source <id>] [--runtime <id>] — refresh the capability cache; status [--check] — report sources, cache freshness and release age, never refreshing; snapshot [--check | --write] [--snapshot-file <path>] [--evidence-file <path>] — validate offline or recheck native selectors and compare/write accepted release evidence; recommend [artifact | --requirement <class>] --runtime <id> — read-only advice and native invocation recipe; migrate [--check | --write] [--decisions <path>] [--batch <A-F>] — report or apply reviewed canonical migrations; class-F decisions remain untouched.",
  flags: {
    model: { type: "string" },
    effort: { type: "string" },
    write: { type: "boolean" },
    batch: { type: "string" },
    decisions: { type: "string" },
    "snapshot-file": { type: "string" },
    "observation-file": { type: "string" },
    "evidence-file": { type: "string" },
    routing: { type: "boolean" },
    "repo-root": { type: "string" },
    source: { type: "string" },
    runtime: { type: "string" },
    check: { type: "boolean" },
    requirement: { type: "string" },
    "artifact-kind": { type: "string" },
    json: { type: "boolean" },
  },
};

const VERBS = Object.freeze(["refresh", "status", "snapshot", "migrate", "resolve", "recommend", "enable", "disable", "session"]);

/** The flags each verb accepts, beyond the harness-wide set. Any other is a usage error. */
const VERB_FLAGS = Object.freeze({
  session: ["repo-root", "runtime", "model", "effort"],
  refresh: ["source", "runtime"],
  status: ["check", "repo-root", "snapshot-file"],
  snapshot: ["check", "write", "snapshot-file", "evidence-file"],
  enable: ["routing", "repo-root"],
  disable: ["routing", "repo-root"],
  migrate: ["repo-root", "write", "check", "batch", "decisions"],
  resolve: ["repo-root", "runtime", "requirement", "artifact-kind"],
  recommend: ["repo-root", "runtime", "requirement", "artifact-kind", "observation-file"],
});

/**
 * Report a usage error and exit 64.
 * @param {string} message
 * @returns {never}
 */
function usage(message) {
  process.stderr.write(`${message}\n`);
  process.exit(EXIT_CODES.USAGE);
}

let argv;
try {
  argv = parse(process.argv.slice(2), META.flags);
} catch (err) {
  usage(err.message);
}

if (argv.help) {
  process.stdout.write(`${helpText(META)}\n`);
  process.exit(EXIT_CODES.OK);
}
if (argv.version) {
  process.stdout.write(`${version}\n`);
  process.exit(EXIT_CODES.OK);
}

const verb = argv.positional?.[0];
if (verb === undefined) usage(`a verb is required (one of: ${VERBS.join(", ")})`);
if (!VERBS.includes(verb)) usage(`unknown verb "${verb}" (expected one of: ${VERBS.join(", ")})`);
for (const flag of ["repo-root", "source", "runtime", "check", "requirement", "artifact-kind", "routing", "write", "snapshot-file", "evidence-file", "model", "effort", "batch", "decisions", "observation-file"]) {
  if (argv.flags[flag] !== undefined && !VERB_FLAGS[verb].includes(flag)) usage(`--${flag} does not apply to ${verb}`);
}
if (verb === "migrate" && argv.flags.check && argv.flags.write) usage("migrate --check and --write cannot be combined");
if (verb === "migrate" && argv.flags.batch !== undefined && !["A", "B", "C", "D", "E", "F"].includes(argv.flags.batch)) usage("migrate --batch requires A, B, C, D, E or F");
if (verb === "snapshot" && argv.flags.check && (argv.flags.write || argv.flags["evidence-file"])) usage("snapshot --check cannot be combined with --write or --evidence-file");
if (!["migrate", "resolve", "recommend"].includes(verb) && argv.positional.length > 1) usage(`${verb} takes no positional argument`);
if (verb === "session") {
  if (argv.flags.runtime !== undefined && !["codex", "claude"].includes(argv.flags.runtime)) usage("session requires --runtime codex or claude");
  if (argv.flags.runtime === "claude" && argv.flags.json) usage("Claude session uses the native UI; inspect models status --json separately");
  for (const [flag, axis] of [["model", "model"], ["effort", "reasoning"]]) if (argv.flags[flag] !== undefined && !checkOpaqueValue(axis, argv.flags[flag])) usage(`invalid --${flag}`);
}

// Diagnostic `--json` stdout carries exactly one JSON document; session explicitly streams NDJSON.
// Every human diagnostic line
// goes to stderr. A caller piping the report into `jq` gets the report, not the
// report plus a summary sentence (§5, "JSON contract").
const out = createOutput({ noColor: argv.noColor, stream: argv.flags.json ? process.stderr : process.stdout });

try {
  if (verb === "refresh") await runRefresh();
  else if (verb === "status") runStatus();
  else if (verb === "snapshot") await runSnapshot();
  else if (["resolve", "recommend"].includes(verb)) runResolve();
  else if (verb === "session") {
    if (argv.flags.runtime === "claude") {
      const { runClaudeTerminal } = await import("../src/adaptive-session-routing/claude-launcher.mjs");
      process.exitCode = await runClaudeTerminal({ repoRoot: resolveRepoRoot(), model: argv.flags.model, effort: argv.flags.effort });
    } else {
      const { runManagedTerminal } = await import("../src/adaptive-session-routing/terminal.mjs");
      await runManagedTerminal({ repoRoot: resolveRepoRoot(), model: argv.flags.model, effort: argv.flags.effort, json: argv.flags.json });
    }
  }
  else if (["enable", "disable"].includes(verb)) runActivation();
  else await runMigrate();
} catch (error) {
  const snapshotCode = typeof error.code === "string" && /^(snapshot_|release_|migration_|projection_|recommendation_)/.test(error.code) ? error.code : undefined;
  const code = snapshotCode ?? (["routing_disabled", "routing_unverified", "routing_unsupported", "native_runtime_unavailable", "session_axis_invalid", "session_initialization_failed", "session_closed", "session_busy", "session_input_invalid", "native_completion_unknown", "invalid_project_config", "invalid_activation_change", "project_config_locked", "project_config_unavailable"].includes(error.code) ? error.code : "models_operation_failed");
  if (argv.flags.json) process.stdout.write(`${JSON.stringify({ diagnostics: [{ code }] })}\n`);
  out.fail(code);
  process.exit(["invalid_project_config", "invalid_activation_change", "release_evidence_stale", "release_evidence_time_invalid", "release_requirement_unsatisfied", "migration_input_invalid", "migration_decision_invalid", "migration_decision_conflict", "migration_source_invalid", "projection_output_drift", "recommendation_observation_invalid"].includes(code) || code.startsWith("snapshot_") && !["snapshot_unavailable", "snapshot_locked"].includes(code) ? EXIT_CODES.VALIDATION : EXIT_CODES.ENV);
}

/** Explicit project-local enable/disable operation. @returns {void} */
function runActivation() {
  const enabled = verb === "enable";
  const activation = setProjectActivation(resolveRepoRoot(), argv.flags.routing ? { routingEnabled: enabled } : { enabled });
  if (argv.flags.json) process.stdout.write(`${JSON.stringify({ envelope: "ModelsActivation", version: 1, activation })}\n`);
  out.info(`project intelligence: ${activation.enabled}; routing opt-in effective: ${activation.routingEnabled}`);
  out.info("Runtime activation requires a supported integration; no global runtime settings were changed.");
}

/**
 * Whether a refresh left usable evidence for its source: new, confirmed, or retained from the cache.
 * @param {any} result
 * @returns {boolean}
 */
function usable(result) {
  return ["refreshed", "not_modified", "concurrent", "retained"].includes(result.outcome) || result.cached !== null;
}

/**
 * `refresh`: refresh the selected sources (§5 `refresh`).
 *
 * With no filter, every shipped source whose discovery is supported runs, and each is optional: the
 * verb exits 2 only when none of them leaves usable evidence. A source named by `--source` or
 * `--runtime` is required, so it exits 2 when that source has no usable evidence, including when a
 * refresh is in progress elsewhere and no cache exists (§5 exit codes).
 * @returns {Promise<void>}
 */
async function runRefresh() {
  const byId = new Map(SOURCE_ADAPTERS.map((module) => [module.descriptor.id, module]));
  const { source, runtime } = argv.flags;
  if (source !== undefined && !byId.has(source)) usage(`unknown source "${source}" (expected one of: ${[...byId.keys()].join(", ")})`);
  if (runtime !== undefined && !RUNTIME_IDS.includes(runtime)) usage(`unknown runtime "${runtime}" (expected one of: ${RUNTIME_IDS.join(", ")})`);

  const supported = (module) => module?.descriptor.capabilities.discovery.support === "supported";
  const named = [...new Set([source, runtime].filter((id) => id !== undefined))];
  const selected =
    named.length === 0
      ? SOURCE_ADAPTERS.filter(supported).map((module) => ({ id: module.descriptor.id, module, required: false }))
      : named.map((id) => ({ id, module: byId.get(id), required: true }));

  const runnable = selected.filter((s) => supported(s.module));
  const outcomes = await refreshSources(
    runnable.map(({ module }) => ({ module, context: module.descriptor.kind === "knowledge-source" ? { providers: [...PROVIDERS] } : {} })),
    { root: cacheRoot(), knownSourceIds: [...byId.keys()] },
  );
  const results = selected.map((s) => {
    if (!supported(s.module)) {
      const message = s.module === undefined ? `no ${s.id} adapter ships yet, so ${s.id} has no discovery` : `${s.id} has no supported discovery operation`;
      return { sourceId: s.id, required: s.required, outcome: "unsupported", refresh: "idle", cached: null, diagnostic: { code: "discovery_unsupported", message } };
    }
    return { ...outcomes[runnable.indexOf(s)], required: s.required };
  });

  if (argv.flags.json) process.stdout.write(`${JSON.stringify({ envelope: "ModelsRefresh", version: 1, results }, null, 2)}\n`);
  for (const r of results) renderRefresh(r);

  const unavailable = results.some((r) => r.required && !usable(r)) || (results.length > 0 && results.every((r) => !usable(r)));
  process.exit(unavailable ? EXIT_CODES.ENV : EXIT_CODES.OK);
}

/**
 * Print one refresh result as a human line.
 * @param {any} r
 * @returns {void}
 */
function renderRefresh(r) {
  const why = r.diagnostic ? `${r.diagnostic.code}: ${r.diagnostic.message}` : "";
  const kept = r.cached ? `kept the cached evidence from ${r.cached.observedAt}, now ${r.cached.freshness}` : "no cached evidence";
  switch (r.outcome) {
    case "refreshed":
      out.pass(`${r.sourceId}: refreshed (observed ${r.cached.observedAt})`);
      break;
    case "not_modified":
      out.pass(`${r.sourceId}: not modified; the cached evidence is confirmed as of ${r.cached.observedAt}`);
      break;
    case "concurrent":
      out.pass(`${r.sourceId}: another process refreshed it while this one waited`);
      break;
    case "retained":
      out.warn(`${r.sourceId}: ${why}; ${kept}`);
      break;
    case "in_progress":
      (r.cached ? out.warn : out.fail)(`${r.sourceId}: a refresh is in progress in another process (${r.lock.reason}); ${kept}`);
      break;
    case "unsupported":
      (r.required ? out.fail : out.info)(`${r.sourceId}: unsupported — ${why}`);
      break;
    default:
      (r.cached ? out.warn : out.fail)(`${r.sourceId}: refresh failed (${why}); ${kept}`);
  }
}

/**
 * `status`: report every shipped source and the cache, without refreshing (§5 `status`).
 * `--check` fails when the cache is above the OPS-2 limit.
 * @returns {void}
 */
function runStatus() {
  const activation = readProjectActivation(resolveRepoRoot(true));
  out.info(`project intelligence: ${activation.enabled}; routing opt-in effective: ${activation.routingEnabled}`);
  let releaseSnapshot;
  try { releaseSnapshot = releaseSnapshotStatus(readSnapshot(argv.flags["snapshot-file"] ?? DEFAULT_SNAPSHOT_PATH), { now: new Date().toISOString() }); }
  catch (error) { releaseSnapshot = { valid: false, reason: error.code ?? "snapshot_invalid", releaseSnapshotAgeMs: null }; }
  const shippedBaseline = inspectClaudeProjection(fileURLToPath(new URL("../templates/claude", import.meta.url)));
  const localProjection = inspectClaudeProjection(resolve(resolveRepoRoot(true), ".claude"));
  const shippedWorkflow = inspectWorkflowProjection(fileURLToPath(new URL("../templates/workflows", import.meta.url)));
  const installedWorkflow = inspectWorkflowProjection(resolve(resolveRepoRoot(true), ".github/workflows"), shippedWorkflow);
  const mainSessionIntegrations = [
    { runtimeId: "claude", mechanism: "session-only-native-mods", implementation: "experimental", verifiedHostVersions: ["2.1.302"], providerExecution: "unverified", effective: { state: "unknown" } },
    { runtimeId: "codex", mechanism: "managed-app-server", implementation: "supported", verifiedRuntimeVersions: ["0.163.0"], effective: { state: "unknown" } },
  ];
  const report = { activation, mainSessionIntegrations, releaseSnapshot, shippedBaseline, localProjection, shippedWorkflow, installedWorkflow, ...catalogStatus({ sources: SOURCE_ADAPTERS.map((module) => ({ module })), root: cacheRoot(), now: new Date().toISOString() }) };
  if (argv.flags.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  for (const integration of mainSessionIntegrations) out.info(`${integration.runtimeId}: ${integration.mechanism}; ${integration.implementation}; effective session configuration: unknown (inspect the running session)`);
  for (const s of report.sources) {
    const cache = s.cache === null ? "no cache" : `cache ${s.cache.freshness}, observed ${s.cache.observedAt}, ${s.cache.models} model(s)`;
    const failure = s.lastFailure ? `; last refresh failed at ${s.lastFailure.attemptedAt} (${s.lastFailure.code})` : "";
    const invalid = s.invalidEntry ? `; the stored entry is invalid (${s.invalidEntry.code})` : "";
    const lock = s.lock ? `; lock ${s.lock.state} (${s.lock.reason})` : "";
    out.info(`${s.id} (${s.kind}): discovery ${s.discovery}; ${cache}; refresh ${s.refresh}${failure}${invalid}${lock}`);
  }
  out.info(`release snapshot: ${releaseSnapshot.snapshotId ?? "unavailable"}; ${releaseSnapshot.reason}; age ${releaseSnapshot.releaseSnapshotAgeMs ?? "unknown"} ms`);
  if (argv.flags.check && !releaseSnapshot.valid) {
    out.fail(releaseSnapshot.reason); process.exit(releaseSnapshot.reason === "snapshot_unavailable" ? EXIT_CODES.ENV : EXIT_CODES.VALIDATION);
  }
  out.info(`shipped baseline: ${shippedBaseline.status}; local projection: ${localProjection.status}; session execution: not observed`);
  out.info(`shipped workflow: ${shippedWorkflow.status}; installed workflow: ${installedWorkflow.status}; matches shipped: ${installedWorkflow.matchesShipped ?? "unknown"}; session execution: not observed`);
  const { totalBytes, maxBytes, withinLimit } = report.cache;
  if (argv.flags.check && !withinLimit) {
    out.fail(`the capability cache holds ${totalBytes} bytes, above the ${maxBytes}-byte limit (OPS-2)`);
    process.exit(EXIT_CODES.VALIDATION);
  }
  out.info(`cache: ${totalBytes} of ${maxBytes} bytes`);
  process.exit(EXIT_CODES.OK);
}

/** Explicit release-only snapshot command. @returns {Promise<void>} */
async function runSnapshot() {
  const file = resolve(argv.flags["snapshot-file"] ?? DEFAULT_SNAPSHOT_PATH);
  if (argv.flags.check) {
    const status = releaseSnapshotStatus(readSnapshot(file), { now: new Date().toISOString() });
    if (argv.flags.json) process.stdout.write(`${JSON.stringify({ envelope: "ModelsSnapshotCheck", version: 1, ...status }, null, 2)}\n`);
    (status.valid ? out.pass : out.fail)(status.reason);
    process.exit(status.valid ? EXIT_CODES.OK : EXIT_CODES.VALIDATION);
  }
  const candidate = argv.flags["evidence-file"];
  const report = await updateSnapshot({ file, write: argv.flags.write === true,
    collect: () => candidate === undefined ? collectReleaseEvidence(readSnapshot(file)) : readSnapshot(resolve(candidate)),
  });
  if (argv.flags.json) process.stdout.write(`${JSON.stringify({ envelope: "ModelsSnapshot", version: 1, ...report }, null, 2)}\n`);
  else {
    out.info(`snapshot ${report.snapshot.snapshotId}; changed: ${report.changed}; written: ${report.written}`);
    if (report.changed) process.stdout.write(`--- committed snapshot\n+++ candidate snapshot\n${report.after}`);
  }
}

/**
 * Resolve the repository root the same way the sibling bins do.
 * @param {boolean} [allowCurrentDirectory] Preserve status outside a Git repository.
 * @returns {string}
 */
function resolveRepoRoot(allowCurrentDirectory = false) {
  if (argv.flags["repo-root"]) return resolve(argv.flags["repo-root"]);
  const result = spawnSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" });
  if (result.status === 0) return result.stdout.trim();
  if (allowCurrentDirectory) return process.cwd();
  process.stderr.write("cannot resolve repo root — pass --repo-root\n");
  process.exit(EXIT_CODES.ENV);
}

/**
 * `migrate`: report what migrating each artifact's legacy frontmatter would mean. Writes nothing.
 * @returns {void}
 */
async function runMigrate() {
  const repoRoot = resolveRepoRoot();
  // The library owns which kinds can carry a compute declaration, so this filter and
  // the one `interpretLegacy` applies cannot disagree (IMPL-4).
  // `walkArtifacts` yields no workflow today, so `ai-review.yml` — which KD-6
  // projects — is outside this report until P-17 gives it a canonical source.
  const inputs = walkArtifacts(repoRoot)
    .filter((artifact) => canCarryComputeDeclaration(artifact.type))
    .map((artifact) => ({
      sourcePath: artifact.path,
      artifactKind: artifact.type,
      frontmatter: parseFrontmatter(artifact.content).frontmatter ?? {},
    }));

  if (argv.flags.write || argv.flags.check || argv.flags.batch !== undefined || argv.flags.decisions !== undefined) {
    let decisions;
    if (argv.flags.decisions !== undefined) {
      const file = resolve(argv.flags.decisions); const tree = openProjectionTree(dirname(file));
      try { try { decisions = JSON.parse(tree.read(basename(file))); } catch { throw Object.assign(new Error("migration_decision_invalid"), { code: "migration_decision_invalid" }); } } finally { tree.close(); }
    }
    const report = await migrateArtifacts({ root: repoRoot, paths: inputs.map(input => input.sourcePath), decisions, batch: argv.flags.batch, mode: argv.flags.write ? "write" : argv.flags.check ? "check" : "analysis" });
    if (argv.flags.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    else { out.info(`Migration ${report.mode}: ${report.pending.length} pending, ${report.written.length} written, ${report.unresolved.length} owner decisions`); }
    if (argv.flags.check && !report.compliant) process.exitCode = EXIT_CODES.VALIDATION;
    return;
  }
  const compatibility = loadCompatibilityContext(repoRoot);
  const verified = compatibleMigrationPaths(inputs, compatibility);
  const report = analyzeMigration(inputs, verified);
  if (verified.size > 0) report.compatibility = { basis: "accepted-release-capability-evidence", snapshotId: compatibility.snapshotId };

  if (argv.flags.json) {
    // The library owns the envelope, including its name, version, and mode, so the
    // three modes P-18 adds cannot drift into three shapes assembled here (§5).
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    // Severity ordering is a rendering concern and lives here; the set of
    // dispositions is the library's, so a new one still prints.
    const SEVERITY_FIRST = ["invalid-declaration", "conflict", "ambiguous"];
    const ordered = [...SEVERITY_FIRST, ...LEGACY_DISPOSITIONS.filter((d) => !SEVERITY_FIRST.includes(d))];
    for (const disposition of ordered) {
      const entries = report.artifacts.filter((entry) => entry.disposition === disposition);
      if (entries.length === 0) continue;
      out.info(`${disposition}: ${entries.length}`);
      // The two dispositions a human must act on are worth naming; the bulk is not.
      if (SEVERITY_FIRST.includes(disposition)) {
        for (const entry of entries) {
          // Rendered from the codes, which are the contract, rather than from the
          // last element of `notes`, which the library calls presentation.
          out.warn(`  ${entry.sourcePath} — ${entry.codes.join(", ")}`);
          if (entry.conflict) out.warn(`      ${entry.conflict.message}`);
          for (const error of entry.declarationErrors ?? []) out.warn(`      ${error.pointer}: ${error.message}`);
        }
      }
    }
    // "mapped" states only that the legacy alias has a known meaning. It is not an
    // approval: the DOC-1 class-F artifacts still need an owner decision, which
    // IMPL-7 gates before P-19f, and every proposal here is a conservative floor
    // that preserves the authored choice rather than relaxing it.
    out.info("mapped means the legacy alias has a known meaning, not that the migration is approved");
    out.info("every mapped proposal carries MI_PROPOSAL_DEFAULTED: DOC-1 assigns the class per artifact, so an owner decision is still required");
    out.info("analysis only: no artifact was written");
  }

  const conflicts = report.totals.conflict ?? 0;
  const invalid = report.totals["invalid-declaration"] ?? 0;
  if (conflicts > 0 || invalid > 0) {
    if (conflicts > 0) out.fail(`${conflicts} artifact(s) declare a canonical requirement that disagrees with their legacy value`);
    // A declaration that does not parse is a strictly worse case than one that
    // merely disagrees, so it fails the same gate (§5 exit codes).
    if (invalid > 0) out.fail(`${invalid} artifact(s) carry a dotbabel.compute block that does not parse`);
    process.exit(EXIT_CODES.VALIDATION);
  }
  out.pass(`analysed ${report.artifacts.length} artifact(s)`);
}


/** Resolve one artifact or ad hoc requirement through the shared library.
 * @returns {void}
 */
function runResolve() {
  const runtimeId = argv.flags.runtime;
  const workloadClass = argv.flags.requirement;
  const artifactPath = argv.positional[1];
  const artifactKind = argv.flags["artifact-kind"] ?? "command";
  if (!RUNTIME_IDS.includes(runtimeId)) usage("resolve requires a known --runtime");
  if (argv.positional.length > 2 || (artifactPath === undefined) === (workloadClass === undefined)) usage("resolve requires exactly one artifact or --requirement");
  if (workloadClass !== undefined && !WORKLOAD_CLASSES.includes(workloadClass)) usage("unknown workload class");
  if (!ARTIFACT_KINDS.includes(artifactKind)) usage("unknown artifact kind");
  let observation;
  if (argv.flags["observation-file"] !== undefined) {
    const file = resolve(argv.flags["observation-file"]); const tree = openProjectionTree(dirname(file));
    try { try { observation = makeObservedConfiguration(JSON.parse(tree.read(basename(file)))); } catch { throw Object.assign(new Error("recommendation_observation_invalid"), { code: "recommendation_observation_invalid" }); } } finally { tree.close(); }
  }
  const { result, exitCode, context, inputs } = resolveRequest({ repoRoot: resolveRepoRoot(), runtimeId, artifactKind, workloadClass, artifactPath, observed: observation, includeInputs: verb === "recommend" });
  if (verb === "recommend") {
    const adapter = SOURCE_ADAPTERS.find(module => module.descriptor.kind === "runtime" && module.descriptor.id === runtimeId);
    const invocation = result.configuration && typeof adapter?.renderInvocation === "function" ? adapter.renderInvocation(result.configuration) : undefined;
    const assess = configuration => {
      if (!inputs || !configuration?.axes?.model) return undefined;
      return WORKLOAD_CLASSES.filter(requirement => resolveCompute({ ...inputs, observed: undefined, requirement: { requirement, mode: "dynamic", binding: "consumer" }, invocation: { pin: { runtime: runtimeId, config: configuration.axes } } }).status === "resolved").at(-1);
    };
    const assessment = observation?.configurationBasis === "as-run" ? { observedClass: assess(observation), recommendedClass: assess(result.configuration) } : undefined;
    const report = buildRecommendation({ resolverResult: result, observation, assessment, invocation });
    if (argv.flags.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    else {
      out.info(`recommendation: ${report.advice}; confidence: ${result.confidence}; configuration basis: advice`);
      if (result.configuration) out.info(`recommended configuration: ${JSON.stringify(result.configuration.axes)}`);
      if (invocation) out.info(`Invocation: ${invocation.command} ${invocation.args.map(value => "'" + value.replaceAll("'", "'\"'\"'") + "'").join(" ")}`);
      for (const diagnostic of [...result.diagnostics, ...report.diagnostics]) out.warn(diagnostic.code);
    }
    process.exit(exitCode);
  }
  if (argv.flags.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else {
    out.info(`target: ${runtimeId} / ${artifactKind}`);
    out.info(`requirement: ${context?.requirement?.requirement ?? context?.requirement?.mode ?? "none"}`);
    if (context?.floor) out.info(`floor: ${context.floor.requirement}`);
    if (context?.pin) out.info(`pin: explicit ${context.pin.runtime} configuration`);
    out.info(`resolution: ${result.status}; enforcement: ${result.enforcement.state} (${result.enforcement.basis}); confidence: ${result.confidence}`);
    if (result.configuration) {
      out.info(`configuration: ${JSON.stringify(result.configuration.axes)}`);
      out.info(`representation: ${result.configuration.representation.kind}; source: ${result.configuration.representation.provenance.sourceId}`);
    }
    for (const reason of result.explanation) out.info(`${reason.code}: ${reason.message}`);
    for (const diagnostic of result.diagnostics) out.warn(`${diagnostic.code}: ${diagnostic.message}`);
  }
  process.exit(exitCode);
}
