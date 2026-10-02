/**
 * attest-scope-command — `dotbabel attest-scope --runner <r> -- <CI command>`.
 *
 * The scoped-leg wrapper `dotbabel local-attest --init` writes for a consumer
 * repository's test steps. It reads the pull request's changed files from the
 * runner (`DOTBABEL_ATTEST_CHANGED_FILES`), narrows the CI command to the tests
 * those files can reach, and either runs the narrowed command, writes a skip
 * reason (`DOTBABEL_ATTEST_SKIP_FILE`), or runs the CI command unchanged.
 *
 * Contract with the runner, shared with this repository's own wrapper
 * (`plugins/dotbabel/scripts/attest-scope.mjs`):
 *
 * - No changed-file list (a `--full` run, or a diff the runner could not
 *   read) → the CI command, byte for byte.
 * - A run that reaches zero tests is a skip, never a pass. Exit 0 proves
 *   nothing on its own, so each runner counts its tests: jest lists them
 *   first, vitest writes a json report, pytest exits 5, and go selects only
 *   packages that have test files.
 * - A failing run returns its own exit code and writes no skip.
 *
 * vitest selection is `attest-scope.mjs`; jest, go and pytest selection is
 * `attest-scope-runners.mjs`. This file is only the I/O around them.
 *
 * @typedef {object} CommandIo
 * @property {(args: string[]) => string} git  stdout of a git command run in the leg's directory; throws on failure
 * @property {(p: string) => string} readText  throws when unreadable
 * @property {(p: string) => boolean} exists
 * @property {(p: string, text: string) => void} writeText
 * @property {(cmd: string, args: string[]) => { status: number, stdout: string }} capture  stderr inherited
 * @property {(cmd: string, args: string[]) => number} run  exit status, output inherited
 * @property {() => string} tempDir
 * @property {(dir: string) => void} cleanup
 * @property {(msg: string) => void} log
 */

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  SKIP_FILE_ENV,
  fullRunTrigger,
  matchesAnyGlob,
  readChangedFiles,
  selectTests,
  vitestScopedArgs,
  vitestTestCount,
} from "./attest-scope.mjs";
import {
  RUNNERS,
  detectRunner,
  goScopedArgv,
  jestScopedArgv,
  parseGoList,
  parseGoTestArgs,
  parseJestArgs,
  parsePytestArgs,
  pytestScopedArgv,
  selectGoPackages,
  selectPytestTests,
  snapshotOwners,
  unclassifiedJsInputs,
} from "./attest-scope-runners.mjs";
import { GIT_MAX_BUFFER } from "./lib/limits.mjs";

const JS_EXT = "js,jsx,ts,tsx,mjs,cjs,mts,cts";
const JS_TEST_GLOBS = [`**/*.{test,spec}.{${JS_EXT}}`, `**/__tests__/**/*.{${JS_EXT}}`];
/** Files a JS runner's own import graph can relate to tests. */
const JS_SOURCE_GLOBS = [`**/*.{${JS_EXT},json,css,scss,sass,less,vue,svelte,graphql,gql,html}`];
const JS_FULL_TRIGGERS = [
  "**/package.json",
  "**/package-lock.json",
  "**/npm-shrinkwrap.json",
  "**/yarn.lock",
  "**/pnpm-lock.yaml",
  "**/pnpm-workspace.yaml",
  "**/bun.lockb",
  "**/tsconfig*.json",
  "**/babel.config.*",
  "**/.babelrc*",
  "**/.nvmrc",
  "**/.node-version",
  "**/.env.test*",
  "**/__mocks__/**",
];

/**
 * Changed files that are an input of every test the runner runs: its config,
 * the dependency manifests and lockfiles, and shared setup. Any of them
 * changing makes the whole suite the scope.
 */
export const FULL_TRIGGERS = Object.freeze({
  jest: [...JS_FULL_TRIGGERS, "**/jest.config.*", "**/jest.setup.*", "**/jest-preset.*", "**/setupTests.*"],
  vitest: [...JS_FULL_TRIGGERS, "**/vitest.config.*", "**/vitest.workspace.*", "**/vitest.setup.*", "**/vite.config.*"],
  go: ["**/go.mod", "**/go.sum", "**/go.work", "**/go.work.sum"],
  pytest: [
    "**/pyproject.toml",
    "**/setup.cfg",
    "**/setup.py",
    "**/pytest.ini",
    "**/tox.ini",
    "**/conftest.py",
    "**/requirements*.txt",
    "**/poetry.lock",
    "**/uv.lock",
    "**/Pipfile",
    "**/Pipfile.lock",
    "**/.python-version",
  ],
});

