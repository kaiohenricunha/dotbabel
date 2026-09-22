#!/usr/bin/env node
/**
 * sync-security-audit — keep the vendored copy of cloudflare/security-audit-skill
 * in skills/security-audit/references/upstream/ pinned and unmodified.
 *
 * The copy is verbatim except for one rename: upstream skills/security-audit/SKILL.md
 * becomes UPSTREAM-SKILL.md, so hosts that scan skill folders recursively do not
 * register a second `security-audit` skill. references/UPSTREAM.json records the
 * repository, the commit, the rename, and a sha256 per file.
 *
 * Modes (exactly one):
 *   --update [--ref <sha>] [--repo <url>]  Replace the copy with upstream at <ref>
 *                                          (default: upstream HEAD) and rewrite the pin.
 *   --check                                Offline: verify the copy matches the pin.
 *   --latest [--repo <url>]                Print the upstream HEAD commit.
 *
 * Flags:
 *   --repo-root <path>   Override repo root (default: git rev-parse --show-toplevel).
 *   --help / -h, --version / -V, --json, --no-color
 *
 * Exits: 0 ok, 1 validation failure (drift, or an upstream file that cannot be
 * shipped), 2 env error (git/network), 64 usage error.
 */

import { parse, helpText } from "../plugins/dotbabel/src/lib/argv.mjs";
import { EXIT_CODES } from "../plugins/dotbabel/src/lib/exit-codes.mjs";
import { createOutput } from "../plugins/dotbabel/src/lib/output.mjs";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const TOOL_VERSION = "1.0.0";
const DEFAULT_REPO = "https://github.com/cloudflare/security-audit-skill";
const SOURCE_DIR = "skills/security-audit";
const RENAMES = Object.freeze({ [`${SOURCE_DIR}/SKILL.md`]: "UPSTREAM-SKILL.md" });
const EXTRA_FILES = Object.freeze(["LICENSE"]);
/** Tokens that init-harness-scaffold.mjs rewrites in every template file. */
const SCAFFOLD_PLACEHOLDERS = Object.freeze(["{{project_name}}", "{{project_type}}", "{{today}}"]);

const META = {
  name: "sync-security-audit",
  synopsis: "sync-security-audit (--update [--ref <sha>] | --check | --latest) [OPTIONS]",
  description: "Sync or verify the pinned copy of cloudflare/security-audit-skill.",
  flags: {
    "repo-root": { type: "string" },
    update: { type: "boolean" },
    check: { type: "boolean" },
    latest: { type: "boolean" },
    ref: { type: "string" },
    repo: { type: "string" },
  },
};

/** An error that carries its exit code. */
class SyncError extends Error {
  constructor(message, exitCode) {
    super(message);
    this.exitCode = exitCode;
  }
}

function usage(message) {
  process.stderr.write(`${message}\n\n${helpText(META)}\n`);
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
  process.stdout.write(`${TOOL_VERSION}\n`);
  process.exit(EXIT_CODES.OK);
}

const modes = ["update", "check", "latest"].filter((mode) => argv.flags[mode]);
if (modes.length !== 1) usage("pass exactly one of --update, --check, --latest");
if (argv.positional.length > 0) usage(`unexpected argument: ${argv.positional[0]}`);
if (argv.flags.ref !== undefined && !argv.flags.update) usage("--ref is valid only with --update");
if (argv.flags.repo !== undefined && argv.flags.check) usage("--repo is not valid with --check");
// Both values reach `git fetch` / `git ls-remote` as arguments. Reject a
// leading "-" so a value cannot become a git option such as --upload-pack.
if (argv.flags.ref !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(argv.flags.ref)) usage(`invalid --ref: ${argv.flags.ref}`);
if (argv.flags.repo !== undefined && !/^(https:\/\/|file:\/\/)[^\s]+$/.test(argv.flags.repo)) usage(`invalid --repo (https:// or file:// URL): ${argv.flags.repo}`);

const out = createOutput({ json: argv.json, noColor: argv.noColor });

function git(args, options = {}) {
  const result = spawnSync("git", args, { encoding: "utf8", ...options });
  if (result.error || result.status !== 0) {
    const detail = result.error?.message ?? result.stderr.trim();
    throw new SyncError(`git ${args.join(" ")} failed: ${detail}`, EXIT_CODES.ENV);
  }
  return result.stdout.trim();
}

function resolveRepoRoot() {
  if (argv.flags["repo-root"]) return resolve(argv.flags["repo-root"]);
  return git(["rev-parse", "--show-toplevel"]);
}

const sha256 = (buffer) => createHash("sha256").update(buffer).digest("hex");

