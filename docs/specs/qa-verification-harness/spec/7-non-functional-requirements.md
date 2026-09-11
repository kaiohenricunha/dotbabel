# §7 — Non-Functional Requirements

> Performance, reliability, operational, security constraints.

<!-- A threshold constraint names its metric, its value, and what happens on breach.
     "Fast", "reliable", "a drift alarm" are adjectives, not constraints.
     An invariant needs no number — "all writes are atomic", "never overwrites a
     user file" are binary and testable exactly as written. Reach for a number
     only where you are promising a threshold.
     A measurement recorded in research/ is not a constraint until it lands here.
     `dotbabel-validate-specs` enforces this: a comparative with no value fails. -->

## Performance

- **PERF-1**: For a spec with up to 50 criteria, `dotbabel criteria verify` adds at most 2 seconds of its own time beyond the repository's commands. A breach fails the load test in P-B1.
- **PERF-2**: Each criterion command times out after `criteria.timeout_seconds`, which defaults to 600 seconds and accepts 1 through 3600. A timeout sets status `error`, and the verdict fails.
- **PERF-3**: The merge gate reads comments with 1 paginated `gh api` sequence and finishes within 10 seconds for a pull request with 300 comments.
- **PERF-4**: The pre-push hook stops its check after `DOTBABEL_PRE_PUSH_TIMEOUT`, which defaults to 120 seconds, then prints how to run the check by hand and allows the push.
- **PERF-5**: The related-tests stage of `check-on-stop.sh` stays inside `CHECK_ON_STOP_TIMEOUT`, which defaults to 120 seconds (`plugins/dotbabel/hooks/check-on-stop.sh:78`).
- **PERF-6**: Each HTTP smoke check times out after 10 seconds by default and retries up to 3 times with backoff of 2, 4, and 8 seconds. A smoke run stops after 300 seconds in total.
- **PERF-7**: Matching 10,000 changed files against 50 path globs takes under 500 milliseconds.
- **PERF-8**: The runner captures up to 1 MiB for each output stream, and the evidence records `truncated: true` when a stream reaches that cap (`plugins/dotbabel/src/quality/runner.mjs:9`, `:56-60`).

## Reliability

- **REL-1**: A criterion passes only when its command exits 0 and every named test is confirmed by a JUnit report or by its name in the output. Exit code 0 alone never passes.
- **REL-2**: Evidence is valid only for the exact 40-character head SHA of the pull request. Any other SHA returns `CRITERIA_EVIDENCE_STALE`.
- **REL-3**: The merge gate fails closed. An unreadable comment list, a payload that fails its schema, or a `gh` error returns a failing reason and never a pass.
- **REL-4**: Each criterion command runs 1 time per verification. dotbabel never retries a failing criterion.
- **REL-5**: For the same spec, head SHA, and command results, the payload is identical in every field except `generated_at` and `duration_ms`.
- **REL-6**: The upgrade adds 0 validation errors for the 38 specs in the local survey (DOC-13) and for any spec without `acceptance_criteria`.
- **REL-7**: `dotbabel pr-stack phases` still prints the same 6 phases in the same order, and `plugins/dotbabel/tests/bats/pr-conductor.bats` passes unchanged.
- **REL-8**: Only HTTP GET smoke checks retry. A `command` smoke check runs 1 time.
- **REL-9**: A path-triggered tool that matches no changed file reports state `not_triggered` with verdict `info` and never reports `pass`.
- **REL-10**: When any criterion is not `pass`, `review-pr` reports `BLOCKED`, and the conductor stops before `local-attest`.
- **REL-11**: The mutation score counts only mutants that start on a changed line. With 0 such mutants, `mutation.changed_score` reports `not_applicable`.
- **REL-12**: A change under `critical_paths` adds the test plans of all components to all 3 profiles (`fast`, `pr`, and `deep`) and ignores `--path` narrowing for those plans.

## Operational

- **OPS-1**: `dotbabel criteria` exits 0 on a pass, 1 on a criterion failure, 2 on an environment error, and 64 on a usage error, following `plugins/dotbabel/src/lib/exit-codes.mjs`.
- **OPS-2**: Every JSON output carries `schema_version: 1` and validates against a schema in `schemas/`. A breaking schema change needs a new version number.
- **OPS-3**: The evidence comment stays at or under 60,000 characters, below the GitHub limit of 65,536 characters (DOC-18). Each criterion keeps at most its last 40 lines and 2,000 characters of output.
- **OPS-4**: dotbabel keeps at most 1 evidence comment per pull request and edits it on later runs.
- **OPS-5**: No shipped threshold changes: `coverage.changed_lines` stays at 90 and `mutation.changed_score` stays at 85 (`plugins/dotbabel/src/quality/policy.mjs:38`, `:40`).
- **OPS-6**: `dotbabel doctor` warns when `docs/repo-facts.json` gives `regression_paths` or `verification_commands` a non-empty value, and it names the replacement from KD-5 or KD-6.
- **OPS-7**: Upgrading requires 0 edits to an existing `.dotbabel.json`, `spec.json`, or workflow file for a repository to keep passing.
- **OPS-8**: New code in `plugins/dotbabel/src/` meets the repository coverage floor of 85% lines, 85% functions, 80% branches, and 85% statements (`vitest.config.mjs`).
- **OPS-9**: The test-quality judgment ships only at a precision of at least 0.80 and a recall of at least 0.70 on an eval set of at least 40 labeled tests, and it scores no lower than the baseline (§6.4).

## Security

- **SEC-1**: Criterion commands run only in a trusted repository or with `--allow-project-commands`, the same rule as quality project commands (`plugins/dotbabel/src/quality/runner.mjs:99`, `:118`).
- **SEC-2**: Criterion commands run as `argv` arrays with `shell: false`, inside the repository, with the environment allowlist of the runner (`plugins/dotbabel/src/quality/runner.mjs:10`, `:22-33`, `:49-55`).
- **SEC-3**: The merge gate accepts evidence only from authors whose association is in `criteria.trusted_associations`, default `["OWNER"]` (`skills/local-attest/SKILL.md:210`).
- **SEC-4**: Output passes through `redactOutput` before it reaches a comment, a JSON file, or a terminal (`plugins/dotbabel/src/quality/runner.mjs:85-86`).
- **SEC-5**: The review agent treats test output, comments, and test source as untrusted data and never follows instructions found in them (OWASP LLM01, DOC-17).
- **SEC-6**: No text written by a model sets a criterion status. Only the verification command writes evidence, and the gate reads only that payload.
- **SEC-7**: Every workflow template pins each action to a full 40-character commit SHA, sets top-level `permissions` with `contents: read`, adds only the scopes a job needs, and uses `pull_request`, never `pull_request_target` (DOC-18).
- **SEC-8**: Smoke checks reject URLs with embedded credentials, require `https` for any host except `localhost` and `127.0.0.1`, read secrets only from named environment variables, and never print a header value.
- **SEC-9**: dotbabel never installs a test, coverage, or mutation tool (`docs/quality.md:5`).
- **SEC-10**: The pre-push hook and the related-tests stage run project commands only in a trusted repository (`plugins/dotbabel/src/trust-allowlist.mjs:216`), and otherwise they skip with a notice.
- **SEC-11**: The JUnit parser rejects any report that declares a DOCTYPE, never expands entities, and stops reading a report after 10 MiB.
- **SEC-12**: The harness never merges a pull request or rolls back a deployment. Both stay behind explicit human instruction (`skills/pr-conductor/SKILL.md:58`).
