# §6 — Implementation Plan

> Phases, workstreams, prompts, tests, migrations, rollback.

## 6.1 Phased Rollout

| Phase                         | Units                  | Needs first                                          | Runs in parallel |
| ----------------------------- | ---------------------- | ---------------------------------------------------- | ---------------- |
| 1. Foundations                | P-A1, P-B1, P-C1       | Nothing                                              | All three        |
| 2. Evidence and replacements  | P-B2, P-B3, P-A2, P-C5 | P-B1 for P-B2 and P-B3, P-A1 for P-A2, P-C1 for P-C5 | All four         |
| 3. Review step and adapters   | P-B4, P-C2, P-C3       | P-B2 and P-B3 for P-B4                               | All three        |
| 4. Depth and consumer surface | P-C4, P-D1, P-D2, P-D3 | P-B2 for P-D1, P-C1 for P-D2                         | All four         |
| 5. Post-deploy                | P-E1, then P-E2        | Nothing from earlier phases                          | No               |
| 6. Dogfood                    | P-F1                   | Every other unit                                     | No               |

The order follows leverage. Phases 1 through 3 close the spec-stage and pull-request gaps, which cost the most points in the assessment (DOC-2). Phase 5 depends on no earlier phase, so it can start sooner when people are free.

- **IMPL-1**: Each unit ships as one pull request with `## Spec ID` set to `qa-verification-harness` after the spec is `approved`, and the pull request goes through `/pr-conductor`.
- **IMPL-2**: A unit that changes a skill or a template runs prettier, then `node plugins/dotbabel/bin/dotbabel-validate-skills.mjs --update`, then `npm run build-plugin`, all in the same pull request.
- **IMPL-3**: A unit that changes `CLAUDE.md` regenerates the host instruction files with `npx dotbabel-generate-instructions` in the same pull request.
- **IMPL-4**: Every unit commits its failing tests before, or together with, the code that makes them pass.

## 6.2 Workstream Breakdown

| Workstream            | Units                        | Owns                                                          | Contract with other workstreams                   |
| --------------------- | ---------------------------- | ------------------------------------------------------------- | ------------------------------------------------- |
| WS-A Spec             | P-A1, P-A2                   | The criteria schema and criteria-first authoring              | §5 `acceptance_criteria`                          |
| WS-B Verification     | P-B1, P-B2, P-B3, P-B4       | The criteria command, evidence, merge gate, and review step   | §5 command, payload, comment, and reason codes    |
| WS-C Quality          | P-C1, P-C2, P-C3, P-C4, P-C5 | Path triggers, critical paths, adapters, parsers, key removal | §5 quality configuration, states, and formats     |
| WS-D Consumer surface | P-D1, P-D2, P-D3             | Workflow templates and hooks                                  | §5 hooks, and calls to the WS-B and WS-C commands |
| WS-E Post-deploy      | P-E1, P-E2                   | Smoke checks                                                  | §5 deploy targets and the `smoke` command         |
| WS-F Dogfood          | P-F1                         | This repository adopting the whole harness                    | Every section                                     |

## 6.3 Prompt Sequence

Each prompt lists the files to read, the planning command, the failing tests to write first, the files to change, and the checks that close the unit.

### P-A1 — Criteria shape in the spec validator

```text
<read-first>
docs/specs/qa-verification-harness/spec/5-interfaces-apis.md (§5 acceptance_criteria field rules)
plugins/dotbabel/src/validate-specs.mjs (L151-220: status and acceptance_commands checks to mirror)
plugins/dotbabel/src/lib/errors.mjs (L23-32: spec error codes)
plugins/dotbabel/tests/validate-specs.test.mjs (L100-160: fixture helpers and assertion style)
docs/specs/README.md (spec.json schema section)
</read-first>

Command: /plan

Add an optional acceptance_criteria check after the acceptance_commands block.
Emit SPEC_CRITERIA_INVALID with a JSON pointer for each violation.
Never read test files and never run commands (Q-5).

TDD first. Write these failing tests in plugins/dotbabel/tests/validate-specs.test.mjs:
- accepts a spec without acceptance_criteria
- accepts a well-formed criterion with a junit-xml report
- emits SPEC_CRITERIA_INVALID when a criterion lacks given, when, or then
- emits SPEC_CRITERIA_INVALID for a duplicate criterion id
- emits SPEC_CRITERIA_INVALID for an id that does not match AC-<number>
- emits SPEC_CRITERIA_INVALID when a test file path escapes the repository
- emits SPEC_CRITERIA_INVALID when argv is empty or holds an empty string

Files:
- modify plugins/dotbabel/src/validate-specs.mjs
- modify plugins/dotbabel/src/lib/errors.mjs (add SPEC_CRITERIA_INVALID)
- modify docs/specs/README.md and plugins/dotbabel/templates/docs/specs/README.md

<verify>
npx vitest run plugins/dotbabel/tests/validate-specs.test.mjs
node plugins/dotbabel/bin/dotbabel-validate-specs.mjs
</verify>
```

### P-B1 — Criteria core library

