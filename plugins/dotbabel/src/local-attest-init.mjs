/**
 * local-attest-init — draft a `.local-attest.config.mjs` from a repo's
 * GitHub Actions workflows.
 *
 * Hand-writing the matrix is the single biggest cost of adopting
 * local-attest, and it is mechanical work: the legs are the `run:` steps CI
 * already executes. This module reads the workflows and drafts the config.
 *
 * SAFETY: the output is a DRAFT for a human to review, never a finished gate.
 * An attestation switches remote CI off, so a matrix that quietly omits a job
 * certifies work nobody did. Everything here is therefore biased toward
 * over-reporting: constructs that cannot be translated become warnings the
 * renderer writes into the file as TODO comments, every leg carries a
 * provenance comment naming the workflow, job, and step it mirrors, and the
 * file opens with a review banner. Nothing in this module ever runs a leg or
 * posts anything.
 *
 * Pure functions only — all file I/O lives in the bin, matching pr-stack.
 *
 * @typedef {object} WorkflowFile
 * @property {string} path  repo-relative path, used in provenance and warnings
 * @property {string} text  raw YAML
 *
 * @typedef {object} DraftLeg
 * @property {string} name
 * @property {"hard"|"advisory"} mode
 * @property {string} command
 * @property {string} [cwd]
 * @property {string} lane
 * @property {{ changedPaths: string[] }} [when]
 * @property {string} source  provenance, rendered as a comment
 */

import yaml from "js-yaml";

/** Steps whose `uses:` is pure CI plumbing with no local equivalent. */
const PLUMBING = /^actions\/(checkout|setup-|cache|upload-|download-)/;

/**
 * Workflows that ship something rather than check something. They often do
 * trigger on pull_request (preview environments), so their steps are drafted
 * like any other — but running a deploy locally to satisfy a gate is almost
 * never what the author wants, and these workflows tend to dominate the leg
 * count. Flagged for pruning, never dropped: guessing wrong here would remove
 * a real check.
 */
const SHIPPING = /(deploy|preview|release|publish|cleanup)/i;

/**
 * Job-level keys that change what CI actually runs and have no config
 * equivalent, so a draft that ignored them would overstate its coverage.
 */
const UNTRANSLATABLE = [
  ["strategy", "strategy.matrix runs this job several times; the draft keeps one leg"],
  ["if", "if: condition gates this job in CI; mirror it with when.changedPaths or drop the leg"],
  ["services", "services containers are provisioned by CI; the leg must provision them locally"],
  ["container", "container: runs this job in an image; the leg runs on the host instead"],
  ["environment", "environment: may inject secrets the local leg will not have"],
];

/**
 * Parse one workflow, tolerating malformed YAML.
 *
 * @param {WorkflowFile} file
 * @returns {{ doc: Record<string, unknown>|null, error: string|null }}
 */
function parseWorkflow(file) {
  try {
    const doc = yaml.load(file.text);
    if (!doc || typeof doc !== "object") return { doc: null, error: "not a YAML mapping" };
    return { doc: /** @type {Record<string, unknown>} */ (doc), error: null };
  } catch (err) {
    return { doc: null, error: err.message.split("\n")[0] };
  }
}

/**
 * The `on:` block, normalised. YAML parses a bare `on` as the boolean true,
 * so both spellings have to be probed.
 *
 * @param {Record<string, unknown>} doc
 * @returns {Record<string, unknown>|string[]|null}
 */
function triggers(doc) {
  const raw = doc.on ?? doc[true];
  if (!raw) return null;
  return /** @type {Record<string, unknown>|string[]} */ (raw);
}

/**
 * True when the workflow runs on pull_request. A workflow that does not is
 * not part of the PR gate, so attesting says nothing about it.
 *
 * @param {Record<string, unknown>} doc
 * @returns {boolean}
 */
function runsOnPullRequest(doc) {
  const on = triggers(doc);
  if (!on) return false;
  if (Array.isArray(on)) return on.includes("pull_request");
  if (typeof on === "string") return on === "pull_request";
  return Object.prototype.hasOwnProperty.call(on, "pull_request");
}

/**
 * The `pull_request.paths` filter, if the workflow declares one. Mirroring it
 * as `when.changedPaths` keeps the local leg scoped exactly like the CI job.
 *
 * @param {Record<string, unknown>} doc
 * @returns {string[]|null}
 */
