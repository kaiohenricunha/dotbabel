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
- **PERF-3**: The merge gate reads comments with 1 paginated GraphQL query sequence and finishes within 10 seconds for a pull request with 300 comments.
- **PERF-4**: The pre-push hook stops its check after `DOTBABEL_PRE_PUSH_TIMEOUT`, which defaults to 120 seconds, then prints how to run the check by hand and allows the push.
- **PERF-5**: The related-tests stage of `check-on-stop.sh` stays inside `CHECK_ON_STOP_TIMEOUT`, which defaults to 120 seconds (`plugins/dotbabel/hooks/check-on-stop.sh:78`).
- **PERF-6**: Each HTTP smoke check times out after 10 seconds by default and retries up to 3 times with backoff of 2, 4, and 8 seconds. A smoke run stops after 300 seconds in total.
- **PERF-7**: Matching 10,000 changed files against 50 path globs takes under 500 milliseconds.
- **PERF-8**: The runner captures up to 1 MiB for each output stream, and the evidence records `truncated: true` when a stream reaches that cap (`plugins/dotbabel/src/quality/runner.mjs:9`, `:56-60`).

## Reliability

- **REL-1**: A criterion passes only when its command exits 0 and every named test is confirmed by a JUnit report or by its name in the output. Exit code 0 alone never passes.
- **REL-2**: Evidence is valid only for the exact 40-character head SHA of the pull request. Trusted, unedited evidence for any other SHA returns `CRITERIA_EVIDENCE_STALE`.
- **REL-3**: The merge gate fails closed. An unreadable comment list, a payload that fails its schema, a payload whose `head_sha` differs from its marker, or a `gh` error returns a failing reason and never a pass.
- **REL-20**: Attestation evidence is valid only for the exact 40-character head SHA of the pull request. Trusted, unedited evidence for any other SHA returns `ATTESTATION_STALE`. Mirrors REL-2 for the second evidence family.
- **REL-21**: The attestation half of the merge gate fails closed. An unreadable comment list, a missing or undecodable payload, a payload whose `head_sha` differs from its marker, a payload whose `config_hash` differs from the base ref's governance files, or a required leg that is absent, skipped, or not passing returns a failing reason and never a pass. Mirrors REL-3.
- **REL-23**: An unreadable base commit is a blocking `ATTESTATION_BASE_UNREADABLE` reason, never an absent policy. The gather probes the base with `git cat-file -e` before reading it, because answering "not in this clone" and "declares no policy" identically would let a shallow clone or an unfetched base silently disable the whole ladder.
- **REL-24**: The merge gate reports attestation state explicitly as `verified`, `off` or `failed`, with the attested SHA and leg names when `verified`. A caller must never infer enforcement from an empty reason list: a repository that never opted in and one whose evidence was fully verified both produce no reasons.
- **REL-22**: `/merge-pr` never produces attestation evidence. On any `ATTESTATION_*` reason it stops and names `/local-attest`, so the boundary between conducting a pull request and merging it stays explicit and a stale attestation costs a stop rather than a silent ten-minute re-verification.
- **REL-4**: Each distinct criterion command runs 1 time per verification, and its result applies to every criterion that shares that command. dotbabel never retries a failing criterion.
- **REL-5**: For the same spec, head SHA, and command results, the payload is identical in every field except `generated_at` and `duration_ms`, because specs, criteria, and tests are sorted.
- **REL-6**: The upgrade adds 0 validation errors for every spec in this repository, for the minimal-repo fixture, and for any spec without `acceptance_criteria`. DOC-13 surveyed 38 specs, and none declared criteria.
- **REL-7**: `dotbabel pr-stack phases` still prints the same 6 phases in the same order, and `plugins/dotbabel/tests/bats/pr-conductor.bats` passes unchanged.
- **REL-8**: Only HTTP GET smoke checks retry. A `command` smoke check runs 1 time.
- **REL-9**: A path-triggered tool that matches no changed file reports state `not_triggered` with verdict `info` and never reports `pass`.
- **REL-10**: When any active criterion is not `pass`, `review-pr` reports `BLOCKED` as its last step, and the conductor stops before `local-attest`.
- **REL-11**: The mutation score counts only mutants that start on a changed line. With 0 such mutants, `mutation.changed_score` reports `not_applicable`.
- **REL-12**: A change under `critical_paths` adds the test plans of all components to all 3 profiles (`fast`, `pr`, and `deep`), ignores `--path` narrowing for those plans, and counts their results in the verdict.
- **REL-13**: A planned criterion never runs and never fails the verdict, and the evidence records it as `pending`.
- **REL-14**: The command deletes each criterion's report path before it runs the command, and a report that is missing after the run sets status `error`.
- **REL-15**: A criterion that is active at the base ref and planned or missing at the head fails the gate with `CRITERIA_WEAKENED`, unless the pull request body has a `## Criteria change rationale` section, which turns the reason into a warning.
- **REL-16**: The merge gate reads the `criteria` configuration from the base ref, and reads specs at both refs — the head for what must be proven now, the base for what was active before and for the `linked_paths` that set scope (REL-19). A Spec ID with no spec at the head fails closed with `CRITERIA_SPEC_UNKNOWN`.
- **REL-17**: The gate fails with `CRITERIA_EVIDENCE_INCOMPLETE` when the payload's spec ids or active criterion ids differ from the active criteria of the specs linked at evaluation time.
- **REL-18**: `review-pr` runs criteria verification after its last push, and `/merge-pr` runs it again when the gate reports `CRITERIA_EVIDENCE_STALE`.
- **REL-19**: A spec is in scope when the body declares it or when its `linked_paths` at the base ref match a changed file, and the gate requires the criteria of every in-scope spec. The path match is read at the base ref, so a pull request can neither exclude itself by editing `linked_paths` nor escape the gate by declaring a criteria-free spec or no Spec ID at all. Weakening a spec that the diff pulled in blocks with `CRITERIA_SCOPE_WEAKENED` and is never downgradable by a rationale section, and an unreadable base tree or an unprovable changed-file list fails closed rather than narrowing scope.

