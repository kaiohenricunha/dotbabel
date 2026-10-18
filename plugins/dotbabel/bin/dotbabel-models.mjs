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
 *   and writes nothing. `--write` and `--check` arrive with P-18, behind the batching and
 *   preserved-behaviour gates of IMPL-2.
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
import { PROVIDERS, RUNTIME_IDS, WORKLOAD_CLASSES, ARTIFACT_KINDS } from "../src/model-intelligence/domain/index.mjs";
import { SOURCE_ADAPTERS } from "../src/model-intelligence/sources/index.mjs";
import { resolveRequest } from "../src/model-intelligence/cli/resolve.mjs";
import { catalogStatus, refreshSources } from "../src/model-intelligence/catalog/index.mjs";
import { cacheRoot } from "../src/model-intelligence/catalog/cache.mjs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const META = {
  name: "dotbabel-models",
  synopsis: "dotbabel-models <verb> [OPTIONS]",
  description:
    "Model Intelligence. Verbs: resolve [artifact | --requirement <class>] --runtime <id> [--artifact-kind <kind>] — resolve and explain using cached evidence only; refresh [--source <id>] [--runtime <id>] — refresh the capability cache; status [--check] — report sources, cache freshness and refresh state, never refreshing; migrate — report what migrating each artifact's legacy model/effort frontmatter would mean, writing nothing.",
  flags: {
    "repo-root": { type: "string" },
    source: { type: "string" },
    runtime: { type: "string" },
    check: { type: "boolean" },
    requirement: { type: "string" },
    "artifact-kind": { type: "string" },
    json: { type: "boolean" },
  },
};

const VERBS = Object.freeze(["refresh", "status", "migrate", "resolve"]);

/** The flags each verb accepts, beyond the harness-wide set. Any other is a usage error. */
const VERB_FLAGS = Object.freeze({
  refresh: ["source", "runtime"],
  status: ["check"],
  migrate: ["repo-root"],
  resolve: ["repo-root", "runtime", "requirement", "artifact-kind"],
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
for (const flag of ["repo-root", "source", "runtime", "check", "requirement", "artifact-kind"]) {
  if (argv.flags[flag] !== undefined && !VERB_FLAGS[verb].includes(flag)) usage(`--${flag} does not apply to ${verb}`);
}
if (!["migrate", "resolve"].includes(verb) && argv.positional.length > 1) usage(`${verb} takes no positional argument`);

// Under `--json`, stdout carries exactly one JSON document, so every human line
// goes to stderr. A caller piping the report into `jq` gets the report, not the
// report plus a summary sentence (§5, "JSON contract").
const out = createOutput({ noColor: argv.noColor, stream: argv.flags.json ? process.stderr : process.stdout });

if (verb === "refresh") await runRefresh();
else if (verb === "status") runStatus();
else if (verb === "resolve") runResolve();
else runMigrate();

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
  const report = catalogStatus({ sources: SOURCE_ADAPTERS.map((module) => ({ module })), root: cacheRoot(), now: new Date().toISOString() });
  if (argv.flags.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  for (const s of report.sources) {
    const cache = s.cache === null ? "no cache" : `cache ${s.cache.freshness}, observed ${s.cache.observedAt}, ${s.cache.models} model(s)`;
    const failure = s.lastFailure ? `; last refresh failed at ${s.lastFailure.attemptedAt} (${s.lastFailure.code})` : "";
    const invalid = s.invalidEntry ? `; the stored entry is invalid (${s.invalidEntry.code})` : "";
    const lock = s.lock ? `; lock ${s.lock.state} (${s.lock.reason})` : "";
    out.info(`${s.id} (${s.kind}): discovery ${s.discovery}; ${cache}; refresh ${s.refresh}${failure}${invalid}${lock}`);
  }
  const { totalBytes, maxBytes, withinLimit } = report.cache;
  if (argv.flags.check && !withinLimit) {
    out.fail(`the capability cache holds ${totalBytes} bytes, above the ${maxBytes}-byte limit (OPS-2)`);
    process.exit(EXIT_CODES.VALIDATION);
  }
  out.info(`cache: ${totalBytes} of ${maxBytes} bytes`);
  process.exit(EXIT_CODES.OK);
}

/**
 * Resolve the repository root the same way the sibling bins do.
 * @returns {string}
 */
function resolveRepoRoot() {
  if (argv.flags["repo-root"]) return resolve(argv.flags["repo-root"]);
  const result = spawnSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" });
  if (result.status === 0) return result.stdout.trim();
  process.stderr.write("cannot resolve repo root — pass --repo-root\n");
  process.exit(EXIT_CODES.ENV);
}

/**
 * `migrate`: report what migrating each artifact's legacy frontmatter would mean. Writes nothing.
 * @returns {void}
 */
function runMigrate() {
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

  const report = analyzeMigration(inputs);

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
  const { result, exitCode, context } = resolveRequest({ repoRoot: resolveRepoRoot(), runtimeId, artifactKind, workloadClass, artifactPath });
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
