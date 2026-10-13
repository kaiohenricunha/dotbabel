// Each `when.changedPaths` list below is the leg's real inputs, read from the
// scripts it runs. Glob dialect: **, *, ? only.
const PACKAGE = ["package.json", "package-lock.json"];

export default {
  // The `test` workflow (.github/workflows/test.yml) is gated off a local
  // attestation, so these legs cover its `test` job: vitest+coverage, the
  // validate-settings suite, and bats. lint/dogfood/build-plugin run too.
  //
  // Every run is PR-SCOPED (owner decision): it verifies the scope of the pull
  // request's changes and nothing more. The full suite runs only on demand
  // (`local-attest --full`, or the deep quality job) or on a schedule.
  // - lint, test and bats have `scope: true` and run through the governed
  //   plugins/dotbabel/scripts/attest-scope.mjs, which selects the changed
  //   files' lint targets, related and path-matched tests, and bats suites,
  //   and reports a skip when nothing is in scope. Without the PR's file list
  //   it runs the leg in full, exactly as before.
  // - dogfood, build-plugin --check and validate-settings check whole-repo
  //   invariants, so each runs only when a changed file is one of its inputs.
  // - quality always runs: it is already diff-scoped (`--base`), and it is the
  //   required leg that always executes.
  //
  // This file is a GOVERNANCE FILE (.dotbabel.json -> attestation). Its bytes
  // are hashed into every attestation, and the merge gate recomputes that hash
  // from the base ref. Changing a command here is therefore not something a
  // pull request can do and then attest its own change with: the hashes
  // differ, the gate reports ATTESTATION_CONFIG_CHANGED, and the change lands
  // through explicit verification instead. That is deliberate — without it,
  // rewriting a leg to `true` would produce a truthful "test: pass".
  matrix: [
    { name: "lint", mode: "hard", command: "node plugins/dotbabel/scripts/attest-scope.mjs lint", scope: true },
    // `produces` is what lets the `quality` leg below reuse this run instead of
    // repeating it. `npm test -- --coverage` is the suite AND the coverage run
    // (`npm run coverage` is `vitest run --coverage`, the same command), so its
    // exit code answers quality's `test` capability and the lcov it writes answers
    // `coverage`. It is hashed after the leg passes, so the quality leg parses
    // exactly the file this leg wrote and refuses one that is not.
    {
      name: "test",
      mode: "hard",
      command: "node plugins/dotbabel/scripts/attest-scope.mjs test",
      scope: true,
      produces: ["coverage/lcov.info"],
    },
    {
      name: "validate-settings",
      mode: "hard",
      command: "bash plugins/dotbabel/tests/test_validate_settings.sh",
      // The suite, the validator it runs, and the library the validator sources.
      when: {
        changedPaths: [
          "plugins/dotbabel/tests/test_validate_settings.sh",
          "plugins/dotbabel/scripts/validate-settings.sh",
          "plugins/dotbabel/scripts/lib/**",
          ...PACKAGE,
        ],
      },
    },
    // Scoped: the wrapper runs the suites that name a changed file (or a bin
    // that reaches one) through the same plugins/dotbabel/scripts/run-bats.sh
    // the workflow's bats step uses, and every suite when run-bats.sh or a
    // bats helper changed. bats is the longest leg in full: ~125s serial,
    // ~56s at -j 8.
    { name: "bats", mode: "hard", command: "node plugins/dotbabel/scripts/attest-scope.mjs bats", scope: true },
    // The PR quality profile moved here from `/merge-pr` step 7. It belongs
    // in the attested matrix for two reasons: merge-pr ran it inside a
    // throwaway worktree that project-command trust can never match (so it
    // reported exit 2 far more often than it reported a verdict), and every
    // conductor commit carries `[skip ci]`, which suppresses the whole
    // workflow run — so `quality.yml` never fires on a conductor-driven pull
    // request either. Locally, from the real checkout, it is the only place
    // the policy actually gets measured.
    //
    // It used to re-execute lint and the suite (twice: `npm test` and `npm run
    // coverage`), which the `lint` and `test` legs above had just run — measured
    // at ~50s of a 53s leg. `--reuse` removes that: a capability is taken from
    // the matching leg ONLY when the run manifest proves it is about this exact
    // commit, on a clean tree, from a leg that passed, with any report file
    // still hashing to what that leg wrote. On any doubt the tool simply runs
    // itself, so this can only ever remove redundant work.
    //
    // Consequence for the gate: quality no longer runs lint itself, so `lint`
    // must be a REQUIRED attestation leg (.dotbabel.json) or lint would stop
    // being evidence at all.
    {
      name: "quality",
      mode: "hard",
      // The PR's real base, not a hardcoded trunk: on a stacked pull request the
      // base is the parent branch, and grading against `main` would measure the
      // parent's diff too. The runner injects DOTBABEL_PR_BASE_REF for every leg.
      command:
        "node plugins/dotbabel/bin/dotbabel-quality.mjs check --profile pr --base \"origin/${DOTBABEL_PR_BASE_REF:-main}\" --reuse lint=lint --reuse test=test --reuse coverage=test",
    },
    {
      name: "dogfood",
      mode: "hard",
      command: "npm run dogfood",
      // The seven validators in package.json's `dogfood` script: the bins and
      // their src closure, the skills inventory, specs, the rule floor and its
      // fan-out, repo facts, the compute schema and its generator, and the
      // protected paths check-spec-coverage classifies a diff by.
      when: {
        changedPaths: [
          ...PACKAGE,
          "plugins/dotbabel/bin/**",
          "plugins/dotbabel/src/**",
          "plugins/dotbabel/templates/**",
          "scripts/build-compute-schema.mjs",
          "schemas/dotbabel.compute.schema.json",
          ".prettierrc*",
          ".editorconfig",
          ".claude/**",
          ".github/workflows/**",
          ".github/copilot-instructions.md",
          "commands/*.md",
          "skills/*/SKILL.md",
          "docs/specs/**",
          "docs/repo-facts.json",
          "CLAUDE.md",
          "README.md",
          "AGENTS.md",
          "GEMINI.md",
        ],
      },
    },
    {
      name: "build-plugin --check",
      mode: "hard",
      command: "npm run build-plugin -- --check",
      // scripts/build-plugin.mjs: the artifact index, the skills, commands and
      // agents it copies (skill support dirs included), the templates it
      // compares against, plugin.json, and package.json's version.
      when: {
        changedPaths: [
          ...PACKAGE,
          "scripts/build-plugin.mjs",
          "plugins/dotbabel/src/lib/argv.mjs",
          "plugins/dotbabel/src/lib/exit-codes.mjs",
          "plugins/dotbabel/src/lib/output.mjs",
          "index/**",
          "skills/**",
          "commands/**",
          "agents/**",
          "plugins/dotbabel/templates/claude/**",
          "plugins/dotbabel/.claude-plugin/**",
        ],
      },
    },
  ],
  pushAfterAttest: true,
  // CI's test job runs node 20 and 22 (.github/workflows/test.yml); a local
  // run can only certify one of them. Pin to 22 so an attest never silently
  // runs on some other Node — the 20-leg coverage is genuinely skipped under
  // attestation either way, which predates this pin.
  toolchain: { node: "22" },
};
