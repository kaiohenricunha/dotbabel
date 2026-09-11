# Current State Analysis

> Analysis of the existing system being redesigned.

Grounded audit of dotbabel's QA surface at `db08ece` (2026-09-10). Every claim cites the file and line read on that date. Indexed as DOC-2.

## System Overview

dotbabel ships QA through three layers: skills and commands that instruct an agent, the `dotbabel quality` runner that executes project tools, and gates in code that hold a pull request. The same payload reaches consumer repositories through `dotbabel init`, which copies `plugins/dotbabel/templates/` into `.claude/`, `docs/`, and `.github/workflows/` (`plugins/dotbabel/src/init-harness-scaffold.mjs:7-11`).

### Spec stage

| Capability                                                                                                                                  | Evidence                                           |
| ------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| `acceptance_commands` is a required, non-empty array of strings. The validator checks shape only.                                           | `plugins/dotbabel/src/validate-specs.mjs:198-220`  |
| `validate-spec` Phase 4 is the only place that runs `acceptance_commands`, with stash proof for pre-existing failures. `--no-run` skips it. | `skills/validate-spec/SKILL.md:139-164`, `:144`    |
| `validate-spec` Phase 3 finds test evidence for a constraint by searching for its id or behavior, which is inference.                       | `skills/validate-spec/SKILL.md:117-125`            |
| The spec skill requires TDD test names in every §6.3 prompt and a per-unit test-kind table in §6.4, mutation included.                      | `skills/spec/SKILL.md:285`, `:296`, `:307`, `:472` |
| No acceptance-criteria field exists anywhere in the repository.                                                                             | Repository-wide search at `db08ece`                |

### PR stage

| Capability                                                                                                                             | Evidence                                                                                 |
| -------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `pr-conductor` chains `pre-pr`, `open-pr`, `post-pr-review`, `review-pr`, and `local-attest`, then stops before merge.                 | `skills/pr-conductor/SKILL.md:44`, `:51-58`                                              |
| The phase order lives in code, and a bats test locks the skill table to it.                                                            | `plugins/dotbabel/src/pr-gates.mjs:43`, `skills/pr-conductor/SKILL.md:49`                |
| `pre-pr` runs the `pr` quality profile.                                                                                                | `commands/pre-pr.md:154`                                                                 |
| The `pr` profile has a hard `correctness.tests` rule and a 90% `coverage.changed_lines` budget. `mutation.changed_score` is deep-only. | `plugins/dotbabel/src/quality/policy.mjs:32`, `:38`, `:40`                               |
| Every project-owned command needs trust: an allowlisted path or `--allow-project-commands`.                                            | `plugins/dotbabel/src/quality/runner.mjs:118`                                            |
| `review-pr` step 11 runs every `## Test plan` item locally, ticks passing boxes, and posts SHA-pinned evidence.                        | `skills/review-pr/SKILL.md:210-260`                                                      |
| In conductor mode, `review-pr` defers the test plan with a marker. The merge gate returns `DEFERRED_TEST_PLAN` until a phase runs it.  | `skills/review-pr/SKILL.md:214-224`, `plugins/dotbabel/src/pr-gates.mjs:112`, `:263-265` |
| The merge gate requires a `## Test plan` heading.                                                                                      | `plugins/dotbabel/src/pr-gates.mjs:261`                                                  |
| `quality-review` tells the reviewer to reject coverage padding and implementation-mirroring tests. No mechanism enforces it.           | `skills/quality-review/SKILL.md:38-39`                                                   |
| The `test-engineer` agent detects the runner and runs the full suite after it writes tests.                                            | `agents/test-engineer.md:43`, `:54-61`                                                   |

### Test plans per language

| Language          | Test plan source                                                                                                                                                                                                                                | Evidence                                                                                        |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Go                | Built-in `go test ./...` for the `pr` and `deep` profiles                                                                                                                                                                                       | `plugins/dotbabel/src/quality/adapters/go.mjs:35`                                               |
| Node, TypeScript  | A `quality:test` script or the conventional `test` script only. Ambiguity yields `not_configured`                                                                                                                                               | `plugins/dotbabel/src/quality/adapters/node-tools.mjs:6-11`, `:36-45`                           |
| Python            | No built-in test plan. Lint, format, and types come from `pyproject.toml`. Tests need a Make target                                                                                                                                             | `plugins/dotbabel/src/quality/adapters/python.mjs:18-24`, `:50`                                 |
| Any, through Make | `test`, `coverage`, and `test-race` targets                                                                                                                                                                                                     | `plugins/dotbabel/src/quality/adapters/make-tools.mjs:6-13`                                     |
| Mutation          | No built-in runner and no config detection in any adapter. A repository declares a `mutation` tool, and dotbabel reads a score only from a `stryker-json` or `dotbabel-v1` report. The Stryker parser does not filter the score to changed code | `docs/quality.md:199`, `:218-219`, `plugins/dotbabel/src/quality/reports.mjs:61-66`, `:114-117` |

