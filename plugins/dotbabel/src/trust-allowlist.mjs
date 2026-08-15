/**
 * check-on-stop trust allowlist — the writer and reader for the user-scope
 * file that `plugins/dotbabel/hooks/check-on-stop.sh` consults before it runs
 * any project check.
 *
 * Why the file exists: that hook runs a repo's own build tooling at turn end,
 * and build tooling executes repo-controlled code by design — `cargo check`
 * runs `build.rs`, `mvn` runs plugins, `dotnet` runs MSBuild targets. So the
 * hook refuses to act in a repo the user has not explicitly allowlisted.
 *
 * Why the file is user-scope: an in-tree marker was tried first and rejected.
 * A hostile repo simply commits it and arrives pre-trusted on clone. See
 * `check-on-stop.sh` for the full rationale.
 *
 * This module owns both halves — the grant and the query — so the writer and
 * the doctor can never disagree about what "trusted" means.
 *
 * File format, matching `check-on-stop.sh`: one absolute path per line; blank
 * lines and `#` comments ignored; each entry resolved before an exact compare.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";

import { ERROR_CODES, ValidationError } from "./lib/errors.mjs";
import { configDir } from "./lib/paths.mjs";

/** Basename of the allowlist inside the dotbabel config directory. */
const TRUST_FILE_NAME = "check-on-stop-trusted";

/** Written once, only when this module creates the file. */
const HEADER = [
  "# dotbabel check-on-stop trust allowlist. One absolute path per line.",
  "# Repos listed here may run their own build tooling at turn end.",
  "# Consumer: plugins/dotbabel/hooks/check-on-stop.sh",
  "# Revoke: delete the line.",
  "",
].join("\n");

/**
 * Resolve the allowlist path exactly as `check-on-stop.sh` does.
 *
 * The precedence must stay identical to the hook's, or a user who sets
 * `CHECK_ON_STOP_TRUSTED_FILE` gets the hook reading one file while a grant
 * writes another — a silent no-grant, which is the failure this module exists
 * to remove.
 *
 * @param {NodeJS.ProcessEnv} [env] Defaults to `process.env`.
 * @returns {string} Absolute path to the allowlist file.
 */
export function resolveTrustFilePath(env = process.env) {
  if (env.CHECK_ON_STOP_TRUSTED_FILE) return env.CHECK_ON_STOP_TRUSTED_FILE;
  return join(configDir(env), TRUST_FILE_NAME);
}

/**
 * Resolve a repo path to the physical form `check-on-stop.sh` compares against
 * (it uses `cd "$dir" && pwd -P`, which `realpathSync` matches).
 *
 * @param {string} repoRoot
 * @param {string} trustFile Used only to attach context to a thrown error.
 * @returns {string}
 */
function resolveEntry(repoRoot, trustFile) {
  let entry;
  try {
    entry = realpathSync(repoRoot);
  } catch (err) {
    throw new ValidationError({
      code: ERROR_CODES.TRUST_WRITE_FAILED,
      category: "env",
      file: trustFile,
      message: `cannot resolve ${repoRoot}: ${err.message}`,
      hint: "The repo path must exist and be readable before it can be trusted.",
    });
  }
  // A newline would append a SECOND allowlist entry naming a directory the
  // user never chose. Linux permits newlines in directory names, so this is
  // reachable via a crafted --repo.
  if (entry.includes("\n") || entry.includes("\r") || !isAbsolute(entry)) {
    throw new ValidationError({
      code: ERROR_CODES.TRUST_WRITE_FAILED,
      category: "env",
      file: trustFile,
      message: `refusing to record an unsafe path: ${JSON.stringify(entry)}`,
      hint: "A trusted path must be absolute and free of newline characters.",
    });
  }
  return entry;
}

/**
 * Split allowlist text into the entries the hook would actually consider.
 *
 * @param {string} text
 * @returns {string[]} Raw entry lines, comments and blanks removed.
 */
function readEntries(text) {
  return text
    .split("\n")
    // Strip a trailing CR so a CRLF-edited file cannot yield "/path\r", which
    // the hook's `cd` would reject — a silently dead entry.
    .map((line) => line.replace(/\r$/, ""))
    .filter((line) => line !== "" && !line.startsWith("#"));
}

/**
 * True when `entries` already grants trust to `resolved`.
 *
 * Matches on raw equality OR on resolved equality, deliberately. Resolve-only
 * would miss an entry whose directory has since been deleted and append a
 * byte-identical duplicate; raw-only would miss a symlink alias of the same
 * repo. Both together are a cheap superset of the hook's own semantics.
 *
 * @param {string[]} entries
 * @param {string} resolved
 * @returns {boolean}
 */
function alreadyTrusted(entries, resolved) {
  for (const entry of entries) {
    if (entry === resolved) return true;
    try {
      if (realpathSync(entry) === resolved) return true;
    } catch {
      // An entry that no longer resolves cannot match; raw equality above
      // already covered the case where it is textually identical.
    }
  }
  return false;
}