```text
<read-first>
docs/specs/qa-verification-harness/spec/4-data-flow-components.md (KD-1, KD-3, Flow 2)
plugins/dotbabel/src/quality/runner.mjs (L22-33 validateCommandPlan, L41-94 runOne, L97-118 trust)
plugins/dotbabel/src/lib/redact-output.mjs (redaction used on every output)
plugins/dotbabel/src/trust-allowlist.mjs (L216 isRepoTrusted)
plugins/dotbabel/src/spec-harness-lib.mjs (L297 matchesGlob, L333 extractTemplateSection)
plugins/dotbabel/src/quality/reports.mjs (parser style to follow)
</read-first>

Command: /plan

Build criteria loading, test-existence checks, execution through runQualityPlans,
JUnit and output confirmation, and the evidence payload. Parse JUnit XML with a
small parser that rejects a DOCTYPE and expands no entities (SEC-11).

TDD first. Write these failing tests in plugins/dotbabel/tests/criteria-verify.test.mjs:
- passes a criterion only when the command exits 0 and every named test is confirmed
- fails a criterion when the command exits non-zero
- marks a criterion unconfirmed when the command exits 0 but a named test is missing from the output
- confirms named tests from a JUnit XML report by exact or suffix name match
- fails a criterion when a JUnit testcase for a named test has a failure element
- marks a criterion unconfirmed when a JUnit testcase for a named test is skipped
- reports error when a named test file does not exist
- reports error when a test name does not appear in its file
- rejects a JUnit report that declares a DOCTYPE
- refuses to run a criterion command without project-command trust
- runs each criterion command exactly once even when it fails
- truncates each output tail to 40 lines and 2000 characters after redaction
- sets the payload verdict to pass only when every criterion passes
- matches JUnit names for any generated test name and separator
- verifies 50 criteria with at most 2 seconds of its own overhead

Files:
- create plugins/dotbabel/src/criteria/load.mjs
- create plugins/dotbabel/src/criteria/confirm.mjs
- create plugins/dotbabel/src/criteria/verify.mjs
- create plugins/dotbabel/src/criteria/index.mjs
- create plugins/dotbabel/tests/fixtures/criteria/ (JUnit samples from Vitest, pytest, go-junit-report, and bats-core, each with its tool version)
- modify .gitignore (add .dotbabel/)

<verify>
npx vitest run plugins/dotbabel/tests/criteria-verify.test.mjs
npx vitest run --coverage plugins/dotbabel/tests/criteria-verify.test.mjs
</verify>
```

### P-C1 — Path triggers, the regression capability, and critical paths

```text
<read-first>
plugins/dotbabel/src/quality/config.mjs (L14-22 keys, L57-75 validateTool, L90 critical_paths)
plugins/dotbabel/src/quality/discovery.mjs (L110-122 planQualityCheck and genericPlans)
plugins/dotbabel/src/quality/evaluate.mjs (L11-33 result states)
plugins/dotbabel/src/quality/policy.mjs (L28-60 rule catalog and forbidden exceptions)
plugins/dotbabel/src/quality/types.mjs (L27-41 capabilities)
docs/quality.md (L184-221 tools and reports)
</read-first>

Command: /plan

Accept tools.<capability>.paths, add the regression capability and the
correctness.regression rule, record not_triggered, and escalate test plans
when a changed file matches critical_paths (KD-5, KD-6).

TDD first. Write these failing tests:
- quality-config.test.mjs: accepts tool paths as a non-empty array of repository-relative globs
- quality-config.test.mjs: rejects tool paths that escape the repository
- quality-discovery.test.mjs: keeps a path-triggered tool only when a changed file matches its paths
- quality-discovery.test.mjs: keeps every path-triggered tool when --all is set
- quality-discovery.test.mjs: adds every component test plan to the fast profile when a changed file matches critical_paths
- quality-discovery.test.mjs: ignores --path narrowing for test plans when a critical path changed
- quality-discovery.test.mjs: matches the same files as matchesGlob for generated globs and paths
- quality-discovery.test.mjs: matches 10000 changed files against 50 globs in under 500 milliseconds
- quality-evaluate.test.mjs: reports not_triggered with an info verdict for an unmatched path-triggered tool
- quality-policy.test.mjs: declares correctness.regression as a hard pr and deep rule that cannot be excepted or baselined
- quality-index.test.mjs: lists critical_matches in the check envelope

Files:
- modify plugins/dotbabel/src/quality/config.mjs, types.mjs, policy.mjs, baseline.mjs, adapters/shared.mjs
- modify plugins/dotbabel/src/quality/discovery.mjs, evaluate.mjs, index.mjs
- modify schemas/dotbabel.quality-report.schema.json
- modify docs/quality.md

<verify>
npx vitest run plugins/dotbabel/tests/quality-config.test.mjs plugins/dotbabel/tests/quality-discovery.test.mjs plugins/dotbabel/tests/quality-evaluate.test.mjs plugins/dotbabel/tests/quality-policy.test.mjs plugins/dotbabel/tests/quality-index.test.mjs
node plugins/dotbabel/bin/dotbabel-quality.mjs explain --rule correctness.regression
</verify>
```

### P-B2 — The `dotbabel criteria` command

```text
<read-first>
docs/specs/qa-verification-harness/spec/5-interfaces-apis.md (§5 dotbabel criteria command and evidence payload)
plugins/dotbabel/bin/dotbabel-quality.mjs (flag parsing, exit codes, JSON envelope)
plugins/dotbabel/bin/dotbabel.mjs (L25-48 SUBCOMMANDS)
plugins/dotbabel/src/lib/exit-codes.mjs (EXIT_CODES)
package.json (bin map and files)
plugins/dotbabel/src/index.mjs (barrel exports)
</read-first>

Command: /plan

Wrap the P-B1 library in list and verify subcommands with the §5 flags,
exit codes, and JSON output. Add the evidence schema.

TDD first. Write these failing tests in plugins/dotbabel/tests/criteria-cli.test.mjs:
- exits 0 with a notice when no linked spec declares criteria
- exits 1 when any criterion fails
- exits 2 when the repository is untrusted and --allow-project-commands is absent
- exits 2 when local HEAD differs from the pull request head
- exits 64 when --post is used without --pr
- prints a payload that validates against the criteria evidence schema
- never posts evidence for a --criterion subset run
- lists the criteria of a spec as JSON

Files:
- create plugins/dotbabel/bin/dotbabel-criteria.mjs
- create schemas/dotbabel.criteria-evidence.schema.json
- modify plugins/dotbabel/bin/dotbabel.mjs, package.json, plugins/dotbabel/src/index.mjs

<verify>
npx vitest run plugins/dotbabel/tests/criteria-cli.test.mjs
node plugins/dotbabel/bin/dotbabel-criteria.mjs --help
node plugins/dotbabel/bin/dotbabel.mjs criteria list --spec qa-verification-harness --json
</verify>
```

