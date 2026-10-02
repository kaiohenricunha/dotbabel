/**
 * attest-scope-runners — per-runner test selection for a scoped local-attest leg.
 *
 * A scoped leg runs only the tests that a pull request's changed files can
 * reach. This module decides, for jest, go test, and pytest, which tests those
 * are and how to rewrite the CI command so that it runs only them. vitest
 * selection lives in `attest-scope.mjs`, which this repository's own attest
 * also uses, so there is exactly one vitest selector.
 *
 * SAFETY: every function here is biased toward running MORE. A scoped run that
 * is wrong in the other direction certifies tests that never ran, and an
 * attestation switches remote CI off. So each selector returns one of three
 * decisions, and the doubtful cases all land on "full":
 *
 * - `full`: run the CI command unchanged. Any input the selector cannot
 *   classify, any command it cannot parse, any file it cannot map.
 * - `skip`: nothing the command tests can be affected. Never returned when
 *   the command would run zero tests and exit 0 — that is recorded as a skip
 *   by the caller, not as a pass.
 * - `scoped`: run the narrowed command.
 *
 * Pure functions only. Reading the changed-file list, listing files, and
 * running `go list` belong to `attest-scope-command.mjs`.
 *
 * @typedef {{ mode: "full", reason: string }
 *         | { mode: "skip", reason: string }
 *         | { mode: "scoped", packages: string[], reason: string }} GoDecision
 * @typedef {{ mode: "full", reason: string }
 *         | { mode: "skip", reason: string }
 *         | { mode: "scoped", tests: string[], reason: string }} PytestDecision
 * @typedef {{ runner: "jest"|"vitest"|"go"|"pytest", exec: string[], args: string[] }} RunnerCommand
 * @typedef {{ importPath: string, dir: string, deps: string[] }} GoListEntry
 * @typedef {{ importPath: string, dir: string, hasTests: boolean }} GoRoot
 */

import path from "node:path";

/** The runners `dotbabel attest-scope --runner` accepts. */
export const RUNNERS = Object.freeze(["vitest", "jest", "go", "pytest"]);

/**
 * One token of a plain command: no quoting, expansion, globbing, chaining or
 * redirection, so splitting on spaces yields exactly the argv a shell would.
 */
const PLAIN_TOKEN = /^[A-Za-z0-9_./:=@+,%-]+$/;

/**
 * Split a command into argv when it is one plain command, else null.
 *
 * Anything a shell would interpret (`&&`, `|`, `$`, quotes, globs, newlines)
 * returns null: the scoper rewrites argv, and a rewrite of a command it only
 * half understands would run something CI never ran.
 *
 * @param {string} command
 * @returns {string[]|null}
 */
export function simpleArgv(command) {
  const trimmed = String(command ?? "").trim();
  if (trimmed === "") return null;
  const argv = trimmed.split(/ +/);
  return argv.every((t) => PLAIN_TOKEN.test(t)) ? argv : null;
}

/** pytest launchers, longest first so `python -m pytest` wins over a bare match. */
const PYTEST_LAUNCHERS = [
  ["python", "-m", "pytest"],
  ["python3", "-m", "pytest"],
  ["uv", "run", "pytest"],
  ["poetry", "run", "pytest"],
  ["pytest"],
];

/** JS runner launchers; `X` stands for `jest` or `vitest`. */
const JS_LAUNCHERS = [
  ["npx", "--no-install", "X"],
  ["npx", "--no", "X"],
  ["npx", "X"],
  ["pnpm", "exec", "X"],
  ["yarn", "X"],
  ["pnpm", "X"],
  ["node_modules/.bin/X"],
  ["./node_modules/.bin/X"],
  ["X"],
];

/** How a package manager launches a binary that a script names bare. */
const BIN_LAUNCHER = {
  npm: ["npx", "--no-install"],
  yarn: ["yarn"],
  pnpm: ["pnpm", "exec"],
};