/** Test files never trigger a full run: a changed test selects itself. */
const TEST_GLOBS = Object.freeze({
  jest: JS_TEST_GLOBS,
  vitest: JS_TEST_GLOBS,
  go: ["**/*_test.go"],
  pytest: ["**/test_*.py", "**/*_test.py"],
});

const USAGE = "usage: dotbabel attest-scope --runner <vitest|jest|go|pytest> -- <CI command...>";

/**
 * Parse `--runner <r> -- <command...>` (or `--runner=<r>`).
 *
 * @param {string[]} argv
 * @returns {{ runner: string, command: string[] }|null}
 */
function parseArgv(argv) {
  const sep = argv.indexOf("--");
  if (sep === -1) return null;
  const head = argv.slice(0, sep);
  const command = argv.slice(sep + 1);
  let runner;
  for (let i = 0; i < head.length; i++) {
    if (head[i] === "--runner") runner = head[++i];
    else if (head[i].startsWith("--runner=")) runner = head[i].slice("--runner=".length);
    else return null;
  }
  if (!runner || !RUNNERS.includes(runner) || command.length === 0) return null;
  return { runner, command };
}

/**
 * Everything one invocation needs, resolved once.
 *
 * @typedef {object} Ctx
 * @property {CommandIo} io
 * @property {string} root    absolute repository root
 * @property {string} prefix   the leg's directory, repo-relative with a trailing slash ("" at the root)
 * @property {string[]} changed
 * @property {(f: string) => boolean} exists  for a repo-relative path
 * @property {(why: string) => number} full
 * @property {(why: string) => number} skip
 */

/**
 * Files git tracks under the leg's directory, repo-relative.
 *
 * @param {Ctx} ctx
 * @returns {string[]}
 */
function trackedFiles(ctx) {
  return ctx.io.git(["ls-files", "-z", "--full-name"]).split("\0").filter(Boolean);
}

/**
 * @param {Ctx} ctx
 * @param {{ exec: string[], args: string[] }} cmd
 * @returns {number}
 */
function goLeg(ctx, { args }) {
  const parsed = parseGoTestArgs(args);
  if (!parsed) return ctx.full("the go test arguments have a shape the scoper does not narrow");
  const list = (extra, template) => ctx.io.capture("go", ["list", ...extra, "-f", template, ...parsed.patterns]);
  const roots = list([], "{{.ImportPath}}\t{{.Dir}}\t{{len .TestGoFiles}}\t{{len .XTestGoFiles}}");
  const graph = list(["-test", "-deps"], '{{.ImportPath}}\t{{.Dir}}\t{{join .Deps " "}}');
  if (roots.status !== 0 || graph.status !== 0) return ctx.full("go list failed, so the package graph is unknown");
  const rel = (dir) => {
    const r = path.relative(ctx.root, dir).split(path.sep).join("/");
    return r.startsWith("..") || path.isAbsolute(r) ? null : r;
  };
  const decision = selectGoPackages({
    changedFiles: ctx.changed,
    prefix: ctx.prefix,
    roots: roots.stdout
      .split("\n")
      .filter(Boolean)
      .flatMap((line) => {
        const [importPath, dir, tests = "0", xtests = "0"] = line.split("\t");
        const repoDir = rel(dir);
        return repoDir === null ? [] : [{ importPath, dir: repoDir, hasTests: Number(tests) + Number(xtests) > 0 }];
      }),
    graph: parseGoList(graph.stdout).flatMap((g) => {
      const dir = rel(g.dir);
      return dir === null ? [] : [{ ...g, dir }];
    }),
  });
  if (decision.mode === "full") return ctx.full(decision.reason);
  if (decision.mode === "skip") return ctx.skip(decision.reason);
  const argv = goScopedArgv({ flags: parsed.flags, packages: decision.packages });
  ctx.io.log(`attest-scope: ${decision.reason}: ${argv.join(" ")}`);
  return ctx.io.run(argv[0], argv.slice(1));
}

/**
 * @param {Ctx} ctx
 * @param {{ exec: string[], args: string[] }} cmd
 * @returns {number}
 */
function pytestLeg(ctx, { exec, args }) {
  const parsed = parsePytestArgs(args);
  if (!parsed) return ctx.full("the pytest arguments have a shape the scoper does not narrow");
  const decision = selectPytestTests({
    changedFiles: ctx.changed,
    prefix: ctx.prefix,
    testFiles: trackedFiles(ctx).filter((f) => matchesAnyGlob(f, TEST_GLOBS.pytest)),
    exists: ctx.exists,
  });
  if (decision.mode === "full") return ctx.full(decision.reason);
  if (decision.mode === "skip") return ctx.skip(decision.reason);
  const argv = pytestScopedArgv({ exec, options: parsed.options, paths: parsed.paths, tests: decision.tests });
  if (!argv) return ctx.skip("every selected test is outside the paths the CI command runs");
  ctx.io.log(`attest-scope: ${decision.reason}: ${argv.join(" ")}`);
  const code = ctx.io.run(argv[0], argv.slice(1));
  // pytest's "no tests collected": the selection ran nothing, so nothing passed.
  return code === 5 ? ctx.skip("the selected test files collected no tests") : code;
}