function pullRequestPaths(doc) {
  const on = triggers(doc);
  if (!on || Array.isArray(on) || typeof on === "string") return null;
  const pr = /** @type {Record<string, unknown>} */ (on).pull_request;
  if (!pr || typeof pr !== "object") return null;
  const paths = /** @type {Record<string, unknown>} */ (pr).paths;
  if (!Array.isArray(paths) || paths.length === 0) return null;
  return paths.map(String);
}

/**
 * Read toolchain pins out of setup-node / setup-go steps.
 *
 * `node` must be an exact major for the schema, so "22.x" and "22.11.0" are
 * reduced to "22"; a non-numeric spec (e.g. "lts/*") is dropped rather than
 * guessed, because a wrong pin fails every attest run closed.
 *
 * @param {WorkflowFile[]} fileList
 * @returns {{node?: string, goMod?: string}|null}
 */
export function toolchainFromWorkflows(fileList) {
  /** @type {{node?: string, goMod?: string}} */
  const out = {};
  for (const file of fileList) {
    const { doc } = parseWorkflow(file);
    if (!doc || !runsOnPullRequest(doc)) continue;
    for (const job of Object.values(doc.jobs ?? {})) {
      for (const step of job?.steps ?? []) {
        const uses = typeof step?.uses === "string" ? step.uses : "";
        const w = step?.with ?? {};
        if (uses.startsWith("actions/setup-node") && !out.node) {
          const major = String(w["node-version"] ?? "").match(/^(\d+)/);
          if (major) out.node = major[1];
        }
        if (uses.startsWith("actions/setup-go") && !out.goMod) {
          const file2 = w["go-version-file"];
          if (typeof file2 === "string" && file2) out.goMod = file2;
        }
      }
    }
  }
  return Object.keys(out).length > 0 ? out : null;
}

/**
 * Draft a matrix from the workflows that gate pull requests.
 *
 * One leg per `run:` step: a step is the smallest unit whose failure CI
 * reports independently, and collapsing a job's steps into one leg would hide
 * which one broke. Legs are laned by job so independent jobs run
 * concurrently, matching how CI schedules them.
 *
 * @param {WorkflowFile[]} fileList
 * @returns {{ legs: DraftLeg[], warnings: string[] }}
 */
export function matrixFromWorkflows(fileList) {
  /** @type {DraftLeg[]} */
  const legs = [];
  /** @type {string[]} */
  const warnings = [];

  for (const file of fileList) {
    const { doc, error } = parseWorkflow(file);
    if (error || !doc) {
      warnings.push(`${file.path}: could not parse (${error ?? "empty"}) — skipped entirely`);
      continue;
    }
    if (!runsOnPullRequest(doc)) {
      warnings.push(`${file.path}: no pull_request trigger — skipped (it does not gate a PR)`);
      continue;
    }

    const paths = pullRequestPaths(doc);
    const jobs = /** @type {Record<string, any>} */ (doc.jobs ?? {});
    const legsBefore = legs.length;

    for (const [jobId, job] of Object.entries(jobs)) {
      if (!job || typeof job !== "object") continue;

      for (const [key, message] of UNTRANSLATABLE) {
        if (job[key] !== undefined) warnings.push(`${file.path} job "${jobId}": ${message}`);
      }
      if (job.needs !== undefined) {
        const needs = Array.isArray(job.needs) ? job.needs.join(", ") : String(job.needs);
        warnings.push(
          `${file.path} job "${jobId}": needs [${needs}] — lanes run concurrently, so order ` +
            `across jobs is not preserved; merge dependent jobs into one lane if it matters`,
        );
      }

      const jobCwd = job.defaults?.run?.["working-directory"];
      const steps = Array.isArray(job.steps) ? job.steps : [];

      for (const step of steps) {
        if (!step || typeof step !== "object") continue;
        if (typeof step.uses === "string") {
          if (!PLUMBING.test(step.uses)) {
            warnings.push(
              `${file.path} job "${jobId}": step uses ${step.uses} — no local equivalent, ` +
                `no leg drafted; add one by hand if it gates anything`,
            );
          }
          continue;
        }
        if (typeof step.run !== "string" || step.run.trim() === "") continue;

        const label = typeof step.name === "string" && step.name ? step.name : step.run.trim();
        const cwd = step["working-directory"] ?? jobCwd;
        /** @type {DraftLeg} */
        const leg = {
          name: `${jobId}: ${label}`.slice(0, 80),
          mode:
            step["continue-on-error"] === true || job["continue-on-error"] === true
              ? "advisory"
              : "hard",
          command: step.run.trim(),
          lane: jobId,
          source: `${file.path} job "${jobId}" step "${label}"`,
        };
        if (typeof cwd === "string" && cwd) leg.cwd = cwd;
        if (paths) leg.when = { changedPaths: paths };
        if (step.env && typeof step.env === "object") {
          const stringly = Object.entries(step.env).every(([, v]) => typeof v === "string");
          if (stringly) leg.env = /** @type {Record<string,string>} */ (step.env);
          else
            warnings.push(
              `${file.path} job "${jobId}" step "${label}": env has non-string values — dropped`,
            );
        }
        legs.push(leg);
      }
    }

    const drafted = legs.length - legsBefore;
    if (drafted > 0 && SHIPPING.test(file.path)) {
      warnings.push(
        `${file.path}: drafted ${drafted} leg(s), but this workflow looks like it ships ` +
          `rather than checks — deploy steps rarely belong in an attestation matrix. ` +
          `Prune the ones that do not verify anything.`,
      );
    }
  }

  const seen = new Set();
  for (const leg of legs) {
    let name = leg.name;
    for (let i = 2; seen.has(name); i++) name = `${leg.name} (${i})`;
    leg.name = name;
    seen.add(name);
  }

  return { legs, warnings };
}

