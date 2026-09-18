# Language-aware code quality

_Last updated: v3.4.0_

`dotbabel quality` applies one quality policy across mixed-language repositories. It discovers existing project tools and never installs a checker.

Flags and the JSON envelope are in [cli-reference.md](./cli-reference.md#dotbabel-quality).
A ready-to-copy configuration is at [../examples/quality/dotbabel.json](../examples/quality/dotbabel.json),
and a ready-to-copy workflow is at [../examples/quality/github-actions.yml](../examples/quality/github-actions.yml).

## Quick start

```bash
dotbabel quality explain
dotbabel quality detect
dotbabel quality check --profile fast
dotbabel quality check --profile pr --base origin/main
dotbabel quality check --all --path src/api    # one package, entirely
dotbabel quality baseline --profile pr --base origin/main
```

`detect` reads repository files but does not execute project commands. `explain` shows every resolved value and its shipped, user, or project provenance.

## Profiles and exits

| Profile | Use             | Default work                                                        |
| ------- | --------------- | ------------------------------------------------------------------- |
| `fast`  | Agent iteration | Changed format, syntax, types, lint, size, and available complexity |
| `pr`    | Pull requests   | `fast`, tests, coverage, security, duplication, and dead-code tools |
| `deep`  | Scheduled audit | `pr`, configured mutation, race, and repository analyzers           |

Exit `0` means no error verdict. Exit `1` means a checked policy rule failed.
Exit `2` means required trust, tooling, a report, or a Git base is unavailable. Exit `64` means invalid CLI use.

The JSON output is one `schema_version: 1` envelope. Validate it with [`../schemas/dotbabel.quality-result.schema.json`](../schemas/dotbabel.quality-result.schema.json). It is separate from the validator event-array format.

## Rule catalog

The policy uses hard, regression, budget, advisory, and semantic classes. A result keeps measurement state separate from its verdict.

These 26 rule ids are the values you use in `quality.rules` and in an exception's `rule` field.

| Rule id                                | Class      | Scope     | Profiles     | Level   | Threshold      | On unavailable |
| -------------------------------------- | ---------- | --------- | ------------ | ------- | -------------- | -------------- |
| `correctness.format`                   | hard       | changed   | fast pr deep | error   | —              | error          |
| `correctness.compile`                  | hard       | component | fast pr deep | error   | —              | error          |
| `correctness.types`                    | hard       | component | fast pr deep | error   | —              | error          |
| `correctness.tests`                    | hard       | component | pr deep      | error   | —              | error          |
| `correctness.regression`               | hard       | component | pr deep      | error   | —              | error          |
| `correctness.lint`                     | hard       | component | fast pr deep | error   | —              | error          |
| `security.high_confidence`             | hard       | component | pr deep      | error   | —              | warning        |
| `coverage.no_regression`               | regression | component | pr deep      | error   | —              | error          |
| `complexity.cognitive`                 | budget     | changed   | fast pr deep | error   | 15 count max   | warning        |
| `complexity.cyclomatic`                | budget     | changed   | fast pr deep | error   | 15 count max   | warning        |
| `coverage.changed_lines`               | budget     | changed   | pr deep      | error   | 90 percent min | error          |
| `coverage.changed_branches`            | budget     | changed   | pr deep      | error   | 90 percent min | info           |
| `mutation.changed_score`               | budget     | changed   | deep         | error   | 85 score min   | info           |
| `duplication.percent`                  | budget     | component | pr deep      | error   | 5 percent max  | warning        |
| `size.function_loc`                    | advisory   | changed   | fast pr deep | warning | 75 loc max     | info           |
| `size.file_loc`                        | advisory   | changed   | fast pr deep | warning | 500 loc max    | info           |
| `maintainability.dead_code`            | advisory   | changed   | pr deep      | warning | —              | info           |
| `maintainability.unused_dependencies`  | advisory   | changed   | pr deep      | warning | —              | info           |
| `semantic.ignored_errors`              | semantic   | changed   | fast pr deep | warning | —              | info           |
| `semantic.swallowed_errors`            | semantic   | changed   | fast pr deep | warning | —              | info           |
| `semantic.dynamic_types`               | semantic   | changed   | fast pr deep | warning | —              | info           |
| `semantic.unchecked_assertions`        | semantic   | changed   | fast pr deep | warning | —              | info           |
| `semantic.unbounded_concurrency`       | semantic   | changed   | fast pr deep | warning | —              | info           |
| `semantic.lifecycle`                   | semantic   | changed   | fast pr deep | warning | —              | info           |
| `architecture.speculative_abstraction` | semantic   | changed   | fast pr deep | warning | —              | info           |
| `policy.new_suppression`               | advisory   | changed   | fast pr deep | warning | —              | info           |

A rule override may set `enabled`, `level`, `threshold`, `scope`, `on_unavailable`, and `profiles`. A `threshold` may only be set on a rule that owns one.

Seven rules can never be suppressed by an exception, whatever the config source: `correctness.format`, `correctness.compile`, `correctness.types`, `correctness.tests`, `correctness.regression`, `correctness.lint`, and `security.high_confidence`.

The same ids are the enum in [`../schemas/dotbabel.config.schema.json`](../schemas/dotbabel.config.schema.json). Point an editor at it with `"$schema"` for autocompletion.

Limits are inclusive. A value of 15, 75, 500, 90, 85, or 5 passes its corresponding limit.
Run `dotbabel quality explain` for the authoritative executable values.

Go cover profiles contain statement counts for approximate basic blocks. Dotbabel never labels this evidence as branch coverage.
A coverage percentage does not prove test quality. Review behavior, failures, and boundaries.

## Measurement states

`checked` means a tool produced usable evidence. `unsupported` means no adapter can measure the rule.
`not_configured` means a compatible tool exists but the repository did not select one. `unavailable` means a selected tool or report failed.
`not_triggered` means no changed file matched a configured tool path. Its verdict is always `info`.
`not_applicable` means no relevant scope exists. `skipped` means the selected profile did not run the rule.

The report always shows these states. An unavailable measurement never becomes an implicit pass.

## Language support

| Language   | Discovery markers                                     | Built-in commands, no configuration required                                                                       | Repository sources scanned                                                              | Reads the change set |
| ---------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------- | -------------------- |
| Go         | `go.mod`                                              | `gofmt -l` on changed files, `go test -run ^$ ./...` for compile, `go vet ./...` for lint, `go test ./...` in `pr` | `Makefile` targets                                                                      | Yes                  |
| Python     | `pyproject.toml`, `setup.cfg`, `tox.ini`, else `.py`  | `pytest`, and `pytest --cov` for coverage, only for declared configuration                                         | `Makefile` targets, then `[tool.ruff]`, `[tool.black]`, `[tool.mypy]`, `[tool.pyright]` | No                   |
| TypeScript | `tsconfig*.json`                                      | `tsc --noEmit -p <tsconfig>` for typecheck, plus Vitest or Jest coverage for a declared runner                     | `package.json` scripts                                                                  | No                   |
| JavaScript | `package.json`, a `tsconfig` with sibling JS, else JS | `node --check` per changed file, plus Vitest or Jest coverage for a declared runner                                | `package.json` scripts                                                                  | Yes                  |
| any other  | —                                                     | none                                                                                                               | project `tools` only                                                                    | n/a                  |

Go lint uses `golangci-lint run` when a `.golangci.*` file exists, and `go vet` otherwise. A Python tool runs under `uv run` or `poetry run` when the matching lockfile exists.

### Built-in test and coverage plans

Dotbabel never installs a checker, so a built-in plan exists only where the repository already declares the tool. A plan for a tool nobody declared could only ever resolve as unavailable, which reads as a finding rather than as "nothing to measure here".

Python plans `pytest` when the component declares pytest configuration: `[tool.pytest.ini_options]` in `pyproject.toml`, a `pytest.ini` file, `[pytest]` in `tox.ini`, `[tool:pytest]` in `setup.cfg`, or a root `conftest.py`. It adds `pytest --cov --cov-report=json:<path>` for coverage only when `pytest-cov` is a declared dependency, because `--cov` is an unknown option without it. The report parses as `coveragepy-json`.

Node plans coverage only when no repository script already provides it. It runs `vitest run --coverage` with the JSON reporter when a Vitest coverage provider (`@vitest/coverage-v8` or `@vitest/coverage-istanbul`) is declared, and `jest --coverage` with the JSON reporter when Jest is declared. The provider is the trigger, not `vitest` itself: without a provider package Vitest cannot write a report, and in a workspace the runner is often hoisted to the root. Both parse as `istanbul-json`. The command runs through `pnpm exec`, `yarn exec`, or `npx --no-install`, matching the lockfile present.

Both built-in plans report `candidate`, not `available`. A manifest entry or a config section proves the tool is _declared_, not installed, so the plan can still resolve as unavailable on a checkout with no dependencies installed.

A repository script keeps priority over these, because it encodes reporter and threshold choices that inspecting a manifest cannot see. A Make target does **not** take priority for Node, only for Python and Go — Make targets are scanned by those two adapters alone, so a Node component with a `coverage` target and no script still gets the built-in plan.

Warning: a script that claims `coverage` carries no report declaration, so dotbabel runs it but parses nothing from it, and the coverage rules stay `not_configured`. Configure a project tool with an explicit `report` when you want the coverage rules measured:

```json
{
  "quality": {
    "components": [
      {
        "root": ".",
        "languages": ["javascript"],
        "tools": {
          "coverage": {
            "argv": ["npm", "run", "coverage"],
            "report": { "format": "lcov", "path": "coverage/lcov.info" }
          }
        }
      }
    ]
  }
}
```

TypeScript claims `.js` files only when `allowJs` or `checkJs` is set, or the file carries `// @ts-check`; otherwise those files belong to the JavaScript component. An unknown language name is valid, and it reports `unsupported` unless a project tool emits `exit-code` or `dotbabel-v1`.

Dotbabel prefers an explicit quality name over a conventional one:

| Source                 | Preferred names                                | Conventional fallback                                                         |
| ---------------------- | ---------------------------------------------- | ----------------------------------------------------------------------------- |
| `package.json` scripts | `quality:<capability>`, `quality-<capability>` | `format:check`, `typecheck` or `check:types`, `lint`, `test`, `coverage`      |
| `Makefile` targets     | `quality-<capability>`                         | `format-check`, `lint`, `test`, `coverage`, `security`, `test-race` or `race` |

Two candidates of equal authority produce `not_configured` with both names listed. Dotbabel never guesses. Pin one under `quality.components[].tools`.

## Scoping a run

A run is scoped by a Git range, by path, or by both.

`--base` selects the comparison base and the diff runs from its merge-base. Without `--head`, untracked files join the change set with every line counted as changed; with `--head`, they do not. `--all` reads no diff at all and scopes to the whole repository, so it also works on a shallow clone, a detached HEAD, and a repository with no default branch.

`--path <glob>` narrows a run to matching files, and repeats for more than one pattern. A glob-free value is a directory prefix, so `--path src/api` covers everything beneath it; a value containing `*` or `?` is matched as a glob. This is deliberately friendlier than the `exclude` key, which matches strictly. `--path` is a CLI flag only — a persisted path filter would silently narrow a gate forever, so there is no configuration equivalent. A policy `exclude` always wins; `--path` can narrow a run but never re-include an excluded file.

"Run it over one package" almost always means the whole package, so combine the two:

```bash
dotbabel quality check --all --path src/api        # the package, entirely
dotbabel quality check --base main --path src/api  # only my changes to the package
```

What a path filter narrows, and what it does not:

| Scope       | Rules                                                                                                                                                                                               | Narrowed by `--path` |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- |
| `changed`   | `correctness.format`, `complexity.*`, `coverage.changed_*`, `mutation.changed_score`, `size.*`, `maintainability.*`, `semantic.*`, `architecture.speculative_abstraction`, `policy.new_suppression` | Yes                  |
| `component` | `correctness.compile`, `correctness.types`, `correctness.tests`, `correctness.regression`, `correctness.lint`, `security.high_confidence`, `coverage.no_regression`, `duplication.percent`          | No                   |

A path filter also drops execution plans for a component with no file in scope, so an unrelated package is not checked at all. It does not rewrite a repository's own command: `npm test`, `go test ./...`, `tsc -p`, and `ruff check .` still cover their whole component. Only the Go and JavaScript adapters build per-file argument lists, so only those two narrow the command itself.

A scoped run is always labelled. The envelope carries `path_scope` and `all_files`, out-of-scope files are counted in `exclusions` as `outside path filter`, and the human report names the filter and says what was not checked. A narrow pass can never be mistaken for a whole-repository pass.

## Configuration

Add `quality` to `.dotbabel.json`. The nested object rejects unknown keys.

```json
{
  "quality": {
    "enabled": true,
    "default_profile": "fast",
    "base_ref": "origin/main",
    "baseline_file": ".dotbabel/quality-baseline.json",
    "exclude": ["examples/generated/**"],
    "critical_paths": ["internal/auth/**"],
    "rules": {
      "complexity.cognitive": {
        "threshold": 12,
        "level": "error",
        "on_unavailable": "warning"
      }
    },
    "components": [
      {
        "root": "api",
        "languages": ["go"],
        "tools": {
          "test": {
            "argv": ["make", "test"],
            "paths": ["api/**", "shared/contracts/**"],
            "timeout_seconds": 600,
            "report": { "format": "exit-code" }
          }
        }
      }
    ]
  }
}
```

Commands use an `argv` array. Shell strings, absolute configured executables, escaping paths, and environment passthrough in configuration are invalid.
An optional non-empty `paths` array uses repository-relative globs. The tool runs only after a matching change, or with `--all`.
The report records an unmatched tool as `not_triggered` and names its globs.

When a changed file matches `critical_paths`, all component test plans run in every profile. These plans ignore `--path` narrowing.
The JSON envelope lists the matched files in `critical_matches`.

The precedence is shipped defaults, `${XDG_CONFIG_HOME}/dotbabel/quality.json`, project configuration, then operational CLI flags.
The user file contains the quality object without an outer key. It cannot set components, exceptions, critical paths, base references, or baseline paths.
Rule maps merge by rule identifier. Exclusions concatenate and remove duplicates.

An explicit component overrides discovery at its normalized root. Dotbabel still discovers unclaimed roots.
Unknown language names are valid. They produce `unsupported` unless an explicit `exit-code` or `dotbabel-v1` tool supplies generic evidence.

Each key under `components[].tools` is a capability, and each capability feeds specific rules:

| `tools.<key>`  | Runs in      | Rules it feeds                                                                  |
| -------------- | ------------ | ------------------------------------------------------------------------------- |
| `format`       | fast pr deep | `correctness.format`                                                            |
| `compile`      | fast pr deep | `correctness.compile`                                                           |
| `typecheck`    | fast pr deep | `correctness.types`, and `correctness.compile` under the TypeScript adapter     |
| `lint`         | fast pr deep | `correctness.lint`                                                              |
| `complexity`   | fast pr deep | `complexity.cognitive`, `complexity.cyclomatic`                                 |
| `test`         | pr deep      | `correctness.compile`, `correctness.tests`                                      |
| `regression`   | pr deep      | `correctness.regression`                                                        |
| `coverage`     | pr deep      | `coverage.no_regression`, `coverage.changed_lines`, `coverage.changed_branches` |
| `dead-code`    | pr deep      | `maintainability.dead_code`                                                     |
| `dependencies` | pr deep      | `maintainability.unused_dependencies`                                           |
| `duplication`  | pr deep      | `duplication.percent`                                                           |
| `security`     | pr deep      | `security.high_confidence`                                                      |
| `mutation`     | deep         | `mutation.changed_score`                                                        |
| `race`         | deep         | `correctness.tests`                                                             |

Two plans with an identical `cwd` and `argv` are deduplicated into one execution that satisfies every capability claimed for it, so a single `make test` can serve both `test` and `race`.

Each tool declares how dotbabel reads its result:

| `report.format`   | `report.path` | What dotbabel extracts                                                                     |
| ----------------- | ------------- | ------------------------------------------------------------------------------------------ |
| `exit-code`       | not used      | Exit status only                                                                           |
| `go-coverprofile` | required      | Statement counts and blocks, for repository and changed statement coverage                 |
| `coveragepy-json` | required      | Line and branch totals, plus per-file executed and missing lines                           |
| `istanbul-json`   | required      | Statement and branch counts per file                                                       |
| `lcov`            | required      | `LF`, `LH`, `BRF`, `BRH` totals plus per-file `DA` and `BRDA` records                      |
| `sarif`           | required      | Findings; `security-severity` at or above 7, or level critical or high, is high confidence |
| `golangci-json`   | required      | Findings from `Issues[]`, mapped by `FromLinter`                                           |
| `eslint-json`     | required      | Findings from per-file `messages[]`, mapped by `ruleId`                                    |
| `ruff-json`       | required      | Findings mapped by `code`                                                                  |
| `jscpd-json`      | required      | `duplication.percent`                                                                      |
| `stryker-json`    | required      | Per-mutant status and original-source line, for `mutation.changed_score`                   |
| `gremlins-json`   | required      | Per-mutant status and original-source line, for `mutation.changed_score`                   |
| `mutmut-json`     | required      | Aggregate mutant counts; reports `mutation.changed_score` as `not_applicable`              |
| `dotbabel-v1`     | required      | `metrics[]` and `findings[]` as given                                                      |

A report must be a regular file inside the repository, or the measurement becomes `unavailable`. A coverage command that exits non-zero also makes the three coverage rules `unavailable` rather than failing them.

An analyzer rule name maps onto a dotbabel rule, which is worth knowing when you name a custom lint rule:

| Tool rule name                                                | Mapped rule                     |
| ------------------------------------------------------------- | ------------------------------- |
| `gocognit`                                                    | `complexity.cognitive`          |
| `gocyclo`, `cyclop`                                           | `complexity.cyclomatic`         |
| `errcheck`                                                    | `semantic.ignored_errors`       |
| `unused`                                                      | `maintainability.dead_code`     |
| contains `no-explicit-any`, or `ANN401`                       | `semantic.dynamic_types`        |
| contains `no-unsafe-`, `type-assertion`, or `non-null-assert` | `semantic.unchecked_assertions` |
| `E722`, `BLE001`                                              | `semantic.swallowed_errors`     |
| anything else                                                 | `correctness.lint`              |

## Tool selection and trust

Project tool mappings have the highest authority. Adapters then inspect repository scripts, targets, configured ecosystem tools, and safe language built-ins.
Equal candidates produce `not_configured`; dotbabel does not guess. CI workflow text is a suggestion only and never executes automatically.

Repository Make targets match by name, so a component with neither a manifest nor an explicit declaration claims only the `quality-<capability>` namespace.
Conventional names such as `lint` are ambient: in a polyglot repository they belong to whichever language wrote them. Declare the component, or name the target `quality-lint`, to bind one deliberately.

Project commands use argument arrays with `shell: false`, ignored input, bounded output, timeouts, and a restricted environment.
Use repeated `--pass-env <name>` for required extra variables. Reports must stay inside the repository and be regular files.

Local project execution requires the external exact-path trust allowlist used by `check-on-stop`.
CI can use `--allow-project-commands` for one invocation. This flag never persists.
Trust is not a sandbox. Repository code can access the user's permitted files and network.

## Baselines and legacy repositories

```bash
dotbabel quality baseline --profile pr --base origin/main
dotbabel quality baseline --profile pr --base origin/main --write
```

The first command prints a candidate. The second requires a clean tree and explicit project-command authorization.
The default path is `.dotbabel/quality-baseline.json`. Validate a hand-edited baseline against [`../schemas/dotbabel.quality-baseline.schema.json`](../schemas/dotbabel.quality-baseline.schema.json).

New functions must meet the budget. A changed legacy function above budget passes when it does not become worse.
An improvement passes and remains visible. An unchanged legacy issue does not fail a changed-code check.

The baseline never stores compiler, type, test, formatter, hard-lint, or Critical and High security failures.
Pull-request checks read the baseline from the merge-base revision when available. Coverage comparisons require compatible tools and configuration.

## Exceptions, suppressions, and exclusions

Each project exception needs a unique `QEX-<number>`, one rule, one exact fingerprint, a reason, and an ISO expiration date.
An active exception changes one matched error to a warning. Expired and unused exceptions remain visible.

Exceptions cannot cover hard correctness, high-security, trust, execution, or report failures.
Review changes to `.dotbabel.json`, the baseline, and exception records as policy changes. Protect these paths with CODEOWNERS.

Dotbabel identifies conventional dependency directories, Git-ignored files, and evidence-based generated files.
Each exclusion reports its reason and count. A directory name such as `templates` is not sufficient generated-code evidence.

## Continuous integration

Run the `pr` profile on pull requests and the `deep` profile on a schedule. A copy-paste workflow is at [../examples/quality/github-actions.yml](../examples/quality/github-actions.yml).

```yaml
- uses: actions/checkout@v6
  with:
    fetch-depth: 0 # required: a shallow clone cannot resolve a merge base
- run: npm ci # install project dependencies; dotbabel installs no analyzer
- run: |
    dotbabel quality check \
      --profile pr \
      --base "${{ github.event.pull_request.base.sha }}" \
      --allow-project-commands \
      --json > quality-report.json
```

Fail the job on exit `1` **and** exit `2`. Exit `2` means a tool, report, base, or trust was missing, which is not a pass. Upload `quality-report.json` as an artifact so a reviewer can read the states without re-running anything.

`--allow-project-commands` authorizes project-owned commands for that one run and never persists. Local runs use the exact-path trust allowlist instead.

### Mutation testing

`mutation.changed_score` counts only the mutants that **start on a line the
change touched**, as detected divided by valid, times 100. A mutant that never
compiled, or that the tool ignored or found non-viable, is excluded from the
denominator: it tested nothing, so counting it either way would move the score
for a reason the author did not cause. A timeout counts as detected — the
mutant changed behavior enough to hang the suite.

When no valid mutant starts on a changed line, the rule reports
`not_applicable`, not zero. A change with nothing to mutate has not failed a
mutation budget.

dotbabel plans a mutation tool only when the repository configures one, and
only in the `deep` profile:

| Tool     | Detected from                                                                                      | Planned as                                         |
| -------- | -------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| Stryker  | `stryker.conf.*`, `stryker.config.*` or `.stryker.conf.json`, or a `stryker` key in `package.json` | `./node_modules/.bin/stryker run --reporters json` |
| Gremlins | `.gremlins.yaml` / `.gremlins.yml` (or unprefixed)                                                 | `gremlins unleash --output=… .`                    |
| mutmut   | `[tool.mutmut]` in `pyproject.toml`, or `[mutmut]` in `setup.cfg`                                  | reported, not run — see below                      |

**Stryker must be installed, not just configured.** The plan runs the local
`node_modules/.bin/stryker`, and a repository that configures Stryker without
installing `@stryker-mutator/core` is reported as not configured, with the
install named as the remediation. This is deliberate: `npx` always starts
successfully, so an uninstalled package would exit non-zero and _fail_ the
mutation rule rather than reporting that there was nothing to measure.

That path is relative to the component root, so **a git worktree reports the
same not-configured verdict** even when the dependency is installed. A worktree
has no `node_modules` of its own; Node and npm resolve upward into the main
checkout instead. Declare the tool yourself to run mutation testing from a
worktree.

The report path comes from `jsonReporter.fileName` when the configuration is
one of the JSON forms (or the `stryker` key in `package.json`), and falls back
to Stryker's default `reports/mutation/mutation.json`. A `.js` or `.mjs`
config cannot be read without executing it, so those keep the default — set a
project `mutation` tool explicitly if yours writes somewhere else.

#### Declaring the tool yourself

This repository hits both cases: it configures Stryker in `stryker.config.mjs`,
and its spec work happens in worktrees. It therefore declares the tool rather
than relying on detection:

```json
"mutation": {
  "argv": ["npm", "run", "mutation"],
  "timeout_seconds": 3600,
  "report": { "format": "stryker-json", "path": "reports/mutation/mutation.json" }
}
```

Going through `npm run` is what makes this work from a worktree: npm puts every
ancestor `node_modules/.bin` on `PATH`, so `stryker` resolves to the main
checkout's installation.

**Do not give the declared tool a break threshold.** A mutation tool's own
threshold and a parsed report are mutually exclusive. dotbabel parses a report
only when the tool exits `0` — `coverage` is the single capability it rescues
from a non-zero exit — so a tool that exits non-zero on a low score produces no
metric at all, and the verdict message becomes the tool's stdout instead of a
number. It also mis-attributes the result: `mutation.changed_score` is a
changed-scope rule, while a tool threshold judges everything it mutated, so a
change touching none of those files still fails on pre-existing code.

Let the tool report and let the policy judge. This repository keeps the two
roles in two config files: `stryker.config.mjs` carries `break: 85` for the
direct per-unit runs IMPL-6 prescribes, and `stryker.harness.config.mjs`
inherits it with the threshold removed for the declared tool.

Two values must now agree in two files — `jsonReporter.fileName` in
`stryker.config.mjs` and `report.path` here. Warning: a divergence is silent. No
report at the declared path resolves through `on_unavailable: info`, which reads
as a pass rather than as a missing measurement. Pin them together with a test;
`plugins/dotbabel/tests/dogfood-mutation-tool.test.mjs` does that here, and also
asserts that the config enables the `json` reporter at all.

`mutation.changed_score` scores only changed lines, so a diff-scoped run of a
change that touches no mutated module correctly reports `not_applicable`. To
measure a module's whole mutation score, scope the run by path and pass
`--all`:

```bash
dotbabel quality check --profile deep --all --path 'plugins/dotbabel/src/criteria/**'
```

**mutmut reports aggregate counts only.** `mutmut export-cicd-stats` writes
totals with no per-mutant records, and the `.spans` sidecar indexes the
generated mutant module rather than the original source, so no mutant can be
attributed to a line the change touched. That is architectural, not a missing
flag. dotbabel therefore reports `mutation.changed_score` as `not_applicable`
for mutmut and carries the whole-suite score as evidence. It also does not plan
mutmut itself: the tool needs `mutmut run` and then `mutmut export-cicd-stats`,
neither of which accepts an output path, and a plan is one command with no
shell. Declare it as a project `mutation` tool whose command produces
`mutmut-stats.json` if you want it executed.

Keep mutation and race work out of the pull-request profile; run `--profile deep` on a schedule or on demand. `local-attest` may carry the quality command as a hard leg, and the two workflows stay independent.

## Agent workflow

An agent and a reviewer should follow the same order:

1. Run `dotbabel quality explain` before a policy-sensitive change. Add `--rule <id>` for one rule.
2. Run `dotbabel quality detect` to see components, selected tools, and trust. Resolve an ambiguous choice in `.dotbabel.json` rather than guessing.
3. Run `--profile fast` while editing, `--profile pr --base <ref>` before a pull request, and `--path`/`--all` to focus on one package.
4. Review the semantic rules by hand — no tool judges them.
5. Report unavailable and unsupported measurements honestly, and never install a missing tool to make a check pass.

The `quality-review` skill drives exactly this sequence.

## Generic reports

A repository wrapper can emit `dotbabel-v1` JSON. Validate it with [`../schemas/dotbabel.quality-report.schema.json`](../schemas/dotbabel.quality-report.schema.json).
The report contains `schema_version: 1`, a `metrics` array, and a `findings` array.
Each metric names a stable rule and numeric `actual` value. Each finding names a rule and message, with an optional stable fingerprint.