/**
 * The JS selection shared by jest and vitest: the files to hand to the
 * runner's "related" mode, or a full/skip decision.
 *
 * @param {Ctx} ctx
 * @returns {{ mode: "full"|"skip", reason: string } | { mode: "scoped", sources: string[], tests: string[] }}
 */
function jsSelection(ctx) {
  const isTest = (f) => matchesAnyGlob(f, JS_TEST_GLOBS);
  const isSource = (f) => !isTest(f) && matchesAnyGlob(f, JS_SOURCE_GLOBS);
  const inLeg = ctx.changed.filter((f) => f.startsWith(ctx.prefix));
  const deleted = inLeg.find((f) => isSource(f) && !ctx.exists(f));
  if (deleted) return { mode: "full", reason: `${deleted} was deleted, and the tests that imported it cannot be traced` };
  const testFiles = trackedFiles(ctx)
    .filter(isTest)
    .map((f) => {
      let content = "";
      try {
        content = ctx.io.readText(path.join(ctx.root, f));
      } catch {
        // Unreadable: it can still be selected by name, just not by content.
      }
      return { path: f, content };
    });
  const unclassified = unclassifiedJsInputs({
    changedFiles: ctx.changed,
    prefix: ctx.prefix,
    isSource,
    isTest,
    testContents: testFiles.map((t) => t.content),
  });
  if (unclassified.length > 0) {
    return { mode: "full", reason: `no rule relates ${unclassified[0]} to a test` };
  }
  // The runner-level full triggers were checked in `main`, so this is only
  // ever "scoped" or "skip".
  const selection = selectTests({
    changedFiles: inLeg,
    exists: ctx.exists,
    testFiles,
    testGlobs: JS_TEST_GLOBS,
    sourceGlobs: JS_SOURCE_GLOBS,
    fullTriggers: [],
  });
  const owners = snapshotOwners(inLeg, testFiles.map((t) => t.path));
  const tests = [...new Set([...(selection.mode === "scoped" ? selection.tests : []), ...owners])].sort();
  const sources = selection.mode === "scoped" ? selection.sources : [];
  if (sources.length === 0 && tests.length === 0) {
    return { mode: "skip", reason: "no test is in the scope of this pull request's changes" };
  }
  const local = (f) => f.slice(ctx.prefix.length);
  return { mode: "scoped", sources: sources.map(local), tests: tests.map(local) };
}

/**
 * @param {Ctx} ctx
 * @param {{ exec: string[], args: string[] }} cmd
 * @returns {number}
 */
function jestLeg(ctx, { exec, args }) {
  const parsed = parseJestArgs(args);
  if (!parsed) return ctx.full("the jest arguments have a shape the scoper does not narrow");
  const selection = jsSelection(ctx);
  if (selection.mode !== "scoped") return selection.mode === "full" ? ctx.full(selection.reason) : ctx.skip(selection.reason);
  const files = [...selection.sources, ...selection.tests];
  const probe = jestScopedArgv({ exec, options: parsed.options, files, list: true });
  const listed = ctx.io.capture(probe[0], probe.slice(1));
  if (listed.status !== 0) return ctx.full("jest could not list the related tests");
  const count = listed.stdout.split("\n").filter((l) => l.trim() !== "").length;
  if (count === 0) return ctx.skip("the changed files reach no test");
  const argv = jestScopedArgv({ exec, options: parsed.options, files });
  ctx.io.log(`attest-scope: ${count} related test file(s): ${argv.join(" ")}`);
  return ctx.io.run(argv[0], argv.slice(1));
}

/** vitest flags that already choose tests by their own rule. */
const VITEST_SELECTING = /^--?(changed|related|shard|watch|w|project|dir|root|r)(=|$)|^--coverage\.thresholds/;

/**
 * @param {Ctx} ctx
 * @param {{ exec: string[], args: string[] }} cmd
 * @returns {number}
 */