### P-B3 — Evidence comment and merge gate

```text
<read-first>
docs/specs/qa-verification-harness/spec/5-interfaces-apis.md (§5 evidence comment, merge gate, criteria configuration)
plugins/dotbabel/src/local-attest-lib.mjs (L47-110 marker helpers to share)
plugins/dotbabel/src/pr-gates.mjs (L239-297 checkMergeGate)
plugins/dotbabel/bin/dotbabel-pr-stack.mjs (L380-430 gate data fetch)
plugins/dotbabel/src/project-sync.mjs (L104 loadProjectConfig)
schemas/dotbabel.config.schema.json
</read-first>

Command: /ultraplan

Move the SHA-pinned marker helpers into a shared module without changing the
local-attest marker text. Build and parse the criteria marker and payload, add
--post to the criteria command, add the criteria inputs and reason codes to
checkMergeGate, fetch comments in pr-stack, and validate the criteria key.

TDD first. Write these failing tests:
- criteria-evidence.test.mjs: round-trips an evidence payload through the marker comment
- criteria-evidence.test.mjs: rejects a marker whose SHA is not 40 hexadecimal characters
- criteria-evidence.test.mjs: keeps the rendered comment at or under 60000 characters by shrinking output tails first
- criteria-evidence.test.mjs: finds the newest marker comment from a trusted author
- criteria-evidence.test.mjs: round-trips any generated payload and SHA through build and parse
- criteria-evidence.test.mjs: edits the existing evidence comment instead of creating a second one
- pr-gates.test.mjs: fails with CRITERIA_EVIDENCE_MISSING when the spec declares criteria and no evidence exists
- pr-gates.test.mjs: fails with CRITERIA_EVIDENCE_UNTRUSTED when only an untrusted author posted the marker
- pr-gates.test.mjs: fails with CRITERIA_EVIDENCE_STALE when evidence is pinned to an older commit
- pr-gates.test.mjs: fails closed with CRITERIA_EVIDENCE_INVALID when the payload does not decode
- pr-gates.test.mjs: fails with CRITERIA_FAILED when the payload verdict is fail
- pr-gates.test.mjs: moves criteria reasons to warnings when enforcement is warn
- pr-gates.test.mjs: ignores comments when criteriaRequired is false
- pr-stack-criteria.test.mjs: gates a pull request with 300 stubbed comments within 10 seconds
Keep green: local-attest-lib.test.mjs and pr-gates.test.mjs "declares the six pipeline phases in order".

Files:
- create plugins/dotbabel/src/lib/pr-markers.mjs
- create plugins/dotbabel/src/criteria/evidence.mjs
- modify plugins/dotbabel/src/local-attest-lib.mjs (re-export from pr-markers.mjs)
- modify plugins/dotbabel/src/pr-gates.mjs, plugins/dotbabel/bin/dotbabel-pr-stack.mjs, plugins/dotbabel/bin/dotbabel-criteria.mjs
- modify plugins/dotbabel/src/project-sync.mjs and schemas/dotbabel.config.schema.json

<verify>
npx vitest run plugins/dotbabel/tests/criteria-evidence.test.mjs plugins/dotbabel/tests/pr-gates.test.mjs plugins/dotbabel/tests/local-attest-lib.test.mjs plugins/dotbabel/tests/pr-stack-criteria.test.mjs
bash plugins/dotbabel/scripts/run-bats.sh plugins/dotbabel/tests/bats/pr-conductor.bats
</verify>
```

### P-A2 — Criteria-first authoring skills

```text
<read-first>
skills/spec/SKILL.md (Phase 1 scaffold, L285-318 §6.3 and §6.4 scaffolds, L472 TDD principle)
skills/spec/references/cc-prompt-templates.md (L44-60 implementation prompt)
skills/validate-spec/SKILL.md (Phase 1 structure checks, L139-164 Phase 4)
docs/specs/cli-bootstrap-command/spec/6-implementation-plan.md (L51-57 test-name convention)
docs/specs/qa-verification-harness/spec/5-interfaces-apis.md (§5 acceptance_criteria)
</read-first>

Command: /plan

Make the spec skill scaffold spec.json, which it omits today although
dotbabel-validate-specs requires one (validate-specs.mjs:99-108), and include an
acceptance_criteria example. Pair each TDD test name in the prompt template
with a criterion id. Teach validate-spec to report a spec without criteria as
INFO and to run dotbabel criteria verify in Phase 4.

TDD first. Write these failing tests in plugins/dotbabel/tests/bats/spec-skill-criteria.bats:
- spec skill: the scaffold creates spec.json with an acceptance_criteria example
- spec skill: the implementation prompt template pairs each TDD test name with a criterion id
- validate-spec skill: Phase 1 reports a spec without acceptance_criteria as INFO
- validate-spec skill: Phase 4 runs dotbabel criteria verify for a spec with criteria

Files:
- modify skills/spec/SKILL.md, skills/spec/references/cc-prompt-templates.md, skills/validate-spec/SKILL.md
- regenerate the plugin templates and the skills manifest (IMPL-2)

<verify>
bash plugins/dotbabel/scripts/run-bats.sh plugins/dotbabel/tests/bats/spec-skill-criteria.bats
node plugins/dotbabel/bin/dotbabel-validate-skills.mjs
npm run build-plugin -- --check
</verify>
```

### P-C5 — Remove `regression_paths` and `verification_commands`