## Operational

- **OPS-1**: `dotbabel criteria` exits 0 on a pass, 1 on a criterion failure, 2 on an environment error, and 64 on a usage error, following `plugins/dotbabel/src/lib/exit-codes.mjs`.
- **OPS-2**: Every JSON output of `dotbabel criteria`, `deploy-ops.mjs smoke`, and `dotbabel quality` carries `schema_version: 1` and validates against its schema in `schemas/`. A breaking schema change needs a new version number.
- **OPS-3**: The evidence comment stays at or under 60,000 characters, below the GitHub limit of 65,536 characters (DOC-18). Output tails appear only in the readable part, with at most the last 40 lines and 2,000 characters for each criterion, and the payload stores only a SHA-256 hash of each tail.
- **OPS-4**: dotbabel keeps at most 1 visible evidence comment per pull request **per evidence family**: each run posts a new comment and minimizes the tool's own older comments of that family as `OUTDATED`. It never edits an evidence comment. This covers `dotbabel criteria` and, since P-G1, `local-attest` — which previously PATCHed one comment in place. The two are inseparable: the gate refuses an edited comment, so an upserting producer would have had its own second attestation on any pull request rejected as `ATTESTATION_UNTRUSTED`.
- **OPS-5**: No shipped threshold changes: `coverage.changed_lines` stays at 90 and `mutation.changed_score` stays at 85 (`plugins/dotbabel/src/quality/policy.mjs:38`, `:40`).
- **OPS-6**: `dotbabel doctor` warns when `docs/repo-facts.json` gives `regression_paths` or `verification_commands` a non-empty value, and it names the replacement from KD-5 or KD-6.
- **OPS-7**: Upgrading requires 0 edits to an existing `.dotbabel.json`, `spec.json`, or workflow file for a repository to keep passing.
- **OPS-8**: New code in `plugins/dotbabel/src/` meets 85% lines, 85% functions, 80% branches, and 85% statements (`vitest.config.mjs`), measured in each unit's verify step with `--coverage.include` scoped to that unit's modules.
- **OPS-9**: The test-quality judgment ships only at a precision of at least 0.80 and a recall of at least 0.70 on an eval set of at least 40 labeled tests, scoring no lower than the baseline, and `run.mjs` exits 1 on any breach (§6.4).
- **OPS-10**: `--pass-env` and `criteria.pass_env` pass only the named variables, and each name must match `^[A-Za-z_][A-Za-z0-9_]*$` (`plugins/dotbabel/src/quality/runner.mjs:98`).

## Security