/**
 * @param {string[]} argv
 * @param {string[]} prefix
 * @returns {boolean}
 */
function startsWith(argv, prefix) {
  return prefix.length <= argv.length && prefix.every((t, i) => argv[i] === t);
}

/**
 * Recognise a direct runner invocation (no package script).
 *
 * @param {string[]} argv
 * @returns {RunnerCommand|null}
 */
function directRunner(argv) {
  if (argv[0] === "go") {
    return argv[1] === "test" ? { runner: "go", exec: ["go", "test"], args: argv.slice(2) } : null;
  }
  for (const launcher of PYTEST_LAUNCHERS) {
    if (startsWith(argv, launcher)) return { runner: "pytest", exec: launcher, args: argv.slice(launcher.length) };
  }
  for (const runner of /** @type {const} */ (["jest", "vitest"])) {
    for (const shape of JS_LAUNCHERS) {
      const launcher = shape.map((t) => t.replace(/X$/, runner).replace(/^X$/, runner));
      if (startsWith(argv, launcher)) return { runner, exec: launcher, args: argv.slice(launcher.length) };
    }
  }
  return null;
}

/**
 * Split a package-manager invocation into the script name and its extra args.
 *
 * npm only forwards args that follow `--`; anything before it is npm's own
 * configuration, so it returns null rather than guessing what npm would do.
 *
 * @param {string[]} argv
 * @returns {{ pm: "npm"|"yarn"|"pnpm", script: string, extra: string[] }|null}
 */
function scriptInvocation(argv) {
  const [pm, ...rest] = argv;
  if (pm === "npm") {
    let script;
    let tail;
    if (rest[0] === "test" || rest[0] === "t") [script, tail] = ["test", rest.slice(1)];
    else if ((rest[0] === "run" || rest[0] === "run-script") && rest[1]) [script, tail] = [rest[1], rest.slice(2)];
    else return null;
    if (tail.length === 0) return { pm, script, extra: [] };
    return tail[0] === "--" ? { pm, script, extra: tail.slice(1) } : null;
  }
  if (pm === "yarn" || pm === "pnpm") {
    const named = rest[0] === "run" ? rest.slice(1) : rest;
    if (!named[0]) return null;
    return { pm, script: named[0], extra: named.slice(1) };
  }
  return null;
}

/**
 * Which test runner a command invokes, following at most one package-script
 * hop (`npm test` → `"test": "jest --ci"`).
 *
 * A script's bare `jest` resolves through node_modules/.bin only inside the
 * package manager, so the returned launcher goes back through the same
 * manager (`npx --no-install jest`, `yarn jest`, `pnpm exec jest`).
 *
 * @param {string[]} argv
 * @param {Record<string, string>|null|undefined} scripts  `package.json#scripts` of the leg's directory
 * @returns {RunnerCommand|null}
 */
export function detectRunner(argv, scripts) {
  const direct = directRunner(argv);
  // `yarn jest` is a direct launch only when no script shadows the name.
  if (direct && argv[0] !== "yarn" && argv[0] !== "pnpm") return direct;
  const call = scriptInvocation(argv);
  if (call && scripts && typeof scripts[call.script] === "string") {
    const scriptArgv = simpleArgv(scripts[call.script]);
    if (!scriptArgv) return null;
    const inner = directRunner(scriptArgv);
    if (!inner) return null;
    const bare = inner.exec.length === 1 && (inner.runner === "jest" || inner.runner === "vitest");
    return {
      runner: inner.runner,
      exec: bare ? [...BIN_LAUNCHER[call.pm], inner.exec[0]] : inner.exec,
      args: [...inner.args, ...call.extra],
    };
  }
  return direct;
}

/**
 * The leg command `--init` writes for a scoped leg. The CI command follows
 * the separator byte for byte, so a full run executes exactly what CI runs.
 *
 * @param {string} runner
 * @param {string} command
 * @returns {string}
 */
export function wrapCommand(runner, command) {
  return `dotbabel attest-scope --runner ${runner} -- ${command}`;
}