```text
<read-first>
docs/specs/qa-verification-harness/spec/4-data-flow-components.md (KD-6, KD-9)
CLAUDE.md (L50 rule-floor line)
commands/merge-pr.md (L59-67 data-regression step)
docs/repo-facts.json (L38) and plugins/dotbabel/templates/docs/repo-facts.json (L16-17)
plugins/dotbabel/bin/dotbabel-doctor.mjs (existing checks and output style)
</read-first>

Command: /plan

Delete both keys everywhere, rewrite the rule-floor line to name critical_paths,
replace merge-pr step 5 with the quality verdict in all three copies, and add
the doctor warning.

TDD first. Write these failing tests in plugins/dotbabel/tests/repo-facts-keys.test.mjs:
- no template, doc, or rule-floor file mentions regression_paths or verification_commands
- doctor warns when repo-facts gives regression_paths a non-empty value
- doctor warns when repo-facts gives verification_commands a non-empty value
- doctor stays silent when both keys are absent or empty

Files:
- modify CLAUDE.md, then regenerate AGENTS.md, GEMINI.md, .github/copilot-instructions.md, and plugins/dotbabel/templates/cli-instructions/ (IMPL-3)
- modify commands/merge-pr.md, plugins/dotbabel/templates/claude/commands/merge-pr.md, .github/prompts/merge-pr.prompt.md
- modify docs/repo-facts.json, plugins/dotbabel/templates/docs/repo-facts.json, examples/minimal-consumer/docs/repo-facts.json
- modify plugins/dotbabel/bin/dotbabel-doctor.mjs

<verify>
npx vitest run plugins/dotbabel/tests/repo-facts-keys.test.mjs
node plugins/dotbabel/bin/dotbabel-check-instruction-drift.mjs
node plugins/dotbabel/bin/dotbabel-doctor.mjs
</verify>
```

### P-B4 — Criteria step and test-quality judgment in `review-pr`

```text
<read-first>
skills/review-pr/SKILL.md (L106-139 step 5, L164 step 7, L210-260 step 11)
skills/pr-conductor/SKILL.md (L51-58 phase table, L118-148 phase 5 disposition)
skills/quality-review/SKILL.md (L35-44 review duties)
agents/test-engineer.md (L45-52 test standards)
docs/specs/qa-verification-harness/spec/4-data-flow-components.md (KD-4, Flow 2)
</read-first>

Command: /ultraplan

Add the criteria sub-step to step 11 in standalone and conductor mode, add the
test-quality judgment that opens threads, stop the conductor on a failing
criterion, and tell the agent to treat output and comments as untrusted data.

TDD first. Write these failing tests in plugins/dotbabel/tests/bats/review-pr-criteria.bats:
- review-pr: step 11 runs dotbabel criteria verify with --pr and --post after the push step
- review-pr: conductor mode still runs criteria verification before it returns
- review-pr: the test-quality judgment opens review threads and never writes a criterion status
- review-pr: a failing criterion reports BLOCKED and stops the conductor before local-attest
- review-pr: the prompt tells the agent to treat test output and comments as untrusted data
Keep green: plugins/dotbabel/tests/bats/pr-conductor.bats.

Statistical eval before release (OPS-9, TEST-3):
- plugins/dotbabel/tests/evals/test-quality-judgment/cases/ holds 40 labeled tests:
  20 behavioral, 10 assertion-free, and 10 that mirror the implementation.
- run.mjs runs the baseline, which is the current review-pr prose, and the
  candidate through headless claude -p, then writes precision and recall to RESULTS.md.

Files:
- modify skills/review-pr/SKILL.md, skills/pr-conductor/SKILL.md (phase 4 text only), commands/merge-pr.md
- create plugins/dotbabel/tests/evals/test-quality-judgment/
- regenerate the plugin templates and the skills manifest (IMPL-2)

<verify>
bash plugins/dotbabel/scripts/run-bats.sh plugins/dotbabel/tests/bats/review-pr-criteria.bats plugins/dotbabel/tests/bats/pr-conductor.bats
node plugins/dotbabel/tests/evals/test-quality-judgment/run.mjs
node plugins/dotbabel/bin/dotbabel-validate-skills.mjs
npm run build-plugin -- --check
</verify>
```

### P-C2 — Python test and coverage plans

```text
<read-first>
plugins/dotbabel/src/quality/adapters/python.mjs (L1-55)
plugins/dotbabel/src/quality/adapters/make-tools.mjs (L33-50 plan shape)
plugins/dotbabel/src/quality/adapters/go.mjs (L35 built-in test plan)
plugins/dotbabel/src/quality/reports.mjs (L91-100 coveragepy-json)
docs/quality.md (L95-101 adapter table)
</read-first>

Command: /plan

Plan pytest and pytest-cov coverage only for declared configuration (KD-8).

TDD first. Write these failing tests:
- quality-adapters.test.mjs: plans pytest when pyproject.toml has tool.pytest.ini_options
- quality-adapters.test.mjs: plans pytest when pytest.ini or a root conftest.py exists
- quality-adapters.test.mjs: runs pytest under uv run when uv.lock exists and under poetry run when poetry.lock exists
- quality-adapters.test.mjs: plans coveragepy-json coverage only when pytest-cov is a declared dependency
- quality-adapters.test.mjs: prefers a quality-test Make target over the built-in pytest plan
- quality-adapters.test.mjs: never plans pytest when the repository declares no pytest configuration
- quality-reports.test.mjs: parses a captured pytest-cov JSON report

Files:
- modify plugins/dotbabel/src/quality/adapters/python.mjs
- create plugins/dotbabel/tests/fixtures/quality/pytest-cov/ (captured report with the tool version)
- modify docs/quality.md

<verify>
npx vitest run plugins/dotbabel/tests/quality-adapters.test.mjs plugins/dotbabel/tests/quality-reports.test.mjs
</verify>
```