- **SEC-1**: Criterion commands run only in a trusted repository or with `--allow-project-commands` (`plugins/dotbabel/src/quality/runner.mjs:99`, `:118`). For `--pr`, the command also exits 2 when the pull request comes from a fork, or when an author outside `criteria.trusted_associations` changed an active criterion's `argv`, unless `--allow-project-commands` is set.
- **SEC-2**: Criterion commands run as `argv` arrays with `shell: false`, inside the repository, with the environment allowlist of the runner (`plugins/dotbabel/src/quality/runner.mjs:10`, `:22-33`, `:49-55`).
- **SEC-3**: The merge gate accepts an evidence comment only when its author association is in `criteria.trusted_associations`, read from the base ref with default `["OWNER"]`, and when `lastEditedAt` shows no edit (`skills/local-attest/SKILL.md:210`, DOC-22).
- **SEC-4**: Output passes through `redactOutput` before it reaches a comment, a JSON file, or a terminal. A truncated stream drops its last partial line before redaction, and the base64 payload never contains output (`plugins/dotbabel/src/quality/runner.mjs:85-86`).
- **SEC-5**: The review agent treats test output, comments, and test source as untrusted data and never follows instructions found in them (OWASP LLM01, DOC-17).
- **SEC-6**: No text written by a model sets a criterion status. The PreToolUse hook `guard-criteria-evidence.sh` denies a shell command that writes either gate-authoritative evidence marker — the `dotbabel-criteria` family or the `local-attest` marker and payload lines — outside its sanctioned writer. Both are guarded because the merge gate skips the full suite and the quality profile on a local-attest comment, which makes forging one strictly worse than forging a criteria result, and with `criteria.require_ci_check` set, the gate also requires the CI `dotbabel criteria` check on the head SHA (KD-16, R-19).
- **SEC-7**: Every workflow template pins each action to a full 40-character commit SHA, sets top-level `permissions` with `contents: read`, adds only the scopes a job needs, and uses `pull_request`, never `pull_request_target` (DOC-18).
- **SEC-8**: Smoke checks reject URLs with embedded credentials, require `https` for any host except `localhost` and `127.0.0.1`, read secrets only from named environment variables, never print a header value, follow at most 3 redirects and only to the same https origin, and never send a secret header to a different origin (DOC-23).
- **SEC-9**: dotbabel never installs a test, coverage, or mutation tool (`docs/quality.md:5`).
- **SEC-10**: The pre-push hook and the related-tests stage run project commands only in a trusted repository (`plugins/dotbabel/src/trust-allowlist.mjs:216`), and otherwise they skip with a notice.
- **SEC-11**: The JUnit parser rejects any report that declares a DOCTYPE, never expands entities, and stops reading a report after 10 MiB.
- **SEC-12**: The harness never merges a pull request or rolls back a deployment. Both stay behind explicit human instruction (`skills/pr-conductor/SKILL.md:58`).
- **SEC-13**: The CI `dotbabel criteria` job checks out the pull request head SHA, uses `github.token` as its only credential, and never posts evidence.
- **SEC-14**: The merge gate accepts attestation evidence only when its author association is in `attestation.trusted_associations`, read from the base ref with default `["OWNER"]`, and when `lastEditedAt` shows no edit. Mirrors SEC-3.
- **SEC-15**: Attestation evidence carries a `config_hash` over the files named by `attestation.governance_files`, and the gate recomputes that hash from the **base ref**. The list names the script targets the legs invoke, not only the matrix definition: a leg command is usually an indirection, so hashing the matrix alone would leave `package.json`'s `test` script free to be rewritten while the leg still reported a truthful pass. Tooling under `plugins/dotbabel/src/**` is deliberately excluded — hashing it would make every pull request touching the package report `ATTESTATION_CONFIG_CHANGED` — so the guarantee is that the configured commands and their script targets are the ones the trunk agreed to, not that the entire toolchain is pinned. The digest frames each field with its byte length, so no path can borrow bytes from an adjacent field's content. A pull request that edits a governed file therefore cannot authorize itself: without this, rewriting a leg to `command: "true"`, or lowering a quality threshold, would produce evidence that is truthful about the leg and worthless about the code.
- **SEC-16**: The gate reads `attestation` policy and governance bytes with `git show <base-ref>:<path>`, never by executing a file and never from the head. `.dotbabel.json` is JSON for this reason; `.local-attest.config.mjs` is an executable module and is hashed, never evaluated, by the gate.