/**
 * Render a draft config as `.local-attest.config.mjs` source.
 *
 * Warnings become TODO comments in the file itself rather than terminal
 * output: the file outlives the terminal, and an unreviewed warning is
 * exactly how a matrix ends up certifying a job it never ran.
 *
 * @param {{ legs: DraftLeg[], warnings: string[], toolchain: {node?: string, goMod?: string}|null }} draft
 * @returns {string}
 */
export function renderConfig({ legs, warnings, toolchain }) {
  const q = (s) => JSON.stringify(s);
  const out = [];

  out.push("// .local-attest.config.mjs — DRAFTED by `dotbabel local-attest --init`.");
  out.push("//");
  out.push("// !! REVIEW THIS FILE BEFORE YOU ATTEST ANYTHING !!");
  out.push("//");
  out.push("// A green attestation switches remote CI OFF for that commit, so this");
  out.push("// matrix becomes the only gate. A leg that is missing here is enforced");
  out.push("// nowhere. The generator can only see `run:` steps — it cannot see what");
  out.push("// a marketplace action does, what a service container provides, or what");
  out.push("// a job-level `if:` decides. Walk your workflows and this file side by");
  out.push("// side once, fix every TODO below, then delete this banner.");
  out.push("");

  if (warnings.length > 0) {
    out.push(`// ${warnings.length} thing(s) the generator could not translate:`);
    for (const w of warnings) out.push(`// TODO: ${w}`);
    out.push("");
  }

  out.push("export default {");
  out.push("  matrix: [");
  for (const leg of legs) {
    out.push(`    // ${leg.source}`);
    out.push("    {");
    out.push(`      name: ${q(leg.name)},`);
    out.push(`      mode: ${q(leg.mode)},`);
    out.push(`      lane: ${q(leg.lane)},`);
    out.push(`      command: ${q(leg.command)},`);
    if (leg.cwd) out.push(`      cwd: ${q(leg.cwd)},`);
    if (leg.env) out.push(`      env: ${JSON.stringify(leg.env)},`);
    if (leg.when)
      out.push(`      when: { changedPaths: ${JSON.stringify(leg.when.changedPaths)} },`);
    out.push("    },");
  }
  out.push("  ],");
  out.push("");
  if (toolchain) {
    out.push("  // Pins read from setup-node / setup-go. An attest run fails closed");
    out.push("  // when the local toolchain does not match.");
    out.push(`  toolchain: ${JSON.stringify(toolchain)},`);
  } else {
    out.push("  // TODO: no toolchain pin found. Without one, a local run on a different");
    out.push("  // runtime than CI can attest a result CI would not reproduce.");
    out.push('  // toolchain: { node: "22", goMod: "api/go.mod" },');
  }
  out.push("");
  out.push("  // TODO: does any leg overwrite a tracked file (e2e seeders do)? List those");
  out.push("  // paths here or every run aborts on its own writes.");
  out.push("  restoreFiles: [],");
  out.push("};");
  out.push("");

  return out.join("\n");
}