### P-C3 — Node coverage without a repository script

```text
<read-first>
plugins/dotbabel/src/quality/adapters/node-tools.mjs (L6-50)
plugins/dotbabel/src/quality/adapters/javascript.mjs
plugins/dotbabel/src/quality/adapters/typescript.mjs
plugins/dotbabel/src/quality/reports.mjs (L101-109 istanbul-json)
vitest.config.mjs (coverage provider example)
</read-first>

Command: /plan

Plan Vitest or Jest coverage when the provider is declared and no script exists (KD-8).

TDD first. Write these failing tests:
- quality-adapters.test.mjs: plans Vitest coverage with the JSON reporter when a Vitest coverage provider is a declared dev dependency
- quality-adapters.test.mjs: plans Jest coverage with the JSON reporter when Jest is a declared dev dependency
- quality-adapters.test.mjs: keeps a quality:coverage or coverage script ahead of the built-in coverage plan
- quality-adapters.test.mjs: plans no coverage when no coverage provider is declared
- quality-adapters.test.mjs: uses pnpm exec or yarn when the matching lockfile exists
- quality-reports.test.mjs: parses captured Vitest and Jest coverage-final.json reports

Files:
- modify plugins/dotbabel/src/quality/adapters/node-tools.mjs
- create plugins/dotbabel/tests/fixtures/quality/istanbul/ (captured reports with tool versions)
- modify docs/quality.md

<verify>
npx vitest run plugins/dotbabel/tests/quality-adapters.test.mjs plugins/dotbabel/tests/quality-reports.test.mjs
</verify>
```

### P-C4 — Mutation tool detection and changed-code scoring

```text
<read-first>
plugins/dotbabel/src/quality/reports.mjs (L114-118 stryker-json, L130-140 changed-path matching)
plugins/dotbabel/src/quality/adapters/shared.mjs (L3 deep capabilities, L21 mutation rule map)
plugins/dotbabel/src/quality/policy.mjs (L40 mutation.changed_score)
plugins/dotbabel/src/quality/index.mjs (L19-60 report parsing and changed coverage)
docs/quality.md (L199, L206-221)
</read-first>

Command: /ultraplan

Capture real reports from Stryker, mutmut, and Gremlins on a small sample
project, and confirm each configuration file name in the tool documentation.
Replace the stryker-json parser with per-mutant parsing, add the two new
formats, score only mutants that start on changed lines, and detect
configured tools for the deep profile (KD-7).

TDD first. Write these failing tests:
- quality-reports.test.mjs: parses a captured Stryker mutation-testing-elements report into per-mutant results
- quality-reports.test.mjs: scores only mutants on changed lines as detected divided by valid times 100
- quality-reports.test.mjs: excludes compile-error and ignored mutants from the valid count
- quality-reports.test.mjs: reports mutation.changed_score as not_applicable when no mutant starts on a changed line
- quality-reports.test.mjs: parses a captured mutmut report fixture
- quality-reports.test.mjs: parses a captured Gremlins report fixture
- quality-reports.test.mjs: keeps any generated mutant set's score between 0 and 100
- quality-reports.test.mjs: parses a report with 20000 mutants in under 2 seconds
- quality-adapters.test.mjs: detects a Stryker configuration file and plans the tool only in the deep profile
- quality-adapters.test.mjs: never plans a mutation tool without repository configuration

Files:
- modify plugins/dotbabel/src/quality/reports.mjs, types.mjs, index.mjs
- modify plugins/dotbabel/src/quality/adapters/javascript.mjs, typescript.mjs, python.mjs, go.mjs
- create plugins/dotbabel/tests/fixtures/quality/mutation/ (captured reports with tool versions)
- modify docs/quality.md

<verify>
npx vitest run plugins/dotbabel/tests/quality-reports.test.mjs plugins/dotbabel/tests/quality-adapters.test.mjs
</verify>
```

### P-D1 — Consumer CI templates

```text
<read-first>
.github/workflows/quality.yml (L1-63 pull request and deep jobs)
.github/workflows/test.yml (L12-40 attestation classify job)
plugins/dotbabel/templates/workflows/ai-review.yml (L1-28 pinned checkout)
plugins/dotbabel/src/init-harness-scaffold.mjs (L7-11 template prefix map)
docs/templates.md (template inventory)
</read-first>

Command: /plan

Create test.yml and quality.yml templates that meet KD-10 and SEC-7.

TDD first. Write these failing tests in plugins/dotbabel/tests/workflow-templates.test.mjs:
- pins every action in every workflow template to a full 40-character commit SHA
- declares top-level permissions with contents read in every workflow template
- never uses pull_request_target in a workflow template
- never references a secret in test.yml or quality.yml
- skips the verify job only when a trusted local-attest marker matches the head SHA
- scaffolds test.yml and quality.yml into .github/workflows with dotbabel init

Files:
- create plugins/dotbabel/templates/workflows/test.yml and quality.yml
- modify docs/templates.md and docs/quickstart.md

<verify>
npx vitest run plugins/dotbabel/tests/workflow-templates.test.mjs
npm run build-plugin -- --check
</verify>
```

### P-D2 — Pre-push hook template

