# §2 — Scope

> What's in, what's out, and where are the boundaries?

**Settled.** The in-scope list started as the ten-item plan from the 2026-09-10 assessment ([DOC-2](../current-state/analysis.md)), grouped by lifecycle stage. SLO checks moved to a follow-up spec, which leaves nine items. The owner settled every scope decision on 2026-09-10 or 2026-09-11, and on 2026-09-11 asked for the remaining sections to be completed from industry practice.

## In Scope

### Spec stage

1. **Acceptance criteria in `spec.json`.** Each entry carries an id, `given`, `when`, and `then` statements, the tests that prove it, one command that runs them, and an optional test report, as KD-1 and KD-3 in §4 and the schema in §5 set. The field is optional. `dotbabel-validate-specs` checks its shape only in a spec that declares it, so every existing spec stays valid.
2. **Criteria-first spec authoring.** The `spec` skill writes criteria into every new spec, per work unit, and each §6.3 implementation prompt names its tests from the criteria, not from the code. The `validate-spec` audit reports a spec without criteria as a finding, and nothing fails.

### PR stage

3. **Criteria verification in `review-pr`.** A new dotbabel command runs the tests that each criterion names, and it records the test name, the run output, and the criterion id as evidence pinned to the head commit. `review-pr` calls it at its test-plan step, after its last push, in standalone and conductor mode alike, so a failing criterion stops the conductor before the `local-attest` matrix. The step runs only when the pull request's spec declares criteria. A new reason code in `pr-gates.mjs` holds the merge gate when the evidence is missing, failing, or pinned to an older commit.
4. **Test-quality judgment.** At the same `review-pr` step, the reviewer rejects assertion-free tests and tests that mirror the implementation. When the repository already configures a mutation tool, `dotbabel quality` detects it, parses its report, and scores only the changed code. New report parsers cover common Python and Go mutation tools next to `stryker-json`. A repository without a mutation tool still gets the judgment, with no score.
5. **Regression checks in the quality configuration.** Delete `verification_commands` and `regression_paths` everywhere they appear. A quality tool in `.dotbabel.json` declares the paths it guards, and `dotbabel quality check` runs it only when a pull request changes one of those paths. The merge gate reads that verdict instead of a written diff summary. The existing, unused `critical_paths` setting takes the second job: a change under a critical path requires the full test suite.
6. **Language coverage.** A Python adapter with a built-in pytest and coverage plan, and Node coverage without a repository script.
7. **Consumer CI templates.** `dotbabel init` ships `test.yml` and `quality.yml` templates next to the existing workflow templates.

### Post-merge

8. **Post-deploy smoke test.** A `smoke-test` skill runs a consumer-declared health check or synthetic transaction after deploy. `release-conductor verify` calls it and `deploy-status` before it reports PASS.

### Hooks

9. **Test gates at the git layer.** A pre-push hook template runs the fast quality profile, and `check-on-stop` can run the changed-file test subset in a trusted repository.

## Out of Scope

- **SLO checks.** SLI queries and error budgets declared in `repo-facts.json`, and the `dotbabel slo check` command that reads them, move to a follow-up spec. They need a connection to a metrics backend, and no dotbabel feature has one today. Decided 2026-09-10.
- **Installing or bundling a mutation tool.** `dotbabel quality` never installs a checker (`docs/quality.md:5`). Item 4 detects only a tool that the repository already configures. Decided 2026-09-10.
- **Requiring criteria in existing specs.** A required field fails the spec validation run in every repository that upgrades dotbabel, and no existing local spec declares criteria (DOC-13). Decided 2026-09-10.
- **A data comparison tool owned by dotbabel.** Data formats vary, and each repository owns its format-aware check. Item 5 triggers that check and does not replace it. Decided 2026-09-10.
- **A new `pr-conductor` phase.** Criteria verification is a step inside `review-pr`, so the phase order and its contract tests stay unchanged. Decided 2026-09-11.
- **Automatic rollback after a failed smoke test.** The rule floor forbids production changes without explicit instruction, so the smoke test recommends `/rollback-prod` and stops (KD-13). Decided 2026-09-11.