/** Relative paths of every file under `dir`, sorted, rejecting symlinks. */
function listFiles(dir, prefix = "") {
  const files = [];
  for (const entry of readdirSync(join(dir, prefix), { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) throw new SyncError(`${rel}: symlinks cannot be shipped`, EXIT_CODES.VALIDATION);
    if (entry.isDirectory()) files.push(...listFiles(dir, rel));
    else files.push(rel);
  }
  return files.sort();
}

/** Fetch `ref` from `repo` into the empty directory `dir`. Returns the commit. */
function fetchUpstream(dir, repo, ref) {
  git(["init", "-q", dir]);
  git(["-C", dir, "fetch", "-q", "--depth", "1", repo, ref]);
  git(["-C", dir, "-c", "advice.detachedHead=false", "checkout", "-q", "FETCH_HEAD"]);
  return git(["-C", dir, "rev-parse", "HEAD"]);
}

/** Map upstream files to their destination names and validate each one. */
function collectUpstreamFiles(checkout) {
  const sourceRoot = join(checkout, SOURCE_DIR);
  if (!existsSync(sourceRoot)) {
    throw new SyncError(`upstream has no ${SOURCE_DIR}/ folder; the layout changed`, EXIT_CODES.VALIDATION);
  }
  const upstreamPaths = [...listFiles(sourceRoot).map((rel) => `${SOURCE_DIR}/${rel}`), ...EXTRA_FILES];
  const files = new Map();
  const problems = [];
  for (const upstreamPath of upstreamPaths) {
    const abs = join(checkout, upstreamPath);
    if (!existsSync(abs) || lstatSync(abs).isSymbolicLink()) {
      problems.push(`${upstreamPath}: missing or a symlink`);
      continue;
    }
    const dest = RENAMES[upstreamPath] ?? upstreamPath.replace(`${SOURCE_DIR}/`, "");
    if (dest.endsWith("SKILL.md") && !RENAMES[upstreamPath]) {
      problems.push(`${upstreamPath}: nested SKILL.md would register a second skill`);
    }
    if (files.has(dest)) problems.push(`${upstreamPath}: collides with another file at ${dest}`);
    const buffer = readFileSync(abs);
    let text = "";
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
    } catch {
      problems.push(`${upstreamPath}: not valid UTF-8 text`);
    }
    if (text.includes("\0")) problems.push(`${upstreamPath}: not valid UTF-8 text (NUL byte)`);
    for (const token of SCAFFOLD_PLACEHOLDERS) {
      if (text.includes(token)) problems.push(`${upstreamPath}: contains scaffolder placeholder ${token}`);
    }
    files.set(dest, { upstreamPath, buffer });
  }
  if (problems.length > 0) throw new SyncError(problems.join("\n"), EXIT_CODES.VALIDATION);
  return files;
}

function update(repoRoot, repo, ref) {
  const dir = mkdtempSync(join(tmpdir(), "sync-security-audit-"));
  try {
    const commit = fetchUpstream(dir, repo, ref);
    const files = collectUpstreamFiles(dir);
    const { upstreamDir, pinPath } = paths(repoRoot);
    rmSync(upstreamDir, { recursive: true, force: true });
    const pinFiles = {};
    for (const dest of [...files.keys()].sort()) {
      const { upstreamPath, buffer } = files.get(dest);
      mkdirSync(dirname(join(upstreamDir, dest)), { recursive: true });
      writeFileSync(join(upstreamDir, dest), buffer);
      pinFiles[dest] = { upstream_path: upstreamPath, sha256: sha256(buffer) };
    }
    const pin = {
      repository: repo,
      commit,
      synced_at: new Date().toISOString().slice(0, 10),
      renames: { ...RENAMES },
      files: pinFiles,
    };
    mkdirSync(dirname(pinPath), { recursive: true });
    writeFileSync(pinPath, `${JSON.stringify(pin, null, 2)}\n`);
    out.pass(`synced ${files.size} files from ${repo}@${commit.slice(0, 7)}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function check(repoRoot) {
  const { upstreamDir, pinPath } = paths(repoRoot);
  if (!existsSync(pinPath)) throw new SyncError(`missing pin file ${pinPath} (UPSTREAM.json)`, EXIT_CODES.VALIDATION);
  let pin;
  try {
    pin = JSON.parse(readFileSync(pinPath, "utf8"));
  } catch (err) {
    throw new SyncError(`UPSTREAM.json is not valid JSON: ${err.message}`, EXIT_CODES.VALIDATION);
  }
  const expected = pin.files ?? {};
  const actual = existsSync(upstreamDir) ? listFiles(upstreamDir) : [];
  const problems = [];
  for (const rel of actual) {
    if (!expected[rel]) problems.push(`${rel}: not in UPSTREAM.json (extra file)`);
    else if (sha256(readFileSync(join(upstreamDir, rel))) !== expected[rel].sha256) {
      problems.push(`${rel}: content differs from upstream ${pin.commit} (hand-edited?)`);
    }
  }
  for (const rel of Object.keys(expected)) {
    if (!actual.includes(rel)) problems.push(`${rel}: missing`);
  }
  if (problems.length > 0) {
    throw new SyncError(
      `${problems.join("\n")}\nrun: node scripts/sync-security-audit.mjs --update --ref ${pin.commit}`,
      EXIT_CODES.VALIDATION,
    );
  }
  out.pass(`security-audit upstream copy matches ${pin.commit.slice(0, 7)} (${actual.length} files)`);
}

function paths(repoRoot) {
  const references = join(repoRoot, "skills", "security-audit", "references");
  return { upstreamDir: join(references, "upstream"), pinPath: join(references, "UPSTREAM.json") };
}

try {
  const repo = argv.flags.repo ?? DEFAULT_REPO;
  if (argv.flags.latest) {
    const line = git(["ls-remote", repo, "HEAD"]);
    const commit = line.split(/\s+/)[0];
    if (!/^[0-9a-f]{40}$/.test(commit)) throw new SyncError(`unexpected ls-remote output: ${line}`, EXIT_CODES.ENV);
    process.stdout.write(`${commit}\n`);
    process.exit(EXIT_CODES.OK);
  }
  const repoRoot = resolveRepoRoot();
  if (argv.flags.update) update(repoRoot, repo, argv.flags.ref ?? "HEAD");
  else check(repoRoot);
  out.flush();
  process.exit(EXIT_CODES.OK);
} catch (err) {
  if (!(err instanceof SyncError)) throw err;
  for (const line of err.message.split("\n")) out.fail(line);
  out.flush();
  process.exit(err.exitCode);
}