```text
<read-first>
plugins/dotbabel/templates/githooks/pre-commit (L1-9)
plugins/dotbabel/hooks/check-on-stop.sh (L60-80 bypass and timeout conventions)
plugins/dotbabel/bin/dotbabel-quality.mjs (exit codes)
docs/hooks.md (L133-172 registering a hook, L189-220 tuning)
docs/templates.md (githooks section)
</read-first>

Command: /plan

Create githooks/pre-push with the KD-11 exit mapping, timeout, and bypass.

TDD first. Write these failing tests in plugins/dotbabel/tests/bats/pre-push-hook.bats:
- pre-push: blocks the push when the fast profile exits 1
- pre-push: allows the push with a notice when the fast profile exits 2
- pre-push: allows the push with a notice when the check exceeds DOTBABEL_PRE_PUSH_TIMEOUT
- pre-push: skips the check when BYPASS_PRE_PUSH is 1
- pre-push: allows the push with a notice when dotbabel is not installed

Files:
- create plugins/dotbabel/templates/githooks/pre-push
- modify docs/hooks.md and docs/templates.md

<verify>
bash plugins/dotbabel/scripts/run-bats.sh plugins/dotbabel/tests/bats/pre-push-hook.bats
npm run shellcheck
</verify>
```

### P-D3 — Related tests in `check-on-stop.sh`

```text
<read-first>
plugins/dotbabel/hooks/check-on-stop.sh (L39-80 trust and tuning, L300-330 per-language checks)
plugins/dotbabel/src/trust-allowlist.mjs (L148 grantCheckOnStopTrust, L216 isRepoTrusted)
skills/review-pr/SKILL.md (L132 runner scoping)
docs/hooks.md (L59-126 trust, L189-220 tuning)
</read-first>

Command: /plan

Add the opt-in tests stage from KD-12 inside the existing loop guards.

TDD first. Write these failing tests in plugins/dotbabel/tests/bats/check-on-stop-tests.bats:
- check-on-stop: skips related tests unless CHECK_ON_STOP_TESTS is 1
- check-on-stop: skips related tests in an untrusted repository
- check-on-stop: runs vitest related for changed JavaScript files in a trusted repository
- check-on-stop: blocks at most 2 times for the same failing test signature
- check-on-stop: stops the tests stage after CHECK_ON_STOP_TIMEOUT seconds

Files:
- modify plugins/dotbabel/hooks/check-on-stop.sh
- modify docs/hooks.md

<verify>
bash plugins/dotbabel/scripts/run-bats.sh plugins/dotbabel/tests/bats/check-on-stop-tests.bats
npm run shellcheck
</verify>
```

### P-E1 — Smoke checks in the deploy helper

```text
<read-first>
skills/deploy-status/scripts/deploy-ops.mjs (L31-60 parseArgs, L143-155 loadDeployConfig, L216-258 normalizeTarget, L954-990 main)
skills/deploy-status/examples/deploy-targets.example.json
plugins/dotbabel/tests/deploy-ops.test.mjs (test style and stubs)
skills/deploy-status/SKILL.md (L47-56 exit codes)
plugins/dotbabel/src/quality/runner.mjs (L10 environment allowlist to mirror, because the helper cannot import it)
</read-first>

Command: /plan

Add the self-contained smoke command from KD-13 with the SEC-8, PERF-6, and REL-8 guards.

TDD first. Write these failing tests in plugins/dotbabel/tests/deploy-ops.test.mjs:
- smoke: passes an http check that returns the expected status and body text
- smoke: retries an http GET check 3 times with 2, 4, and 8 second backoff
- smoke: runs a command check exactly once
- smoke: rejects a URL with embedded credentials
- smoke: rejects a non-https URL for any host except localhost
- smoke: never prints a header value read from the environment
- smoke: exits 0 with a notice when no target declares smoke checks
- smoke: exits 1 when any smoke check fails
- smoke: stops the whole run after 300 seconds
- smoke: computes the backoff schedule for any retry count from 0 through 10

Files:
- modify skills/deploy-status/scripts/deploy-ops.mjs
- modify skills/deploy-status/examples/deploy-targets.example.json

<verify>
npx vitest run plugins/dotbabel/tests/deploy-ops.test.mjs
node skills/deploy-status/scripts/deploy-ops.mjs smoke --dry-run
</verify>
```

### P-E2 — The `smoke-test` skill and release verification

```text
<read-first>
skills/deploy-status/SKILL.md (L30-60 helper resolution and exit codes)
skills/release-conductor/SKILL.md (L225-250 verify subcommand)
skills/rollback-prod/SKILL.md (confirmation contract)
skills/pr-conductor/SKILL.md (frontmatter of a side-effectful skill)
docs/specs/qa-verification-harness/spec/4-data-flow-components.md (KD-13, Flow 5)
</read-first>

Command: /plan

Create the smoke-test skill and extend release-conductor verify as in Flow 5.

TDD first. Write these failing tests in plugins/dotbabel/tests/bats/smoke-test-skill.bats:
- smoke-test: SKILL.md exists with matching id and name
- smoke-test: resolves the deploy-ops helper the same way deploy-status does
- smoke-test: recommends /rollback-prod on failure and never invokes it
- release-conductor: verify reports deploy status and smoke results when a deploy target exists
- release-conductor: verify reports SKIPPED for smoke when no deploy target exists

Files:
- create skills/smoke-test/SKILL.md
- modify skills/release-conductor/SKILL.md
- regenerate the plugin templates and the skills manifest (IMPL-2)

<verify>
bash plugins/dotbabel/scripts/run-bats.sh plugins/dotbabel/tests/bats/smoke-test-skill.bats
node plugins/dotbabel/bin/dotbabel-validate-skills.mjs
node plugins/dotbabel/bin/dotbabel-index.mjs --check
npm run build-plugin -- --check
</verify>
```

### P-F1 — Dogfood and documentation

