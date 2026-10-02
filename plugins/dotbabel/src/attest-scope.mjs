/**
 * attest-scope — pure selection logic for a PR-scoped local-attest leg.
 *
 * `local-attest` runs only the scope of a pull request's changes. A leg that
 * declares `scope: true` receives the PR's changed-file list through
 * `DOTBABEL_ATTEST_CHANGED_FILES` and decides for itself what of its work is in
 * scope. This module is that decision, with no repository-specific path in it:
 * the caller passes every path, glob and file content. A repository's governed
 * wrapper script (for dotbabel itself, `plugins/dotbabel/scripts/attest-scope.mjs`)
 * holds the specifics and turns a selection into a command.
 *
 * Direction of every error: running too much is safe, running too little is
 * not. So the reader fails open (an unknown list means "run the full leg"), a
 * changed shared input (config, manifest, lockfile, setup file) selects the
 * full suite, and the path search over-selects rather than under-selects — a
 * basename match is enough.
 *
 * Known gap: the import graph is static. A module reached only through a
 * computed `import()` specifier, or a bin started by a shell script rather than
 * named in a test, is not found by the graph walk.
 *
 * @typedef {{ path: string, content: string }} TextFile
 *
 * @typedef {{ mode: "full", reason: string }
 *         | { mode: "scoped", sources: string[], tests: string[], reason: string }
 *         | { mode: "skip", reason: string }} TestSelection
 */

import path from "node:path";

/** Env var naming the JSON file that holds the PR's changed repo-relative paths. */
export const CHANGED_FILES_ENV = "DOTBABEL_ATTEST_CHANGED_FILES";

/** Env var naming the file a scoped leg writes a one-line reason into when nothing is in scope. */
export const SKIP_FILE_ENV = "DOTBABEL_ATTEST_SKIP_FILE";

/**
 * Read the changed-file list the runner passed. FAIL-OPEN: null means
 * "unknown — run the full leg".
 *
 * An empty list is null too. The runner never passes one, and a leg that read
 * "zero files changed" as "nothing in scope" would skip everything.
 *
 * @param {Record<string, string|undefined>} env
 * @param {(path: string) => string} readText  utf8 read; may throw
 * @returns {string[]|null}  repo-relative paths, deleted and renamed-from paths included
 */
export function readChangedFiles(env, readText) {
  const file = env?.[CHANGED_FILES_ENV];
  if (typeof file !== "string" || file === "") return null;
  let parsed;
  try {
    parsed = JSON.parse(readText(file));
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || parsed.length === 0) return null;
  if (!parsed.every((p) => typeof p === "string" && p !== "")) return null;
  return parsed;
}

/**
 * Compile one glob. Dialect: `**` matches any depth and a following "/" is
 * optional (so `**\/x.md` also matches a root `x.md`), `*` stays inside one
 * segment, `?` is one non-slash character, `{a,b}` is alternation (no
 * nesting). Anchored at both ends.
 *
 * @param {string} glob
 * @returns {RegExp}
 */