/**
 * Grant a repo check-on-stop trust by recording it in the user-scope allowlist.
 *
 * The recorded path is realpath-resolved. That keeps the grant idempotent
 * across symlink aliases of one repo, and pins the capability to a physical
 * directory so repointing a symlink cannot move it to another checkout.
 *
 * @param {object} opts
 * @param {string} opts.repoRoot Absolute path to the repo to trust.
 * @param {NodeJS.ProcessEnv} [opts.env] Defaults to `process.env`.
 * @param {boolean} [opts.dryRun] Report the action; write nothing.
 * @returns {{action: 'added'|'already-present'|'would-add', trustFile: string,
 *   entry: string, createdFile: boolean}}
 * @throws {ValidationError} `TRUST_WRITE_FAILED` when the path cannot be
 *   resolved, is unsafe, or the allowlist cannot be written.
 */
export function grantCheckOnStopTrust(opts) {
  const env = opts.env ?? process.env;
  const trustFile = resolveTrustFilePath(env);
  const entry = resolveEntry(opts.repoRoot, trustFile);

  const fileExists = existsSync(trustFile);
  let existingText = "";
  if (fileExists) {
    try {
      existingText = readFileSync(trustFile, "utf8");
    } catch (err) {
      throw new ValidationError({
        code: ERROR_CODES.TRUST_WRITE_FAILED,
        category: "env",
        file: trustFile,
        message: `cannot read the trust allowlist: ${err.message}`,
        hint: `Check permissions on ${trustFile}.`,
      });
    }
  }

  if (alreadyTrusted(readEntries(existingText), entry)) {
    return { action: "already-present", trustFile, entry, createdFile: false };
  }

  if (opts.dryRun) {
    return { action: "would-add", trustFile, entry, createdFile: false };
  }

  // A file that does not end in a newline would otherwise have this entry
  // concatenated onto its last line, destroying BOTH entries silently. Fold
  // the fixup into the same single append so O_APPEND keeps it atomic.
  const needsLeadingNewline = existingText.length > 0 && !existingText.endsWith("\n");
  const payload = (fileExists ? "" : HEADER) + (needsLeadingNewline ? "\n" : "") + entry + "\n";

  try {
    // mode applies only to directories this call creates, and is umask-masked.
    // An existing directory is deliberately left alone — ~/.config/dotbabel is
    // shared with other dotbabel state.
    mkdirSync(dirname(trustFile), { recursive: true, mode: 0o700 });
    // mode applies only on creation. This file is a capability list: a
    // group-writable one lets any local user grant themselves turn-end code
    // execution in the owner's repos.
    appendFileSync(trustFile, payload, { mode: 0o600 });
  } catch (err) {
    throw new ValidationError({
      code: ERROR_CODES.TRUST_WRITE_FAILED,
      category: "env",
      file: trustFile,
      message: `cannot write the trust allowlist: ${err.message}`,
      hint: `Add the entry by hand: echo ${entry} >> ${trustFile}`,
    });
  }

  return { action: "added", trustFile, entry, createdFile: !fileExists };
}

/**
 * Query whether a repo is currently trusted, using the same rules the hook
 * applies. Never throws — a doctor check must not fail a run over an
 * unreadable optional file.
 *
 * @param {object} opts
 * @param {string} opts.repoRoot
 * @param {NodeJS.ProcessEnv} [opts.env] Defaults to `process.env`.
 * @returns {{trusted: boolean, trustFile: string, fileExists: boolean,
 *   trustAll: boolean, matchedEntry?: string, readError?: string}}
 */
export function isRepoTrusted(opts) {
  const env = opts.env ?? process.env;
  const trustFile = resolveTrustFilePath(env);
  const trustAll = env.CHECK_ON_STOP_TRUST_ALL === "1";

  if (trustAll) {
    return { trusted: true, trustFile, fileExists: existsSync(trustFile), trustAll: true };
  }
  if (!existsSync(trustFile)) {
    return { trusted: false, trustFile, fileExists: false, trustAll: false };
  }

  let resolved;
  try {
    resolved = realpathSync(opts.repoRoot);
  } catch (err) {
    return {
      trusted: false,
      trustFile,
      fileExists: true,
      trustAll: false,
      readError: err.message,
    };
  }

  let text;
  try {
    text = readFileSync(trustFile, "utf8");
  } catch (err) {
    return {
      trusted: false,
      trustFile,
      fileExists: true,
      trustAll: false,
      readError: err.message,
    };
  }

  for (const entry of readEntries(text)) {
    let entryResolved = entry;
    try {
      entryResolved = realpathSync(entry);
    } catch {
      // Matches the hook: an entry that cannot be resolved is skipped.
      continue;
    }
    if (entryResolved === resolved) {
      return {
        trusted: true,
        trustFile,
        fileExists: true,
        trustAll: false,
        matchedEntry: entry,
      };
    }
  }
  return { trusted: false, trustFile, fileExists: true, trustAll: false };
}