```text
<read-first>
docs/specs/qa-verification-harness/spec.json (acceptance_criteria)
.local-attest.config.mjs (L7-23 matrix legs)
.github/workflows/quality.yml (deep job)
docs/quality.md
package.json (devDependencies)
</read-first>

Command: /plan

Make this repository use the whole harness. Add Stryker and its Vitest runner
as dev dependencies of this repository, scoped to plugins/dotbabel/src/criteria/,
pr-gates.mjs, quality/discovery.mjs, and quality/reports.mjs. Declare that
mutation tool in this repository's .dotbabel.json. Verify this spec's own
criteria, then move the spec to done after the validate-spec audit passes.

TDD first. These checks must fail before the work and pass after it:
- every acceptance criterion of qa-verification-harness passes through dotbabel criteria verify
- the deep quality profile reports a changed-code mutation score of at least 85 for the new modules
- /validate-spec qa-verification-harness reports 0 CRITICAL findings

Files:
- modify package.json, .dotbabel.json, docs/specs/qa-verification-harness/spec.json
- modify docs/quality.md, docs/hooks.md, docs/specs/README.md, docs/troubleshooting.md

<verify>
node plugins/dotbabel/bin/dotbabel-criteria.mjs verify --spec qa-verification-harness --allow-project-commands
node plugins/dotbabel/bin/dotbabel-quality.mjs check --profile deep --base origin/main --allow-project-commands
npm test
</verify>
```

## 6.4 Testing Strategy

| Unit | Kinds applied                                                                                                                                                                                                                                                                                                                                                                                                                                | N/A + reason                                                                                                                                                                                                                                                         |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P-A1 | unit for each shape rule; contract for `SPEC_CRITERIA_INVALID` and its pointers; golden/fixture: the 5 specs in this repository and the minimal-repo fixture validate unchanged                                                                                                                                                                                                                                                              | property: N/A, the rule set is finite and table-driven tests cover it. integration: N/A, no external dependency. mutation: covered by the P-F1 scope. statistical: N/A, deterministic. load/torture: N/A, spec files are tiny. post-deploy: N/A, no deployed surface |
| P-A2 | contract: bats tests on the skill prose; golden/fixture: the scaffolded `spec.json` example passes P-A1                                                                                                                                                                                                                                                                                                                                      | unit and property: N/A, prose only. integration: N/A, the owner reviews each spec session. mutation: N/A, no executable code. statistical: N/A, authoring stays human-reviewed. load/torture and post-deploy: N/A                                                    |
| P-B1 | unit; property: JUnit name matching over generated names and separators; golden/fixture: JUnit XML from Vitest, pytest, go-junit-report, and bats-core; integration: a real Vitest run in a trusted fixture project; mutation: changed-code score of at least 85 (TEST-1); load/torture: 50 criteria, a 1 MiB output, malformed XML, and a DOCTYPE                                                                                           | statistical: N/A, deterministic. post-deploy: N/A, local command                                                                                                                                                                                                     |
| P-B2 | unit for flag parsing; contract for exit codes 0, 1, 2, and 64 and for the evidence schema; integration: the bin end to end in a fixture repository                                                                                                                                                                                                                                                                                          | property: N/A, a thin layer over P-B1. mutation: covered by the P-F1 scope. statistical: N/A. load/torture: N/A, covered in P-B1. post-deploy: N/A                                                                                                                   |
| P-B3 | unit; contract for reason codes, the marker text, and the unchanged local-attest marker; property: payload round trip; integration: `pr-stack gate` with a stubbed `gh` and 300 comments; mutation: at least 85 (TEST-1); load/torture: 300 comments and a 60,000-character body                                                                                                                                                             | statistical: N/A, deterministic. post-deploy: N/A                                                                                                                                                                                                                    |
| P-B4 | contract: bats tests on step order, conductor behavior, and the unchanged phase table; statistical: the test-quality eval with 40 labeled tests (20 behavioral, 10 assertion-free, 10 mirroring), measuring precision and recall against the current `review-pr` prose as the baseline, shipping only at precision 0.80 or more and recall 0.70 or more (OPS-9); integration: a `/review-pr` dry run on a sandbox pull request in a worktree | unit, property, and mutation: N/A, prose only. load/torture: N/A. post-deploy: N/A                                                                                                                                                                                   |
| P-C1 | unit; property: glob parity with `matchesGlob`; contract: report schema state and `critical_matches`; integration: `dotbabel quality check` on a fixture repository with a path-triggered tool; mutation: at least 85 (TEST-1); load/torture: 10,000 changed files against 50 globs (PERF-7)                                                                                                                                                 | statistical: N/A, deterministic. post-deploy: N/A                                                                                                                                                                                                                    |
| P-C2 | unit; golden/fixture: captured `pytest-cov` JSON; integration: a pytest fixture project, which skips with a notice when Python is absent                                                                                                                                                                                                                                                                                                     | property: N/A, detection is a finite table. mutation: covered by the P-F1 scope. statistical: N/A. load/torture: N/A. post-deploy: N/A                                                                                                                               |
| P-C3 | unit; golden/fixture: captured Vitest and Jest `coverage-final.json`; integration: a Vitest fixture project                                                                                                                                                                                                                                                                                                                                  | property: N/A, detection is a finite table. mutation: covered by the P-F1 scope. statistical: N/A. load/torture: N/A. post-deploy: N/A                                                                                                                               |
| P-C4 | unit; golden/fixture: captured Stryker, mutmut, and Gremlins reports with tool versions (TEST-2); property: the score stays within 0 to 100 and equals detected ÷ valid; mutation: at least 85 on the parser itself (TEST-1); load/torture: 20,000 mutants                                                                                                                                                                                   | statistical: N/A, the score is arithmetic. integration: N/A, fixtures stand in for real tool runs and are recaptured when a tool version changes. post-deploy: N/A                                                                                                   |
| P-C5 | contract: no template, doc, or rule-floor file names the removed keys, and the instruction drift check passes; unit: the doctor warning                                                                                                                                                                                                                                                                                                      | property, integration, mutation, statistical, load/torture, and post-deploy: N/A, a removal plus one warning                                                                                                                                                         |
| P-D1 | contract: the workflow security checks; integration: `dotbabel init` writes both templates; post-deploy: the first run of `test.yml` in this repository during P-F1                                                                                                                                                                                                                                                                          | unit, property, and mutation: N/A, YAML only. statistical and load/torture: N/A                                                                                                                                                                                      |
| P-D2 | integration: bats with a stub `dotbabel` on `PATH` for each exit code; contract: the exit mapping in §5                                                                                                                                                                                                                                                                                                                                      | unit, property, and mutation: N/A, shell only. statistical, load/torture, and post-deploy: N/A                                                                                                                                                                       |
| P-D3 | integration: bats with stub runners; contract: the give-up count and the timeout                                                                                                                                                                                                                                                                                                                                                             | unit, property, and mutation: N/A, shell only. statistical, load/torture, and post-deploy: N/A                                                                                                                                                                       |
| P-E1 | unit; property: the backoff schedule for retry counts 0 through 10; contract: exit codes and JSON output; integration: a local HTTP server fixture; load/torture: 50 checks inside the 300-second budget with a fake clock                                                                                                                                                                                                                   | mutation: covered by the P-F1 scope. statistical: N/A, deterministic. post-deploy: N/A, dotbabel has no deployed target, and consumers run this check                                                                                                                |
| P-E2 | contract: bats tests on the skill prose; post-deploy: the next dotbabel release runs `release-conductor verify`, which reports smoke as `SKIPPED`                                                                                                                                                                                                                                                                                            | unit, property, and mutation: N/A, prose only. integration, statistical, and load/torture: N/A                                                                                                                                                                       |
| P-F1 | integration: `dotbabel criteria verify` on this spec; mutation: a Stryker `deep` run on the new modules; post-deploy: `release-conductor verify` after the release                                                                                                                                                                                                                                                                           | unit and property: N/A, covered by earlier units. statistical and load/torture: N/A                                                                                                                                                                                  |