/** `go test` and build flags that take their value as the next token. */
const GO_VALUE_FLAGS = new Set([
  "-run", "-skip", "-bench", "-benchtime", "-count", "-covermode", "-coverpkg", "-coverprofile",
  "-cpu", "-cpuprofile", "-memprofile", "-memprofilerate", "-blockprofile", "-blockprofilerate",
  "-mutexprofile", "-mutexprofilefraction", "-outputdir", "-parallel", "-timeout", "-trace", "-tags",
  "-p", "-o", "-exec", "-fuzz", "-fuzztime", "-fuzzminimizetime", "-list", "-shuffle", "-vet",
  "-ldflags", "-gcflags", "-asmflags", "-mod", "-modfile", "-pkgdir", "-toolexec", "-overlay", "-pgo",
]);

/**
 * Split `go test` args into flags and package patterns.
 *
 * Only directory patterns (`.`, `./x`, `./x/...`) are accepted, because
 * selection works on directories. `-args` and `-C` change what the patterns
 * mean, so they return null.
 *
 * @param {string[]} args  the args after `go test`
 * @returns {{ flags: string[], patterns: string[] }|null}
 */
export function parseGoTestArgs(args) {
  const flags = [];
  const patterns = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "-args" || a === "--args" || a === "-C" || a.startsWith("-C=")) return null;
    if (a.startsWith("-")) {
      flags.push(a);
      const name = a.replace(/^--?/, "-");
      if (!a.includes("=") && GO_VALUE_FLAGS.has(name)) {
        if (i + 1 >= args.length) return null;
        flags.push(args[++i]);
      }
      continue;
    }
    if (a !== "." && !a.startsWith("./")) return null;
    patterns.push(a);
  }
  return patterns.length > 0 ? { flags, patterns } : null;
}

/**
 * Parse `go list -f '{{.ImportPath}}\t{{.Dir}}\t{{join .Deps " "}}'` output.
 *
 * @param {string} text
 * @returns {GoListEntry[]}
 */
export function parseGoList(text) {
  return String(text ?? "")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => {
      const [importPath = "", dir = "", deps = ""] = line.split("\t");
      return { importPath, dir, deps: deps.split(" ").filter(Boolean) };
    });
}

/** Files that no test reads: prose, images, editor and CI config. */
const INERT = [
  /\.(md|mdx|rst|adoc)$/i,
  /\.(png|jpe?g|gif|svg|ico|webp)$/i,
  /(^|\/)(LICENSE|LICENCE|CHANGELOG|AUTHORS|CODEOWNERS)[^/]*$/,
  /(^|\/)\.(gitignore|gitattributes|editorconfig|dockerignore)$/,
  /(^|\/)\.(prettierrc|eslintrc|markdownlint)[^/]*$/,
  /(^|\/)Dockerfile[^/]*$/,
  /^\.github\//,
  /^\.vscode\//,
];

/**
 * True for a file no test can read: documentation, images, editor and CI
 * configuration.
 *
 * @param {string} file
 * @returns {boolean}
 */
export function isInert(file) {
  return INERT.some((re) => re.test(file));
}

/**
 * The directory a file lives in, in the repo-relative form `go list` dirs use
 * here ("" for the repository root).
 *
 * @param {string} file
 * @returns {string}
 */
function dirOf(file) {
  const d = path.posix.dirname(file);
  return d === "." ? "" : d;
}

/**
 * True when `file` sits in `dir` or below it.
 *
 * @param {string} file
 * @param {string} dir
 * @returns {boolean}
 */
function isUnder(file, dir) {
  return dir === "" || file === dir || file.startsWith(`${dir}/`);
}

/**
 * The base import path of a `go list -test` entry: `a [a.test]` → `a`,
 * `a_test [a.test]` → `a_test`, the generated `a.test` main → null.
 *
 * @param {string} importPath
 * @returns {string|null}
 */