### Post-merge

| Capability                                                                                                                                                 | Evidence                                               |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| `release-conductor verify` checks the release workflow conclusion, the npm version, and the GitHub release. It does not exercise the deployed application. | `skills/release-conductor/SKILL.md:225-249`            |
| `deploy-status` compares deployed SHAs with `origin/main` and exits 0, 1, or 2.                                                                            | `skills/deploy-status/SKILL.md:53-56`                  |
| SLOs appear once, as a checklist line in a GCP reference.                                                                                                  | `skills/gcp-specialist/references/observability.md:54` |

### Hooks and CI

| Capability                                                                                                                                              | Evidence                                                      |
| ------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| `dotbabel init` installs one hook: the destructive-git guard.                                                                                           | `plugins/dotbabel/templates/claude/hooks/`                    |
| `check-on-write` and `check-on-stop` ship with the plugin but need manual registration in user settings.                                                | `docs/hooks.md:133-160`                                       |
| `check-on-stop` compiles and skips tests by design.                                                                                                     | `plugins/dotbabel/hooks/check-on-stop.sh:324`                 |
| The pre-commit template only regenerates the skills manifest. No pre-push template exists.                                                              | `plugins/dotbabel/templates/githooks/pre-commit:1-9`          |
| Consumer workflow templates are `ai-review.yml`, `detect-drift.yml`, and `validate-skills.yml`. `test.yml` and `quality.yml` gate this repository only. | `plugins/dotbabel/templates/workflows/`, `.github/workflows/` |
| `ai-review.yml` runs `/review-prs` headless on every same-repository pull request.                                                                      | `plugins/dotbabel/templates/workflows/ai-review.yml:12-28`    |
| The rule floor with the TDD and stash-proof rules does not reach npm consumers.                                                                         | `CLAUDE.md:17`                                                |

## Pain Points

Ranked by the 2026-09-10 assessment.

1. **No behavioral oracle.** Specs carry commands but not criteria, so no gate can ask whether a criterion has a passing test.
2. **The PR gate trusts the author's test plan.** It proves that the listed items ran, not that they cover the spec.
3. **Test quality is unmeasured.** Mirror tests and assertion-free tests pass every gate. A mutation score needs a tool that the consumer declares, and only a `stryker-json` or `dotbabel-v1` report produces one.
4. **Dead configuration.** No code reads `verification_commands` (`plugins/dotbabel/templates/docs/repo-facts.json:16`). No code reads `regression_paths` (`docs/repo-facts.json:38`) either. Only the prose in `commands/merge-pr.md:59-67` does. The quality configuration parses `critical_paths` (`plugins/dotbabel/src/quality/config.mjs:191`), but no code uses the value.
5. **No behavioral post-deploy check** and no SLO tooling.
6. **Consumers get no CI test job, no deep-audit schedule, and no test-running hook.**

## Preserved Behaviors

Existing contracts that consumers or this repository depend on today. §2 confirms whether each one must stay unchanged.

- The `spec.json` fields and the `acceptance_commands` requirement (`plugins/dotbabel/src/validate-specs.mjs:75-79`).
- The `pr-conductor` phase order printed by `dotbabel pr-stack phases` and locked by the bats contract test (`skills/pr-conductor/SKILL.md:49`).
- The merge-gate reason codes, including `MISSING_TEST_PLAN` and `DEFERRED_TEST_PLAN` (`plugins/dotbabel/src/pr-gates.mjs:261-265`).
- The principle that `dotbabel quality` never installs a checker (`docs/quality.md:5`, `CLAUDE.md:149`).
- The trust gate on project-owned commands (`plugins/dotbabel/src/quality/runner.mjs:118`).
- The rule that `pr-conductor` never merges (`skills/pr-conductor/SKILL.md:58`).
