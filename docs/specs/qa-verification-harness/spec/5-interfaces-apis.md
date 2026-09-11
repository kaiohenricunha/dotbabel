# §5 — Interfaces and APIs

> External APIs, internal endpoints, database schemas.

## External APIs

| API                                         | Calls                                                                                                                                                                           | Contract relied on                                                                                                                                      |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GitHub REST through `gh`                    | `gh pr view <N> --json body,files,mergeable,mergeStateStatus,headRefOid`, `gh api repos/{owner}/{repo}/issues/<N>/comments --paginate`, and creating and editing issue comments | The `author_association` of each comment, a comment body of at most 65,536 characters, and 5,000 requests per hour for each authenticated user (DOC-18) |
| Test runners owned by the repository        | The criterion `argv`                                                                                                                                                            | Exit code, test names in the output, and optional JUnit XML (DOC-15)                                                                                    |
| Coverage tools declared by the repository   | Quality coverage plans                                                                                                                                                          | `coveragepy-json` and `istanbul-json` (`docs/quality.md:206-219`)                                                                                       |
| Mutation tools configured by the repository | `deep` quality plans                                                                                                                                                            | Stryker mutation-testing-elements JSON (DOC-16), plus mutmut and Gremlins reports pinned by fixtures in P-C4                                            |
| Deployed targets                            | Smoke checks                                                                                                                                                                    | HTTP status code and optional body text                                                                                                                 |

## Internal APIs

### `dotbabel criteria` command

The bin is `plugins/dotbabel/bin/dotbabel-criteria.mjs`. It joins `SUBCOMMANDS` in `plugins/dotbabel/bin/dotbabel.mjs:25-48` and the `bin` map in `package.json`.

```text
dotbabel criteria list   [--spec <id>] [--json]
dotbabel criteria verify (--spec <id> | --pr <N>) [--criterion <id>]... [--post]
                         [--allow-project-commands] [--timeout <seconds>] [--json]
```

| Flag                       | Meaning                                                                                                                                                           |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--spec <id>`              | Verify the criteria of one spec                                                                                                                                   |
| `--pr <N>`                 | Verify every spec named in the `## Spec ID` section of the pull request body, and pin the evidence to the pull request head SHA. Local `HEAD` must equal that SHA |
| `--criterion <id>`         | Repeatable. Run a subset. A subset run never posts evidence                                                                                                       |
| `--post`                   | Create or edit the evidence comment. It requires `--pr` and a full run                                                                                            |
| `--allow-project-commands` | Trust the repository for this run only (SEC-1)                                                                                                                    |
| `--timeout <seconds>`      | Per-criterion timeout from 1 through 3600. The default is `criteria.timeout_seconds`, else 600                                                                    |
| `--json`                   | Print the evidence payload on stdout                                                                                                                              |

Exit codes follow OPS-1:

- `0` when every criterion passes, or when no listed spec declares criteria.
- `1` when any criterion is `fail`, `unconfirmed`, or `error`.
- `2` for an environment problem, such as a missing `gh`, missing trust, an unknown spec, or a local `HEAD` that differs from the pull request head.
- `64` for a usage error.

| Status        | Condition                                                                                                  |
| ------------- | ---------------------------------------------------------------------------------------------------------- |
| `pass`        | Exit 0, and every named test is present in its file and confirmed (KD-3)                                   |
| `fail`        | A non-zero exit, or a JUnit testcase for a named test with a `failure` or `error` child                    |
| `unconfirmed` | Exit 0, but a named test is absent from the report or the output, or its testcase is `skipped`             |
| `error`       | A missing test file, a test name absent from its file, a timeout, a spawn failure, or an unreadable report |

### Evidence payload

The schema is `schemas/dotbabel.criteria-evidence.schema.json`. The example is illustrative.

```json
{
  "schema_version": 1,
  "tool": { "name": "dotbabel", "version": "3.4.0" },
  "head_sha": "b2c3d4e5f60718293a4b5c6d7e8f901234567890",
  "pr": 346,
  "generated_at": "2026-09-11T12:00:00Z",
  "verdict": "pass",
  "specs": [
    {
      "id": "qa-verification-harness",
      "criteria": [
        {
          "id": "AC-3",
          "status": "pass",
          "argv": ["npx", "vitest", "run", "plugins/dotbabel/tests/criteria-verify.test.mjs"],
          "exit_code": 0,
          "duration_ms": 4120,
          "timed_out": false,
          "truncated": false,
          "tests": [
            {
              "file": "plugins/dotbabel/tests/criteria-verify.test.mjs",
              "name": "passes a criterion only when the command exits 0 and every named test is confirmed",
              "found_in_file": true,
              "confirmed_by": "junit",
              "result": "passed"
            }
          ],
          "output_tail": "Test Files  1 passed (1)"
        }
      ]
    }
  ]
}
```