- **TEST-1**: The new modules under `plugins/dotbabel/src/criteria/`, and the changed parts of `pr-gates.mjs`, `quality/discovery.mjs`, and `quality/reports.mjs`, reach a changed-code mutation score of 85 or more before P-F1 closes.
- **TEST-2**: Every golden fixture captured from a third-party tool records the tool name and version beside the fixture.
- **TEST-3**: The test-quality judgment ships only after the P-B4 eval meets OPS-9.
- **TEST-4**: No test in this spec sleeps. Timers use fake clocks (`agents/test-engineer.md:48`).

## 6.5 Migration Sequence

1. Release P-A1. `acceptance_criteria` becomes an accepted optional field, and no spec changes (REL-6).
2. Release P-B1, P-B2, and P-B3. The gate evaluates criteria only for a spec that declares them, so no existing pull request changes state (DOC-13).
3. Release P-C1. Tool `paths` and the `regression` capability are optional, and `critical_paths` stays empty by default (`plugins/dotbabel/src/quality/policy.mjs:74`), so no quality run changes.
4. Release P-C5. The removed keys had no code reader (DOC-14), and `dotbabel doctor` warns any repository that still sets them.
5. Release P-A2, P-B4, P-C2, P-C3, and P-C4. New plans appear only where a repository already declares the tool.
6. Release P-D1, P-D2, and P-D3. Templates reach new scaffolds only. An existing repository opts in by copying a template or by setting an environment variable.
7. Release P-E1 and P-E2. Smoke checks run only for targets that declare them.
8. Complete P-F1, then move this spec to `done`.

Each release is a semver minor version, because no step needs a consumer edit (OPS-7, DOC-21). A repository that relied on `regression_paths` declares a `regression` tool with `paths`, and optionally `critical_paths`. That consumer change is outside this spec.

## 6.6 Rollback Plan

| Scenario                                           | Action                                                                                              | Notes                                                                                           |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| The criteria gate blocks valid pull requests       | Set `criteria.enforcement` to `warn` in `.dotbabel.json`, fix the defect, then set it back          | The switch shows in the diff of a committed file (KD-14)                                        |
| The evidence parser misreads comments              | Use the same switch, then ship a patch release                                                      | Until then the gate fails closed (REL-3)                                                        |
| A path trigger skips a needed check                | Remove `paths` from that tool, so it runs on every change                                           | The `not_triggered` state shows which tool skipped (REL-9)                                      |
| `critical_paths` escalation slows pushes           | Narrow the globs or empty the list                                                                  | The list is empty by default                                                                    |
| A mutation parser gives wrong scores               | Remove the mutation tool from the configuration                                                     | The rule returns to `not_configured` with verdict `info`                                        |
| A new Python or Node plan picks the wrong command  | Declare the tool in `.dotbabel.json`, or add a `quality-test` Make target, which takes priority     | No release is needed                                                                            |
| A workflow template fails in a consumer repository | Delete or disable that workflow file                                                                | Templates are copies with no runtime link to dotbabel                                           |
| The pre-push hook blocks work                      | Set `BYPASS_PRE_PUSH=1`, use `git push --no-verify`, or run `git config --unset core.hooksPath`     | Activation was manual (KD-11)                                                                   |
| Related tests at turn end stall                    | Unset `CHECK_ON_STOP_TESTS`                                                                         | The give-up counter already stops after 2 blocks (`plugins/dotbabel/hooks/check-on-stop.sh:80`) |
| A smoke check reports a false failure              | Re-run `deploy-ops.mjs smoke`, then fix or remove the check                                         | Smoke never triggers a rollback (SEC-12)                                                        |
| A release regresses broadly                        | Run `npm dist-tag add @dotbabel/dotbabel@<previous> latest`, and consumers pin the previous version | Old and new versions coexist, because every feature reads optional configuration                |

Coexistence: an older dotbabel ignores the new optional keys, and a newer dotbabel without those keys behaves like the older one. A consumer can pin the previous version in `package.json` while a fix ships.
