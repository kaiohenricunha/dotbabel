# Language-aware code quality

_Last updated: v3.1.0_

`dotbabel quality` applies one quality policy across mixed-language repositories. It discovers existing project tools and never installs a checker.

## Quick start

```bash
dotbabel quality explain
dotbabel quality detect
dotbabel quality check --profile fast
dotbabel quality check --profile pr --base origin/main
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

The JSON output is one `schema_version: 1` envelope. It is separate from the validator event-array format.

## Rules and defaults

The policy uses hard, regression, budget, advisory, and semantic classes. A result keeps measurement state separate from its verdict.

| Rule                                                   | Default                                                  |
| ------------------------------------------------------ | -------------------------------------------------------- |
| Compile, configured types, tests, lint, and formatting | Hard gate in the applicable profile                      |
| Critical or High reliable security findings            | Hard gate                                                |
| Cognitive and cyclomatic complexity                    | Maximum 15 for new code; legacy code cannot become worse |
| Changed line or statement coverage                     | Minimum 90 percent                                       |
| Changed branch coverage                                | Minimum 90 percent only with real branch data            |
| Coverage regression                                    | No decrease against compatible integer counts            |
| Changed mutation score                                 | Minimum 85 percent in `deep`                             |
| Duplication                                            | Maximum 5 percent and no new changed-code clone          |
| Function size                                          | Warning above 75 logical lines                           |
| File size                                              | Warning above 500 logical lines                          |
| Dead code and unused dependencies                      | New reliable findings; repository totals stay advisory   |
| Suppressions and semantic risks                        | Agent review                                             |

Limits are inclusive. A value of 15, 75, 500, 90, 85, or 5 passes its corresponding limit.
Run `dotbabel quality explain` for the authoritative executable values.

Go cover profiles contain statement counts for approximate basic blocks. Dotbabel never labels this evidence as branch coverage.
A coverage percentage does not prove test quality. Review behavior, failures, and boundaries.

## Measurement states

`checked` means a tool produced usable evidence. `unsupported` means no adapter can measure the rule.
`not_configured` means the repository did not choose a tool. `unavailable` means a selected tool or report failed.
`not_applicable` means no relevant scope exists. `skipped` means the selected profile did not run the rule.

The report always shows these states. An unavailable measurement never becomes an implicit pass.

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

The precedence is shipped defaults, `${XDG_CONFIG_HOME}/dotbabel/quality.json`, project configuration, then operational CLI flags.
The user file contains the quality object without an outer key. It cannot set components, exceptions, critical paths, base references, or baseline paths.
Rule maps merge by rule identifier. Exclusions concatenate and remove duplicates.

An explicit component overrides discovery at its normalized root. Dotbabel still discovers unclaimed roots.
Unknown language names are valid. They produce `unsupported` unless an explicit `exit-code` or `dotbabel-v1` tool supplies generic evidence.

## Tool selection and trust

Project tool mappings have the highest authority. Adapters then inspect repository scripts, targets, configured ecosystem tools, and safe language built-ins.
Equal candidates produce `not_configured`; dotbabel does not guess. CI workflow text is a suggestion only and never executes automatically.

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
The default path is `.dotbabel/quality-baseline.json`.

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

## Generic reports

A repository wrapper can emit `dotbabel-v1` JSON. Validate it with `schemas/dotbabel.quality-report.schema.json`.
The report contains `schema_version: 1`, a `metrics` array, and a `findings` array.
Each metric names a stable rule and numeric `actual` value. Each finding names a rule and message, with an optional stable fingerprint.