export function scopeGlobToRegExp(glob) {
  let out = "";
  for (let i = 0; i < glob.length; i += 1) {
    const ch = glob[i];
    if (ch === "*") {
      if (glob[i + 1] === "*") {
        out += ".*";
        i += 1;
        if (glob[i + 1] === "/") {
          out += "(?:/)?";
          i += 1;
        }
      } else {
        out += "[^/]*";
      }
    } else if (ch === "?") {
      out += "[^/]";
    } else if (ch === "{") {
      const end = glob.indexOf("}", i);
      if (end === -1) {
        out += "\\{";
        continue;
      }
      const alternatives = glob.slice(i + 1, end).split(",");
      out += `(?:${alternatives.map((a) => a.replace(/[.+^${}()|[\]\\*?]/g, "\\$&")).join("|")})`;
      i = end;
    } else {
      out += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${out}$`);
}

/**
 * True when `file` matches at least one glob.
 *
 * @param {string} file
 * @param {string[]} globs
 * @returns {boolean}
 */
export function matchesAnyGlob(file, globs) {
  return globs.some((g) => scopeGlobToRegExp(g).test(file));
}

/**
 * The full-run rule. A changed config, manifest, lockfile or shared setup file
 * is an input of every test, so the whole suite IS the scope. Test files never
 * count as triggers: a changed test file selects itself.
 *
 * @param {{ changedFiles: string[], fullTriggers: string[], testGlobs?: string[] }} input
 * @returns {string|null}  the first changed file that triggers a full run, or null
 */
export function fullRunTrigger({ changedFiles, fullTriggers, testGlobs = [] }) {
  for (const file of changedFiles) {
    if (matchesAnyGlob(file, testGlobs)) continue;
    if (matchesAnyGlob(file, fullTriggers)) return file;
  }
  return null;
}

const SPECIFIER_RES = [
  /\bimport\s+[^'"`;]*?\bfrom\s*(['"])([^'"]+)\1/g,
  /\bexport\s+[^'"`;]*?\bfrom\s*(['"])([^'"]+)\1/g,
  /\bimport\s*(['"])([^'"]+)\1/g,
  /\bimport\s*\(\s*(['"])([^'"]+)\1\s*\)/g,
];

/**
 * The relative specifiers a module imports statically (including dynamic
 * `import()` with a string literal). Bare specifiers (packages, `node:`) are
 * dropped: they are outside the repository.
 *
 * @param {string} source
 * @returns {string[]}
 */
function relativeSpecifiers(source) {
  const out = new Set();
  for (const re of SPECIFIER_RES) {
    for (const m of source.matchAll(re)) {
      if (m[2].startsWith("./") || m[2].startsWith("../")) out.add(m[2]);
    }
  }
  return [...out];
}

/**
 * The entrypoints (bins, scripts) whose static import closure contains a
 * changed file. A test that runs a bin through `execFileSync` never imports
 * the module it exercises, so a runner's own "related" mode misses it; the
 * caller selects every test that names one of these entrypoints instead.
 *
 * @param {{ entrypoints: string[], changedFiles: string[], readText: (path: string) => string }} input
 *   `readText` throws for a missing file, which is treated as a leaf
 * @returns {string[]}
 */
export function entrypointsReaching({ entrypoints, changedFiles, readText }) {
  const changed = new Set(changedFiles.map((f) => path.posix.normalize(f)));
  if (changed.size === 0) return [];
  /** @type {Map<string, string[]>} */
  const edges = new Map();
  const importsOf = (file) => {
    if (!edges.has(file)) {
      let source = "";
      try {
        source = readText(file);
      } catch {
        // Missing or unreadable: a leaf. A deleted module still counts as
        // reached through the importer that names it.
      }
      edges.set(
        file,
        relativeSpecifiers(source).map((s) => path.posix.normalize(path.posix.join(path.posix.dirname(file), s))),
      );
    }
    return edges.get(file);
  };
  return entrypoints.filter((entry) => {
    const seen = new Set();
    const queue = [path.posix.normalize(entry)];
    while (queue.length > 0) {
      const file = queue.shift();
      if (seen.has(file)) continue;
      seen.add(file);
      if (changed.has(file)) return true;
      queue.push(...importsOf(file));
    }
    return false;
  });
}

/**
 * True when `content` names `file` by its path or its basename.
 *
 * @param {string} content
 * @param {string} file
 * @returns {boolean}
 */
function mentions(content, file) {
  return content.includes(file) || content.includes(path.posix.basename(file));
}

/**
 * Runner-agnostic test selection for one pull request.
 *
 * - `full`: a full trigger changed (see {@link fullRunTrigger}).
 * - `sources`: existing changed files matching `sourceGlobs` that are not test
 *   files — hand them to the runner's own "related" mode.
 * - `tests`: existing changed test files, plus every test file whose content
 *   names a changed path (deleted and renamed-from paths included), its
 *   basename, or the path or basename of an entrypoint that reaches one.
 * - `skip`: nothing selected and no changed file matches `mustRun`.
 *
 * `mustRun` exists for a consumer that reuses this leg's output: when it will
 * measure a changed file anyway, the leg must run (possibly on an empty
 * selection) so the output exists, rather than skip.
 *
 * @param {{
 *   changedFiles: string[],
 *   exists: (path: string) => boolean,
 *   testFiles: TextFile[],
 *   testGlobs: string[],
 *   sourceGlobs: string[],
 *   fullTriggers: string[],
 *   mustRun?: string[],
 *   entrypoints?: string[],
 * }} input
 * @returns {TestSelection}
 */
export function selectTests({
  changedFiles,
  exists,
  testFiles,
  testGlobs,
  sourceGlobs,
  fullTriggers,
  mustRun = [],
  entrypoints = [],
}) {
  const trigger = fullRunTrigger({ changedFiles, fullTriggers, testGlobs });
  if (trigger !== null) {
    return { mode: "full", reason: `${trigger} changed, and it is an input of every test` };
  }
  const isTest = (f) => matchesAnyGlob(f, testGlobs);
  const sources = new Set();
  const tests = new Set();
  for (const file of changedFiles) {
    if (!exists(file)) continue;
    if (isTest(file)) tests.add(file);
    else if (matchesAnyGlob(file, sourceGlobs)) sources.add(file);
  }
  const needles = [...changedFiles, ...entrypoints];
  for (const t of testFiles) {
    if (tests.has(t.path)) continue;
    if (needles.some((n) => mentions(t.content, n))) tests.add(t.path);
  }
  const sorted = { sources: [...sources].sort(), tests: [...tests].sort() };
  if (sorted.sources.length === 0 && sorted.tests.length === 0) {
    const forced = changedFiles.find((f) => matchesAnyGlob(f, mustRun));
    if (forced === undefined) {
      return { mode: "skip", reason: "no test is in the scope of this pull request's changes" };
    }
    return { mode: "scoped", ...sorted, reason: `nothing selected, but ${forced} changed and its output is required` };
  }
  return {
    mode: "scoped",
    ...sorted,
    reason: `${sorted.sources.length} changed source file(s), ${sorted.tests.length} test file(s)`,
  };
}

/**
 * Vitest argv (after the `vitest` executable) for a scoped selection.
 *
 * `--coverage` keeps the lcov a later consumer reads for the changed lines.
 * The thresholds go to 0 because a repository's GLOBAL thresholds measure the
 * whole suite: a scoped run covers a fraction of the tree by design, and
 * failing it on the global number would fail every scoped run.
 *
 * `--passWithNoTests` means exit 0 does NOT prove a test ran. Pass
 * `jsonReport` and read the count back with {@link vitestTestCount}; a run
 * that reached zero tests must be recorded as a skip (or replaced by a full
 * run), never as a pass.
 *
 * @param {{ sources: string[], tests: string[], coverage?: boolean, jsonReport?: string }} input
 *   `jsonReport`: a path for vitest's json reporter, added beside the default reporter
 * @returns {string[]}
 */
export function vitestScopedArgs({ sources, tests, coverage = false, jsonReport }) {
  return [
    "related",
    "--run",
    "--passWithNoTests",
    ...(coverage
      ? [
          "--coverage",
          "--coverage.thresholds.lines=0",
          "--coverage.thresholds.functions=0",
          "--coverage.thresholds.branches=0",
          "--coverage.thresholds.statements=0",
        ]
      : []),
    ...(typeof jsonReport === "string" && jsonReport !== ""
      ? ["--reporter=default", "--reporter=json", `--outputFile.json=${jsonReport}`]
      : []),
    ...sources,
    ...tests,
  ];
}

/**
 * How many tests a vitest json report says ran (`numTotalTests`).
 *
 * @param {string} text  the json reporter's output file
 * @returns {number|null}  null when the text is not a report with a count — unknown, never zero
 */
export function vitestTestCount(text) {
  try {
    const n = JSON.parse(text)?.numTotalTests;
    return Number.isInteger(n) && n >= 0 ? n : null;
  } catch {
    return null;
  }
}