### Evidence comment

```text
<!-- dotbabel-criteria verified-sha=<40-character head SHA> -->
<!-- dotbabel-criteria-payload <base64url-encoded evidence payload> -->
### Acceptance criteria evidence

| Spec | Criterion | Status | Tests | Duration |
| ---- | --------- | ------ | ----- | -------- |
```

- Line 1 must match exactly, like the local-attest marker (`plugins/dotbabel/src/local-attest-lib.mjs:53`).
- Line 2 carries the whole payload. The table is for people, and the gate never reads it.
- The command edits the newest comment that the authenticated user wrote and whose first line starts with the `<!-- dotbabel-criteria` prefix. When no such comment exists, it creates one (OPS-4).
- The rendered body stays at or under 60,000 characters, and output tails shrink first (OPS-3).

### Merge gate

`checkMergeGate` in `plugins/dotbabel/src/pr-gates.mjs:248` gains optional inputs. A caller that omits them gets the same result as today.

| Input                 | Type                                    | Source                                                                  |
| --------------------- | --------------------------------------- | ----------------------------------------------------------------------- |
| `headRefOid`          | string                                  | `gh pr view --json headRefOid`                                          |
| `comments`            | array of `{ body, author_association }` | Paginated issue comments                                                |
| `criteriaRequired`    | boolean                                 | True when any spec named in `## Spec ID` declares `acceptance_criteria` |
| `criteriaEnforcement` | `block` or `warn`                       | `criteria.enforcement` in `.dotbabel.json`                              |
| `trustedAssociations` | array of strings                        | `criteria.trusted_associations` in `.dotbabel.json`                     |

The criteria reason codes apply only when `criteriaRequired` is true. The gate reports the first code in this table whose condition holds:

| Code                          | Condition                                                                                        |
| ----------------------------- | ------------------------------------------------------------------------------------------------ |
| `CRITERIA_EVIDENCE_MISSING`   | No comment carries the marker                                                                    |
| `CRITERIA_EVIDENCE_UNTRUSTED` | Marker comments exist, but no author is trusted                                                  |
| `CRITERIA_EVIDENCE_STALE`     | The newest trusted marker names a SHA other than `headRefOid`                                    |
| `CRITERIA_EVIDENCE_INVALID`   | The payload does not decode, fails its schema, or names a `head_sha` other than the marker's SHA |
| `CRITERIA_FAILED`             | The payload verdict is not `pass`                                                                |

`GateResult` gains `warnings`, an array that is empty by default. With `warn`, the criteria reasons move to `warnings`, and `ok` ignores them.

### Quality configuration

```json
{
  "quality": {
    "critical_paths": ["src/scoring/**"],
    "components": [
      {
        "root": ".",
        "languages": ["javascript"],
        "tools": {
          "regression": {
            "argv": ["npm", "run", "check:ranking-sanity"],
            "paths": ["data/**", "**/rankings/**"],
            "timeout_seconds": 600,
            "report": { "format": "exit-code" }
          }
        }
      }
    ]
  }
}
```

| Key or value                                | Rule                                                                                                                                          |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `tools.<capability>.paths`                  | Optional. A non-empty array of repository-relative globs, matched with `matchesGlob` (`plugins/dotbabel/src/spec-harness-lib.mjs:297`) (KD-5) |
| Capability `regression`                     | New. It runs in `pr` and `deep` and feeds `correctness.regression`, a hard rule with no exception and no baseline (KD-5)                      |
| `critical_paths`                            | Existing key, now active (KD-6)                                                                                                               |
| Result state `not_triggered`                | New. Its verdict is `info`, and its message names the unmatched globs                                                                         |
| Envelope field `critical_matches`           | New. It lists the changed files that matched `critical_paths`                                                                                 |
| Report format `stryker-json`                | Same name. It now parses per mutant and scores changed lines (KD-7)                                                                           |
| Report formats `mutmut` and `gremlins-json` | New, with provisional names. P-C4 confirms them against captured tool output                                                                  |
| Built-in plans                              | Python `pytest` with `pytest-cov` coverage, and Node Vitest and Jest coverage (KD-8)                                                          |