function baseImportPath(importPath) {
  const base = importPath.split(" ")[0];
  return base.endsWith(".test") ? null : base;
}

/**
 * Select the Go packages a change can affect: every package with tests whose
 * own directory changed or whose test build depends on a changed package.
 *
 * `go test` on a package without test files exits 0 having run nothing, so a
 * package is selected only when it has tests, and an empty selection is a
 * skip, never a run.
 *
 * All paths are repo-relative; `prefix` is the leg's directory with a
 * trailing slash ("" at the root). Packages come back relative to it.
 *
 * @param {{ changedFiles: string[], prefix: string, roots: GoRoot[], graph: GoListEntry[] }} input
 *   roots: the packages the command's patterns name. graph: `go list -test -deps` over the same patterns.
 * @returns {GoDecision}
 */
export function selectGoPackages({ changedFiles, prefix, roots, graph }) {
  const dirs = [...new Set(graph.map((g) => g.dir))].sort((a, b) => b.length - a.length);
  const owner = new Map();
  for (const g of graph) {
    const base = baseImportPath(g.importPath);
    if (base && !base.endsWith("_test") && !owner.has(g.dir)) owner.set(g.dir, base);
  }

  const changedPkgs = new Set();
  for (const file of changedFiles) {
    if (isInert(file)) continue;
    const dir = dirs.find((d) => isUnder(file, d));
    if (dir !== undefined && owner.has(dir)) {
      changedPkgs.add(owner.get(dir));
    } else if (file.endsWith(".go") && isUnder(file, prefix.replace(/\/$/, ""))) {
      return { mode: "full", reason: `${file} is in no package this command builds` };
    }
  }

  const selected = roots.filter(
    (r) =>
      r.hasTests &&
      (changedPkgs.has(r.importPath) || graph.some((g) => g.dir === r.dir && g.deps.some((d) => changedPkgs.has(d)))),
  );
  if (selected.length === 0) {
    return { mode: "skip", reason: "no package with tests depends on a changed file" };
  }
  const base = prefix.replace(/\/$/, "");
  const packages = selected
    .map((r) => {
      const rel = path.posix.relative(base, r.dir);
      return rel === "" ? "." : `./${rel}`;
    })
    .sort();
  return { mode: "scoped", packages, reason: `${packages.length} package(s) depend on the changed files` };
}

/**
 * The narrowed `go test` argv: every original flag, the selected packages.
 *
 * @param {{ flags: string[], packages: string[] }} input
 * @returns {string[]}
 */
export function goScopedArgv({ flags, packages }) {
  return ["go", "test", ...flags, ...packages];
}

/** pytest short options whose value is the next token. */
const PYTEST_SHORT_VALUE = new Set(["-k", "-m", "-p", "-c", "-o", "-W", "-r", "-n"]);
/** pytest long options that take no value. */
const PYTEST_LONG_FLAG = new Set([
  "--verbose", "--quiet", "--exitfirst", "--lf", "--last-failed", "--ff", "--failed-first", "--nf",
  "--new-first", "--sw", "--stepwise", "--showlocals", "--strict-markers", "--strict-config",
  "--disable-warnings", "--disable-pytest-warnings", "--no-header", "--no-summary", "--cache-clear",
  "--doctest-modules", "--runxfail", "--color", "--code-highlight", "--import-mode",
]);
/** pytest long options whose value is the next token. `--cov`'s value is optional, as pytest-cov parses it. */
const PYTEST_LONG_VALUE = new Set([
  "--maxfail", "--rootdir", "--tb", "--cov", "--cov-report", "--cov-config", "--cov-fail-under",
  "--junitxml", "--junit-xml", "--durations", "--basetemp", "--deselect", "--ignore", "--ignore-glob",
  "--log-level", "--confcutdir", "--override-ini", "--dist", "--numprocesses", "--timeout",
]);

