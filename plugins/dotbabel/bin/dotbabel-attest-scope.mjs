#!/usr/bin/env node
/**
 * dotbabel-attest-scope — run one local-attest test leg on the scope of a
 * pull request.
 *
 * `dotbabel local-attest --init` writes this wrapper around each test step it
 * recognises, with `scope: true` on the leg:
 *
 *   dotbabel attest-scope --runner <vitest|jest|go|pytest> -- <CI command...>
 *
 * The runner hands the leg the PR's changed files; this command runs only the
 * tests they can reach, records a skip when they reach none, and runs the CI
 * command unchanged whenever it is unsure. `dotbabel local-attest --full`
 * passes no changed files, so every scoped leg runs in full.
 *
 * Exit codes: the test command's own exit code; 0 for a recorded skip;
 * 64 for a usage error.
 */
import { version } from "../src/index.mjs";
import { main, realIo } from "../src/attest-scope-command.mjs";

const argv = process.argv.slice(2);
if (argv[0] === "--help" || argv[0] === "-h") {
  process.stdout.write(
    [
      "Usage: dotbabel attest-scope --runner <vitest|jest|go|pytest> -- <CI command...>",
      "",
      "Run a local-attest test leg on the scope of the pull request's changes.",
      "Without a changed-file list from local-attest, the CI command runs unchanged.",
      "",
      "Exit codes: the test command's exit code, 0 for a recorded skip, 64 usage error.",
      "",
    ].join("\n"),
  );
} else if (argv[0] === "--version" || argv[0] === "-V") {
  process.stdout.write(`${version}\n`);
} else {
  process.exitCode = main({ argv, env: process.env, io: realIo() });
}
