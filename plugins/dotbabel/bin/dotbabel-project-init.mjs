#!/usr/bin/env node
/**
 * dotbabel-project-init — minimal scaffolder for cross-CLI project sync.
 *
 * Writes `.dotbabel.json`, `.claude/commands/.gitkeep`, `.claude/skills/.gitkeep`,
 * and a starter `CLAUDE.md` (with rule-floor markers) when missing. Distinct
 * from `dotbabel init` (which scaffolds the full spec-governance harness).
 *
 * Flags:
 *   --repo <path>   target repo root (default: cwd)
 *   --force         overwrite an existing `.dotbabel.json`
 *   --dry-run       report planned actions, do not mutate the filesystem
 *   --trust         also grant this repo check-on-stop trust (see below)
 *
 * `--trust` is opt-in on purpose. It records the repo in the user-scope
 * allowlist that `hooks/check-on-stop.sh` reads, which permits that hook to
 * run the repo's own build tooling at turn end — and build tooling executes
 * repo-controlled code (`build.rs`, Maven plugins, MSBuild targets). Because
 * `skills/project-sync/SKILL.md` tells an agent to run this command, a
 * default-on grant would let a model hand a repo that capability with no
 * human in the loop. So the grant requires an explicit flag.
 *
 * Exits: 0 ok, 1 SCAFFOLD_CONFLICT or other ValidationError, 2 env error,
 * 64 usage error. A failed trust grant warns and still exits 0 — the repo
 * scaffold has already succeeded by then, and the grant is secondary.
 */

import path from "node:path";
import { parse, helpText } from "../src/lib/argv.mjs";
import { createOutput } from "../src/lib/output.mjs";
import { EXIT_CODES } from "../src/lib/exit-codes.mjs";
import { formatError, ValidationError } from "../src/lib/errors.mjs";
import { version } from "../src/index.mjs";
import { scaffoldProjectInit } from "../src/project-init-scaffold.mjs";
import { grantCheckOnStopTrust } from "../src/trust-allowlist.mjs";

const META = {
  name: "dotbabel-project-init",
  synopsis: "dotbabel-project-init [OPTIONS]",
  description:
    "Scaffold the minimum cross-CLI project-sync layout (.dotbabel.json + .claude/ skeleton + starter CLAUDE.md) into a repo.",
  flags: {
    repo: { type: "string" },
    force: { type: "boolean" },
    "dry-run": { type: "boolean" },
    trust: { type: "boolean" },
  },
};

let argv;
try {
  argv = parse(process.argv.slice(2), META.flags);
} catch (err) {
  process.stderr.write(`${err.message}\n`);
  process.exit(EXIT_CODES.USAGE);
}

if (argv.help) {
  process.stdout.write(`${helpText(META)}\n`);
  process.exit(EXIT_CODES.OK);
}
if (argv.version) {
  process.stdout.write(`${version}\n`);
  process.exit(EXIT_CODES.OK);
}

const out = createOutput({ json: argv.json, noColor: argv.noColor });

const repoRoot = path.resolve(
  /** @type {string} */ (argv.flags.repo ?? process.cwd()),
);

try {
  const result = scaffoldProjectInit({
    repoRoot,
    force: Boolean(argv.flags.force),
    dryRun: Boolean(argv.flags["dry-run"]),
  });
  out.pass(
    `project-init complete in ${repoRoot} (${result.filesWritten.length} written, ${result.skipped.length} skipped)`,
  );
  if (argv.verbose || result.filesWritten.length > 0) {
    for (const f of result.filesWritten) out.info(`  + ${f}`);
    for (const s of result.skipped) out.info(`  - ${s} (already present)`);
  }

  if (argv.flags.trust) {
    // Its own try/catch: the scaffold above has already written files, so a
    // failed *secondary* user-scope write must not turn a successful
    // project-init into exit 1. The outer handler would do exactly that,
    // because it maps ValidationError straight to EXIT_CODES.VALIDATION.
    try {
      const grant = grantCheckOnStopTrust({
        repoRoot,
        env: process.env,
        dryRun: Boolean(argv.flags["dry-run"]),
      });
      if (grant.action === "added") {
        // Loud on purpose. This is a privilege grant, even though it was asked
        // for: the repo may now run its own build tooling at every turn end.
        out.warn(
          `check-on-stop trust GRANTED to ${grant.entry} (recorded in ${grant.trustFile}). ` +
            "That repo's build tooling may now run at turn end. Revoke by deleting the line.",
          { trustFile: grant.trustFile, entry: grant.entry },
        );
      } else if (grant.action === "already-present") {
        out.info(`  check-on-stop trust already granted (${grant.trustFile})`);
      } else {
        out.info(`  (dry-run) would grant check-on-stop trust to ${grant.entry}`);
      }
    } catch (err) {
      out.warn(
        `check-on-stop trust NOT granted: ${err.message}`,
        err instanceof ValidationError ? err.toJSON() : undefined,
      );
    }
  }

  out.flush();
  process.exit(EXIT_CODES.OK);
} catch (err) {
  if (err instanceof ValidationError) {
    out.fail(formatError(err, { verbose: argv.verbose }), err.toJSON());
    out.flush();
    process.exit(EXIT_CODES.VALIDATION);
  }
  out.fail(`project-init failed: ${err.message}`);
  out.flush();
  process.exit(EXIT_CODES.ENV);
}