`schemas/dotbabel.quality-report.schema.json` adds the new state and field.

### Criteria configuration

```json
{
  "criteria": { "enforcement": "block", "trusted_associations": ["OWNER"], "timeout_seconds": 600 }
}
```

The project config loader (`plugins/dotbabel/src/project-sync.mjs:104`) and `schemas/dotbabel.config.schema.json` validate this object (KD-14).

### Deploy targets and smoke checks

```json
{
  "targets": [
    {
      "kind": "vercel",
      "project": "my-app",
      "smoke": [
        {
          "name": "health",
          "type": "http",
          "url": "https://my-app.example.com/api/health",
          "expect_status": 200,
          "expect_body_contains": "ok",
          "headers_from_env": { "Authorization": "SMOKE_TOKEN" },
          "timeout_ms": 10000,
          "retries": 3
        },
        {
          "name": "checkout-journey",
          "type": "command",
          "argv": ["npm", "run", "smoke:checkout"],
          "env_from": ["SMOKE_BASE_URL"],
          "timeout_seconds": 120
        }
      ]
    }
  ],
  "rollback_order": ["vercel"]
}
```

```text
node skills/deploy-status/scripts/deploy-ops.mjs smoke [--target <key>] [--json] [--dry-run] [--cwd <dir>]
```

- Exit `0` when every check passes, or when no target declares checks, which prints a notice.
- Exit `1` when any check fails.
- Exit `2` for a configuration or discovery error, and `64` for a usage error.
- SEC-8, PERF-6, and REL-8 guard every check.

### Hooks

| Hook                | Setting                     | Behavior                                                                                   |
| ------------------- | --------------------------- | ------------------------------------------------------------------------------------------ |
| `githooks/pre-push` | `BYPASS_PRE_PUSH=1`         | Skip the check                                                                             |
| `githooks/pre-push` | `DOTBABEL_PRE_PUSH_TIMEOUT` | Seconds before the check stops, 120 by default                                             |
| `githooks/pre-push` | Quality exit code           | `1` blocks the push. `2`, a timeout, or a missing `dotbabel` allows the push with a notice |
| `check-on-stop.sh`  | `CHECK_ON_STOP_TESTS=1`     | Turn on the related-tests stage in a trusted repository                                    |

## Database Schema

dotbabel has no database. Its persistent interfaces are repository files and pull request metadata.

### `spec.json`: `acceptance_criteria` (KD-1, KD-3)

This is an optional array. When it is present, `dotbabel-validate-specs` checks the shape of every entry. The example is illustrative.

```json
{
  "acceptance_criteria": [
    {
      "id": "AC-1",
      "given": "a criterion command that exits 0",
      "when": "every named test appears in the JUnit report without a failure",
      "then": "the criterion passes and its evidence is pinned to the head commit",
      "tests": [
        {
          "file": "plugins/dotbabel/tests/criteria-verify.test.mjs",
          "name": "passes a criterion only when the command exits 0 and every named test is confirmed"
        }
      ],
      "argv": [
        "npx",
        "vitest",
        "run",
        "plugins/dotbabel/tests/criteria-verify.test.mjs",
        "--reporter=junit",
        "--outputFile=.dotbabel/criteria/AC-1.junit.xml"
      ],
      "report": {
        "format": "junit-xml",
        "path": ".dotbabel/criteria/AC-1.junit.xml"
      }
    }
  ]
}
```

| Field          | Type             | Shape rule checked by the validator                                  | Check at verification time                                                                   |
| -------------- | ---------------- | -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `id`           | string           | Matches `AC-<number>` and is unique within the spec                  |                                                                                              |
| `given`        | string           | Non-empty                                                            |                                                                                              |
| `when`         | string           | Non-empty                                                            |                                                                                              |
| `then`         | string           | Non-empty                                                            |                                                                                              |
| `tests`        | array            | At least one entry                                                   |                                                                                              |
| `tests[].file` | string           | Non-empty, repository-relative, and inside the repository            | The file exists                                                                              |
| `tests[].name` | string           | Non-empty                                                            | The name appears in the file                                                                 |
| `argv`         | array of strings | A non-empty array of non-empty strings                               | Runs from the repository root without a shell. The exit code and output tail become evidence |
| `report`       | object           | Optional. `format` is `junit-xml`, and `path` is repository-relative | The file exists after the run, parses under SEC-11, and confirms each named test             |

### Removed interfaces

- `regression_paths` and `verification_commands` in `docs/repo-facts.json` and its templates (KD-9).
