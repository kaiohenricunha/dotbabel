#!/usr/bin/env node
// attest-scope.mjs — run one local-attest leg on the scope of a pull request.
//
// Usage: node plugins/dotbabel/scripts/attest-scope.mjs <lint|test|bats>
//
// `.local-attest.config.mjs` runs the lint, test and bats legs through this
// script with `scope: true`. The runner passes the PR's changed files as
// DOTBABEL_ATTEST_CHANGED_FILES (a JSON file) and a per-leg
// DOTBABEL_ATTEST_SKIP_FILE. When nothing of the leg is in scope this script
// writes a one-line reason to the skip file and exits 0, and the runner records
// the leg as "skipped". The selection logic is plugins/dotbabel/src/attest-scope.mjs;
// every dotbabel-specific path lives here.
//
// This file is a GOVERNANCE FILE (.dotbabel.json -> attestation.governance_files):
// a pull request that rewrote it to skip everything could not attest itself.
//
// FAIL-OPEN: no readable changed-file list means the FULL leg, exactly as the
// matrix ran it before scoping (`npm run lint`, `npm test -- --coverage`,
// `bash plugins/dotbabel/scripts/run-bats.sh`).
//
// Must-run: the `quality` leg reuses this script's lint and test results
// (`--reuse lint=lint --reuse test=test --reuse coverage=test`). Whenever quality
// will measure a changed file — it matches quality.critical_paths or the `paths`
// of the reused quality tool in .dotbabel.json — the leg must not skip, or
// quality would re-run the whole tool itself. Those globs are read from
// .dotbabel.json, the one source both sides share. When such a leg reaches
// nothing scoped, it runs in full instead.
//
// An empty pass is never recorded: a scoped vitest run whose json report shows
// zero tests becomes a skip (or a full run when must-run matched).
//
// Known gaps: the path search finds a test that names a changed file, its
// basename, or a bin/script whose static import closure reaches it. It misses a
// module reached only through a computed `import()` specifier, and a bin that a
// shell script starts without any test naming that bin.

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  SKIP_FILE_ENV,
  entrypointsReaching,
  matchesAnyGlob,
  readChangedFiles,
  scopeGlobToRegExp,
  selectTests,
  vitestScopedArgs,
  vitestTestCount,
} from "../src/attest-scope.mjs";

/** The unscoped leg commands, byte-for-byte what the matrix ran before scoping. */
export const FULL_COMMANDS = Object.freeze({
  lint: ["npm", ["run", "lint"]],
  test: ["npm", ["test", "--", "--coverage"]],
  bats: ["bash", ["plugins/dotbabel/scripts/run-bats.sh"]],
});

const TEST_GLOBS = ["plugins/dotbabel/tests/**/*.test.mjs"];
const SOURCE_GLOBS = ["**/*.{mjs,js,cjs}"];
// Inputs of EVERY vitest test: the config, the dependency manifests, and the
// globalSetup/setupFiles chain vitest.config.mjs names.
const TEST_FULL_TRIGGERS = [
  "vitest.config.mjs",
  "package.json",
  "package-lock.json",
  "plugins/dotbabel/tests/fixtures/temp-root.mjs",
  "plugins/dotbabel/tests/fixtures/temp-dir-setup.mjs",
  "plugins/dotbabel/tests/fixtures/temp-dir.mjs",
];
const BATS_GLOBS = ["plugins/dotbabel/tests/bats/*.bats"];
// The wrapper itself and every non-.bats file beside the suites (helpers.bash).
const BATS_FULL_TRIGGERS = ["plugins/dotbabel/scripts/run-bats.sh", "plugins/dotbabel/tests/bats/**"];
const ENTRYPOINT_DIRS = ["plugins/dotbabel/bin", "plugins/dotbabel/scripts", "scripts"];
// A changed lint config is an input of every linted file.
const LINT_FULL_TRIGGERS = [
  "package.json",
  "package-lock.json",
  ".gitignore",
  ".prettierignore",
  ".prettierrc*",
  ".markdownlint*",
  "scripts/check-jsdoc-coverage.mjs",
];