/**
 * Split pytest args into options (with their values) and positional paths.
 *
 * An unknown long option without `=` returns null: its next token could be
 * its value or a path, and guessing wrong either drops a filter or turns a
 * value into a test path.
 *
 * @param {string[]} args
 * @returns {{ options: string[], paths: string[] }|null}
 */
export function parsePytestArgs(args) {
  const options = [];
  const paths = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith("-")) {
      paths.push(a);
      continue;
    }
    options.push(a);
    if (a.startsWith("--")) {
      if (a.includes("=") || PYTEST_LONG_FLAG.has(a)) continue;
      if (!PYTEST_LONG_VALUE.has(a)) return null;
      const optional = a === "--cov";
      if (i + 1 < args.length && !(optional && args[i + 1].startsWith("-"))) options.push(args[++i]);
      else if (!optional) return null;
      continue;
    }
    if (PYTEST_SHORT_VALUE.has(a)) {
      if (i + 1 >= args.length) return null;
      options.push(args[++i]);
    }
  }
  return { options, paths };
}

/** A pytest test module by pytest's default naming rule. */
const PYTEST_TEST_FILE = /(^|\/)(test_[^/]*|[^/]*_test)\.py$/;

/** Source extensions of other languages: never an input of a Python or JS test. */
const OTHER_LANG = {
  pytest: /\.(go|js|jsx|ts|tsx|mjs|cjs|mts|cts|rb|java|kt|rs|cs|php|swift|c|h|cc|cpp|hpp|scala|vue|svelte)$/i,
  js: /\.(go|py|pyi|rb|java|kt|rs|cs|php|swift|c|h|cc|cpp|hpp|scala)$/i,
};

/**
 * Select the pytest files a change can affect, by pytest's naming rule:
 * a changed `pkg/views.py` selects `test_views.py` and `views_test.py`.
 *
 * Python imports never name the file (`from pkg import views`), so there is
 * no import graph to read here. Whenever the naming rule cannot account for
 * a changed file, the whole suite runs.
 *
 * @param {{ changedFiles: string[], prefix: string, testFiles: string[], exists: (file: string) => boolean }} input
 *   testFiles: every pytest module under the leg, repo-relative.
 * @returns {PytestDecision}
 */
export function selectPytestTests({ changedFiles, prefix, testFiles, exists }) {
  const selected = new Set();
  for (const file of changedFiles) {
    if (isInert(file) || OTHER_LANG.pytest.test(file)) continue;
    if (!file.startsWith(prefix)) {
      if (prefix !== "" && /\.pyi?$/.test(file)) {
        return { mode: "full", reason: `${file} is outside this leg, and an installed package may link it` };
      }
      continue;
    }
    const base = path.posix.basename(file);
    if (base === "conftest.py" || base === "__init__.py") {
      return { mode: "full", reason: `${file} reaches every test below its directory` };
    }
    if (PYTEST_TEST_FILE.test(file)) {
      if (exists(file)) selected.add(file);
      continue;
    }
    if (!/\.pyi?$/.test(file)) {
      return { mode: "full", reason: `${file} is not Python, and a test may read it` };
    }
    const stem = base.replace(/\.pyi?$/, "");
    const named = testFiles.filter((t) => {
      const b = path.posix.basename(t);
      return b === `test_${stem}.py` || b === `${stem}_test.py`;
    });
    if (named.length === 0) return { mode: "full", reason: `no test file is named after ${file}` };
    for (const t of named) selected.add(t);
  }
  if (selected.size === 0) return { mode: "skip", reason: "no changed file is an input of a Python test" };
  const tests = [...selected].map((t) => t.slice(prefix.length)).sort();
  return { mode: "scoped", tests, reason: `${tests.length} test file(s) cover the changed files` };
}

/**
 * The narrowed pytest argv. The original positional paths bound what CI
 * runs, so a selected test outside all of them is dropped rather than added.
 * When the command measures coverage, the floor is turned off: a subset of
 * the suite cannot meet a floor set for the whole suite.
 *
 * @param {{ exec: string[], options: string[], paths: string[], tests: string[] }} input
 * @returns {string[]|null}  null when no selected test is inside the original paths
 */