## Decisions

- **Q-1 — One spec or two. Resolved 2026-09-10.** Keep the post-deploy smoke test in this spec. Move SLO checks to a follow-up spec, as recorded in Out of Scope.
- **Q-2 — Implement or delete. Resolved 2026-09-10.** Delete both keys. Move targeted regression checks into path-triggered quality tools, and give the full-suite rule to `critical_paths`. Item 5 records the result, and DOC-14 holds the evidence.
- **Q-3 — Phase or step. Resolved 2026-09-11.** Run criteria verification as a step inside `review-pr`, with no new `CONDUCTOR_PHASES` entry. Items 3 and 4 record the result.
- **Q-4 — Mutation runner versus "never installs a checker". Resolved 2026-09-10.** Keep the principle. Detect a mutation tool that the repository already configures, add report parsers for common Python and Go mutation tools, and score only the changed code. Item 4 records the result.
- **Q-5 — Adoption default. Resolved 2026-09-10.** Gate only specs that declare criteria. Items 1, 2, and 3 record the result, and DOC-13 holds the evidence.

## Boundaries

| Touches                                                                                                                              | Does Not Touch                                                                                                          |
| ------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| `plugins/dotbabel/src/validate-specs.mjs` and `plugins/dotbabel/src/lib/errors.mjs`: the criteria shape check and new error codes    | `CONDUCTOR_PHASES` in `plugins/dotbabel/src/pr-gates.mjs`                                                               |
| `plugins/dotbabel/src/criteria/` and `plugins/dotbabel/bin/dotbabel-criteria.mjs`: the new criteria command                          | The phase-order tests in `plugins/dotbabel/tests/bats/pr-conductor.bats` and `plugins/dotbabel/tests/pr-gates.test.mjs` |
| `plugins/dotbabel/src/pr-gates.mjs` and `plugins/dotbabel/bin/dotbabel-pr-stack.mjs`: criteria reason codes and the comment fetch    | The existing `spec.json` required fields                                                                                |
| `plugins/dotbabel/src/local-attest-lib.mjs` and a new `plugins/dotbabel/src/lib/pr-markers.mjs`: shared marker helpers               | The local-attest marker text that `.github/workflows/test.yml` reads                                                    |
| `plugins/dotbabel/src/quality/`: path triggers, `critical_paths`, Python and Node plans, mutation detection, report parsers          | The shipped quality thresholds in `plugins/dotbabel/src/quality/policy.mjs`                                             |
| `plugins/dotbabel/src/project-sync.mjs` and `schemas/`: the `criteria` configuration, the evidence schema, the quality report schema | `skills/rollback-prod`, which the smoke test only recommends                                                            |
| `skills/spec`, `skills/validate-spec`, `skills/review-pr`, and the phase 4 text in `skills/pr-conductor`                             |                                                                                                                         |
| `skills/release-conductor`, `skills/deploy-status`, and a new `skills/smoke-test`                                                    |                                                                                                                         |
| `commands/merge-pr.md`, its template copy, and `.github/prompts/merge-pr.prompt.md`                                                  |                                                                                                                         |
| `CLAUDE.md`: the rule-floor line about these paths, then the generated host files                                                    |                                                                                                                         |
| `docs/repo-facts.json`, `plugins/dotbabel/templates/docs/repo-facts.json`, `examples/minimal-consumer/docs/repo-facts.json`          |                                                                                                                         |
| `plugins/dotbabel/templates/workflows/` and `plugins/dotbabel/templates/githooks/`                                                   |                                                                                                                         |
| `plugins/dotbabel/hooks/check-on-stop.sh` and `plugins/dotbabel/bin/dotbabel-doctor.mjs`                                             |                                                                                                                         |
| `docs/quality.md`, `docs/hooks.md`, `docs/templates.md`, `docs/specs/README.md`, and `.gitignore`                                    |                                                                                                                         |

## Urgency

No hard deadline was stated. §6.1 orders the work by leverage: the spec and pull request stages come first because they close the largest gap in the assessment, and post-deploy checks come last.