/**
 * @typedef {object} ScopeIo
 * @property {(p: string) => string} readText  throws when unreadable
 * @property {(p: string) => boolean} exists
 * @property {(p: string, text: string) => void} writeText
 * @property {(dir: string) => string[]} listFiles  repo-relative files below dir, recursive; [] when absent
 * @property {(cmd: string, args: string[]) => number} run  exit status, output inherited
 * @property {() => string} tempDir  a fresh directory; removed by `cleanup`
 * @property {(dir: string) => void} cleanup
 * @property {(msg: string) => void} log
 */

/**
 * The globs that force a leg to run, read from `.dotbabel.json`'s quality
 * policy: critical paths (they force quality's `test` capability) plus the
 * `paths` of each named tool. Unreadable policy → null, which callers treat
 * as "everything must run".
 *
 * @param {ScopeIo} io
 * @param {string[]} tools  quality capabilities this leg answers for
 * @param {{ critical?: boolean }} [opts]
 * @returns {string[]|null}
 */
export function mustRunGlobs(io, tools, { critical = false } = {}) {
  let quality;
  try {
    quality = JSON.parse(io.readText(".dotbabel.json")).quality;
  } catch {
    return null;
  }
  if (!quality || typeof quality !== "object") return null;
  const globs = critical && Array.isArray(quality.critical_paths) ? [...quality.critical_paths] : [];
  for (const component of quality.components ?? []) {
    for (const tool of tools) {
      const spec = component?.tools?.[tool];
      if (!spec) continue;
      // A reused tool with no `paths` runs on every diff, so every change is a must-run.
      if (!Array.isArray(spec.paths)) return null;
      globs.push(...spec.paths);
    }
  }
  return globs;
}

/**
 * Split an npm script into `&&` segments of argv tokens. Double quotes group;
 * anything more shell-like (pipes, `;`, `||`, single quotes, `$`) returns null.
 *
 * @param {string} script
 * @returns {string[][]|null}
 */