export function pytestScopedArgv({ exec, options, paths, tests }) {
  const within = (t) => paths.length === 0 || paths.some((p) => p === "." || isUnder(t, p.replace(/\/$/, "")));
  const kept = tests.filter(within);
  if (kept.length === 0) return null;
  const coverage = options.some((o) => o === "--cov" || o.startsWith("--cov="));
  return [...exec, ...options, ...(coverage ? ["--cov-fail-under=0"] : []), ...kept];
}

/** jest options that already choose tests by their own rule. */
const JEST_SELECTING = /^--?(onlyChanged|o|changedSince|lastCommit|shard|listTests|findRelatedTests|watch|watchAll|selectProjects|runTestsByPath|testPathPatterns?)(=|$)/;

/**
 * Accept jest args only when every token is a flag or `--flag=value`.
 *
 * Under `--findRelatedTests` every positional token is read as a file, so a
 * bare value (`--maxWorkers 2`) or a path pattern would change what runs.
 *
 * @param {string[]} args
 * @returns {{ options: string[] }|null}
 */
export function parseJestArgs(args) {
  for (const a of args) {
    if (!a.startsWith("-") || JEST_SELECTING.test(a)) return null;
  }
  return { options: [...args] };
}

/**
 * The narrowed jest argv, or with `list` the probe that counts the tests it
 * would run. The coverage floor is off for the same reason as pytest's.
 *
 * @param {{ exec: string[], options: string[], files: string[], list?: boolean }} input
 * @returns {string[]}
 */
export function jestScopedArgv({ exec, options, files, list = false }) {
  return [
    ...exec,
    ...options,
    "--coverageThreshold={}",
    ...(list ? ["--listTests"] : []),
    "--findRelatedTests",
    ...files,
  ];
}

/**
 * The test files that own changed snapshots: `dir/__snapshots__/x.test.ts.snap`
 * belongs to `dir/x.test.ts`. A runner's import graph never reaches a
 * snapshot, so without this a snapshot-only change would skip.
 *
 * @param {string[]} changedFiles
 * @param {string[]} testFiles
 * @returns {string[]}
 */
export function snapshotOwners(changedFiles, testFiles) {
  const owners = new Set();
  for (const file of changedFiles) {
    const m = file.match(/^(.*?)(?:^|\/)__snapshots__\/(.+)\.snap$/);
    if (!m) continue;
    const owner = m[1] ? `${m[1]}/${m[2]}` : m[2];
    if (testFiles.includes(owner)) owners.add(owner);
  }
  return [...owners].sort();
}

/**
 * Changed files a JS runner's selection cannot account for. The caller runs
 * the leg in full when this is non-empty.
 *
 * Accounted for: documentation, other languages' code, files the runner's
 * import graph relates (`isSource`), test files, snapshots, and files a test
 * names by path or basename. Not accounted for: anything else under the leg,
 * and JS code outside a sub-directory leg, which a workspace link can reach
 * without any import graph showing it.
 *
 * @param {{ changedFiles: string[], prefix: string, isSource: (f: string) => boolean,
 *           isTest: (f: string) => boolean, testContents: string[] }} input
 * @returns {string[]}
 */
export function unclassifiedJsInputs({ changedFiles, prefix, isSource, isTest, testContents }) {
  const named = (file) => {
    const base = path.posix.basename(file);
    const rel = file.slice(prefix.length);
    return testContents.some((c) => c.includes(rel) || c.includes(base));
  };
  return changedFiles.filter((file) => {
    if (isInert(file) || OTHER_LANG.js.test(file)) return false;
    if (!file.startsWith(prefix)) return isSource(file) || isTest(file);
    if (isSource(file) || isTest(file) || /\/__snapshots__\/.+\.snap$|^__snapshots__\//.test(file)) return false;
    return !named(file);
  });
}