function vitestLeg(ctx, { exec, args }) {
  const rest = args[0] === "run" ? args.slice(1) : args;
  if (rest.some((a) => !a.startsWith("-") || VITEST_SELECTING.test(a))) {
    return ctx.full("the vitest arguments have a shape the scoper does not narrow");
  }
  const coverage = rest.some((a) => a === "--coverage" || a === "--coverage.enabled" || a === "--coverage.enabled=true");
  const extra = rest.filter((a) => !a.startsWith("--coverage"));
  const selection = jsSelection(ctx);
  if (selection.mode !== "scoped") return selection.mode === "full" ? ctx.full(selection.reason) : ctx.skip(selection.reason);
  const dir = ctx.io.tempDir();
  try {
    const report = path.join(dir, "vitest.json");
    const [related, ...scoped] = vitestScopedArgs({ ...selection, coverage, jsonReport: report });
    const argv = [...exec, related, ...extra, ...scoped];
    ctx.io.log(`attest-scope: ${argv.join(" ")}`);
    const code = ctx.io.run(argv[0], argv.slice(1));
    if (code !== 0) return code;
    let count = null;
    try {
      count = vitestTestCount(ctx.io.readText(report));
    } catch {
      // No report: the count is unknown, handled below.
    }
    if (count === null) return ctx.full("the scoped run's test count is unknown");
    return count > 0 ? 0 : ctx.skip("the changed files reach no test");
  } finally {
    ctx.io.cleanup(dir);
  }
}

const LEGS = { go: goLeg, pytest: pytestLeg, jest: jestLeg, vitest: vitestLeg };

/**
 * Run one scoped leg. Returns the exit code.
 *
 * @param {{ argv: string[], env: Record<string, string|undefined>, io: CommandIo }} input
 * @returns {number}
 */
export function main({ argv, env, io }) {
  const parsed = parseArgv(argv);
  if (!parsed) {
    io.log(USAGE);
    return 64;
  }
  const { runner, command } = parsed;
  const full = (why) => {
    io.log(`attest-scope: ${runner} runs the CI command in full — ${why}`);
    return io.run(command[0], command.slice(1));
  };

  const changed = readChangedFiles(env, io.readText);
  if (changed === null) return full("the changed-file list is unavailable");
  const skipFile = env[SKIP_FILE_ENV];
  if (typeof skipFile !== "string" || skipFile === "") {
    return full(`${SKIP_FILE_ENV} is unset, so a skip could not be recorded`);
  }

  let root;
  let prefix;
  try {
    root = io.git(["rev-parse", "--show-toplevel"]).trim();
    prefix = io.git(["rev-parse", "--show-prefix"]).trim();
  } catch {
    return full("this directory is not inside a git work tree");
  }

  let scripts = null;
  try {
    scripts = JSON.parse(io.readText(path.join(root, prefix, "package.json"))).scripts ?? null;
  } catch {
    // No package.json, or an unreadable one: only direct runner commands are recognised.
  }
  const resolved = detectRunner(command, scripts);
  if (!resolved || resolved.runner !== runner) {
    return full(`the command does not invoke ${runner} in a form the scoper can narrow`);
  }

  const trigger = fullRunTrigger({ changedFiles: changed, fullTriggers: FULL_TRIGGERS[runner], testGlobs: TEST_GLOBS[runner] });
  if (trigger !== null) return full(`${trigger} changed, and it is an input of every test`);

  /** @type {Ctx} */
  const ctx = {
    io,
    root,
    prefix,
    changed,
    exists: (f) => io.exists(path.join(root, f)),
    full,
    skip: (reason) => {
      io.writeText(skipFile, `${reason}\n`);
      io.log(`attest-scope: skipped — ${reason}`);
      return 0;
    },
  };
  return LEGS[runner](ctx, resolved);
}

/**
 * The real process, rooted at the current directory (the leg's `cwd`).
 *
 * @returns {CommandIo}
 */
export function realIo() {
  return {
    git: (args) =>
      execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: GIT_MAX_BUFFER }),
    readText: (p) => readFileSync(p, "utf8"),
    exists: (p) => existsSync(p),
    writeText: (p, text) => writeFileSync(p, text),
    capture: (cmd, args) => {
      const r = spawnSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"], maxBuffer: GIT_MAX_BUFFER });
      return { status: r.status ?? 1, stdout: r.stdout ?? "" };
    },
    run: (cmd, args) => {
      const r = spawnSync(cmd, args, { stdio: "inherit" });
      if (r.error) process.stderr.write(`attest-scope: could not start ${cmd}: ${r.error.message}\n`);
      return r.status ?? 1;
    },
    tempDir: () => mkdtempSync(path.join(os.tmpdir(), "attest-scope-")),
    cleanup: (dir) => rmSync(dir, { recursive: true, force: true }),
    log: (msg) => process.stderr.write(`${msg}\n`),
  };
}