export function parseScript(script) {
  if (typeof script !== "string" || /[|;'$`<>]/.test(script)) return null;
  return script.split("&&").map((segment) =>
    [...segment.trim().matchAll(/"([^"]*)"|(\S+)/g)].map((m) => (m[1] !== undefined ? m[1] : m[2])),
  );
}

/**
 * Build the scoped lint commands from `package.json`'s `lint` script, so the
 * flags, globs and exclusions stay in their one source. Each recognised
 * segment keeps its own arguments with its file glob replaced by the changed
 * files it covers; a segment with no such file is dropped.
 *
 * @param {string} script  `scripts.lint`
 * @param {string[]} files  existing changed files
 * @returns {Array<[string, string[]]>|null}  null when a segment is not recognised (→ run the full lint)
 */
export function scopedLintCommands(script, files) {
  const segments = parseScript(script);
  if (!segments) return null;
  /** @type {Array<[string, string[]]>} */
  const out = [];
  for (const tokens of segments) {
    const [tool] = tokens;
    if (tool === "prettier" || tool === "markdownlint-cli2") {
      const at = tokens.findIndex((t, i) => i > 0 && !t.startsWith("-") && !t.startsWith("#") && t.includes("*"));
      if (at === -1) return null;
      const re = scopeGlobToRegExp(tokens[at]);
      const hits = files.filter((f) => re.test(f));
      if (hits.length > 0) out.push(["npx", [...tokens.slice(0, at), ...hits, ...tokens.slice(at + 1)]]);
    } else if (tool === "node" && /check-jsdoc-coverage\.mjs$/.test(tokens[1] ?? "")) {
      const roots = tokens.length > 2 ? tokens.slice(2) : ["plugins/dotbabel/src"];
      const hits = files.filter((f) => f.endsWith(".mjs") && roots.some((r) => f.startsWith(`${r.replace(/\/$/, "")}/`)));
      if (hits.length > 0) out.push(["node", [tokens[1], ...hits]]);
    } else {
      return null;
    }
  }
  return out;
}

/**
 * Write the skip reason and log it.
 *
 * @param {ScopeIo} io
 * @param {Record<string, string|undefined>} env
 * @param {string} reason
 * @returns {number}
 */
function skip(io, env, reason) {
  const file = env[SKIP_FILE_ENV];
  if (typeof file !== "string" || file === "") {
    // No skip channel to report through: running nothing and exiting 0 would
    // read as a pass. Refuse instead.
    io.log(`attest-scope: nothing in scope (${reason}), but ${SKIP_FILE_ENV} is unset — failing rather than passing empty`);
    return 1;
  }
  io.writeText(file, `${reason}\n`);
  io.log(`attest-scope: skipped — ${reason}`);
  return 0;
}

/**
 * Run the leg in full.
 *
 * @param {ScopeIo} io
 * @param {"lint"|"test"|"bats"} leg
 * @param {string} why
 * @returns {number}
 */
function runFull(io, leg, why) {
  io.log(`attest-scope: ${leg} runs in full — ${why}`);
  const [cmd, args] = FULL_COMMANDS[leg];
  return io.run(cmd, [...args]);
}

/**
 * Entry points a test may start as a child process, and which of them reach a
 * changed file through static imports.
 *
 * @param {ScopeIo} io
 * @param {string[]} changed
 * @returns {string[]}
 */
function reachingEntrypoints(io, changed) {
  const entrypoints = ENTRYPOINT_DIRS.flatMap((dir) =>
    io.listFiles(dir).filter((f) => path.posix.dirname(f) === dir && f.endsWith(".mjs")),
  );
  return entrypointsReaching({ entrypoints, changedFiles: changed, readText: io.readText });
}

/**
 * Read the files matching `globs` below `dir` with their contents.
 *
 * @param {ScopeIo} io
 * @param {string} dir
 * @param {string[]} globs
 * @returns {Array<{ path: string, content: string }>}
 */
function textFiles(io, dir, globs) {
  return io
    .listFiles(dir)
    .filter((f) => matchesAnyGlob(f, globs))
    .map((f) => ({ path: f, content: io.readText(f) }));
}

/**
 * @param {ScopeIo} io
 * @param {Record<string, string|undefined>} env
 * @param {string[]} changed
 * @returns {number}
 */
function lintLeg(io, env, changed) {
  const trigger = changed.find((f) => matchesAnyGlob(f, LINT_FULL_TRIGGERS));
  if (trigger) return runFull(io, "lint", `${trigger} changed, and it configures every linted file`);
  let script;
  try {
    script = JSON.parse(io.readText("package.json")).scripts?.lint;
  } catch {
    script = undefined;
  }
  const commands = scopedLintCommands(script, changed.filter((f) => io.exists(f)));
  if (commands === null) return runFull(io, "lint", "the lint script has a shape this scoper does not know");
  if (commands.length === 0) {
    const mustRun = mustRunGlobs(io, ["lint"]);
    const forced = mustRun === null ? changed[0] : changed.find((f) => matchesAnyGlob(f, mustRun));
    if (forced !== undefined) return runFull(io, "lint", `nothing lintable is left, but ${forced} is measured by quality's lint`);
    return skip(io, env, "no changed file is linted");
  }
  for (const [cmd, args] of commands) {
    io.log(`attest-scope: ${cmd} ${args.join(" ")}`);
    const code = io.run(cmd, args);
    if (code !== 0) return code;
  }
  return 0;
}

/**
 * @param {ScopeIo} io
 * @param {Record<string, string|undefined>} env
 * @param {string[]} changed
 * @returns {number}
 */
function testLeg(io, env, changed) {
  const mustRun = mustRunGlobs(io, ["test", "coverage"], { critical: true });
  const forced = mustRun === null ? changed[0] : changed.find((f) => matchesAnyGlob(f, mustRun));
  const selection = selectTests({
    changedFiles: changed,
    exists: io.exists,
    testFiles: textFiles(io, "plugins/dotbabel/tests", TEST_GLOBS),
    testGlobs: TEST_GLOBS,
    sourceGlobs: SOURCE_GLOBS,
    fullTriggers: TEST_FULL_TRIGGERS,
    mustRun: mustRun ?? ["**"],
    entrypoints: reachingEntrypoints(io, changed),
  });
  if (selection.mode === "full") return runFull(io, "test", selection.reason);
  if (selection.mode === "skip") return skip(io, env, selection.reason);
  if (selection.sources.length === 0 && selection.tests.length === 0) {
    return runFull(io, "test", `${forced} must be tested and no scoped test reaches it`);
  }
  const dir = io.tempDir();
  try {
    const report = path.join(dir, "vitest.json");
    const args = vitestScopedArgs({ ...selection, coverage: true, jsonReport: report });
    io.log(`attest-scope: vitest ${args.join(" ")}`);
    const code = io.run("npx", ["vitest", ...args]);
    if (code !== 0) return code;
    let count = null;
    try {
      count = vitestTestCount(io.readText(report));
    } catch {
      // Unreadable report: the count is unknown, handled below.
    }
    if (count === null) return runFull(io, "test", "the scoped run's test count is unknown");
    if (count > 0) return 0;
    if (forced !== undefined) return runFull(io, "test", `${forced} must be tested and the scoped run reached no test`);
    return skip(io, env, "the scoped selection reached no test");
  } finally {
    io.cleanup(dir);
  }
}

/**
 * @param {ScopeIo} io
 * @param {Record<string, string|undefined>} env
 * @param {string[]} changed
 * @returns {number}
 */
function batsLeg(io, env, changed) {
  const selection = selectTests({
    changedFiles: changed,
    exists: io.exists,
    testFiles: textFiles(io, "plugins/dotbabel/tests/bats", BATS_GLOBS),
    testGlobs: BATS_GLOBS,
    sourceGlobs: [],
    fullTriggers: BATS_FULL_TRIGGERS,
    entrypoints: reachingEntrypoints(io, changed),
  });
  if (selection.mode === "full") return runFull(io, "bats", selection.reason);
  if (selection.mode === "skip") return skip(io, env, "no bats suite is in the scope of this pull request's changes");
  return io.run("bash", ["plugins/dotbabel/scripts/run-bats.sh", ...selection.tests]);
}

/**
 * Run one leg on the PR's scope. Returns the exit code.
 *
 * @param {{ argv: string[], env: Record<string, string|undefined>, io: ScopeIo }} input
 * @returns {number}
 */
export function main({ argv, env, io }) {
  const leg = argv[0];
  if (leg !== "lint" && leg !== "test" && leg !== "bats") {
    io.log("usage: attest-scope.mjs <lint|test|bats>");
    return 64;
  }
  const changed = readChangedFiles(env, io.readText);
  if (changed === null) return runFull(io, leg, "the changed-file list is unavailable");
  if (leg === "lint") return lintLeg(io, env, changed);
  if (leg === "test") return testLeg(io, env, changed);
  return batsLeg(io, env, changed);
}

/**
 * The real filesystem and process, rooted at the current directory.
 *
 * @returns {ScopeIo}
 */
export function realIo() {
  const listFiles = (dir) => {
    /** @type {string[]} */
    const out = [];
    const walk = (rel) => {
      let entries;
      try {
        entries = readdirSync(rel, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const child = path.posix.join(rel, e.name);
        if (e.isDirectory()) walk(child);
        else if (e.isFile()) out.push(child);
      }
    };
    walk(dir);
    return out.sort();
  };
  return {
    readText: (p) => readFileSync(p, "utf8"),
    exists: (p) => existsSync(p),
    writeText: (p, text) => writeFileSync(p, text),
    listFiles,
    run: (cmd, args) => spawnSync(cmd, args, { stdio: "inherit" }).status ?? 1,
    tempDir: () => mkdtempSync(path.join(os.tmpdir(), "attest-scope-")),
    cleanup: (dir) => rmSync(dir, { recursive: true, force: true }),
    log: (msg) => process.stderr.write(`${msg}\n`),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = main({ argv: process.argv.slice(2), env: process.env, io: realIo() });
}
