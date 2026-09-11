# §5 — Interfaces and APIs

> External APIs, internal endpoints, database schemas.

## External APIs

| API                                                | Calls                                                                                                                                                                                                                                                                           | Contract relied on                                                                                            |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| GitHub REST through `gh`                           | `gh pr view <N> --json body,files,mergeable,mergeStateStatus,headRefOid,baseRefOid`, `gh api repos/{owner}/{repo}/pulls/<N>` for `author_association` and the head and base repositories, `gh api repos/{owner}/{repo}/commits/<sha>/check-runs`, and creating an issue comment | A comment body of at most 65,536 characters, and 5,000 requests per hour for each authenticated user (DOC-18) |
| GitHub GraphQL through `gh api graphql --paginate` | Pull request comments with `body`, `authorAssociation`, `author.login`, `lastEditedAt`, and `isMinimized`, and the `minimizeComment` mutation with the `OUTDATED` classifier                                                                                                    | A user with write access can edit any comment, and `lastEditedAt` records that an edit happened (DOC-22)      |
| Test runners owned by the repository               | The criterion `argv`                                                                                                                                                                                                                                                            | Exit code, test names in the output, and optional JUnit XML (DOC-15)                                          |
| Coverage tools declared by the repository          | Quality coverage plans                                                                                                                                                                                                                                                          | `coveragepy-json` and `istanbul-json` (`docs/quality.md:206-219`)                                             |
| Mutation tools configured by the repository        | `deep` quality plans                                                                                                                                                                                                                                                            | Stryker mutation-testing-elements JSON (DOC-16), plus mutmut and Gremlins reports pinned by fixtures in P-C4  |
| Deployed targets                                   | Smoke checks                                                                                                                                                                                                                                                                    | HTTP status code, optional body text, and the `Location` header of a redirect (DOC-23)                        |

## Internal APIs

### `dotbabel criteria` command

The bin is `plugins/dotbabel/bin/dotbabel-criteria.mjs`. It joins `SUBCOMMANDS` in `plugins/dotbabel/bin/dotbabel.mjs:25-48` and the `bin` map in `package.json`.

```text
dotbabel criteria list   [--spec <id>] [--json]
dotbabel criteria verify (--spec <id> | --pr <N>) [--criterion <id>]... [--post]
                         [--allow-project-commands] [--pass-env <name>]...
                         [--timeout <seconds>] [--json]
```

| Flag                       | Meaning                                                                                                                                                                                                                   |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--spec <id>`              | Verify the active criteria of one spec                                                                                                                                                                                    |
| `--pr <N>`                 | Verify every spec named in the `## Spec ID` section of the pull request body, and pin the evidence to the pull request head SHA. Local `HEAD` must equal that SHA, and the worktree must be clean except for `.dotbabel/` |
| `--criterion <id>`         | Repeatable. Run a subset. A subset run never posts evidence                                                                                                                                                               |
| `--post`                   | Post a new evidence comment and minimize the tool's older evidence comments. It requires `--pr` and a full run                                                                                                            |
| `--allow-project-commands` | Trust the repository for this run only, including a fork or an `argv` change from an untrusted author (SEC-1)                                                                                                             |
| `--pass-env <name>`        | Repeatable. Pass one named environment variable to criterion commands, in addition to `criteria.pass_env` (OPS-10)                                                                                                        |
| `--timeout <seconds>`      | Per-criterion timeout from 1 through 3600. The default is `criteria.timeout_seconds`, else 600                                                                                                                            |
| `--json`                   | Print the evidence payload on stdout. `list --json` prints a list that validates against `schemas/dotbabel.criteria-list.schema.json`                                                                                     |

Exit codes follow OPS-1:

- `0` when every active criterion passes, or when no listed spec declares an active criterion.
- `1` when any active criterion is `fail`, `unconfirmed`, or `error`.
- `2` for an environment problem: a missing `gh`, missing trust, an unknown spec, a local `HEAD` that differs from the pull request head, a dirty worktree, a fork, or an active criterion's `argv` changed by an untrusted author.
- `64` for a usage error, including a `--timeout` outside 1 through 3600.

| Status        | Condition                                                                                                                                          |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pass`        | Exit 0, and every named test is present in its file and confirmed (KD-3)                                                                           |
| `fail`        | A non-zero exit, or a JUnit testcase for a named test with a `failure` or `error` child                                                            |
| `unconfirmed` | Exit 0, but a named test is absent from the report or the output, or its testcase is `skipped`                                                     |
| `error`       | A missing test file, a test name absent from its file, a timeout, a spawn failure, a report that is missing after the run, or an unreadable report |
| `pending`     | A planned criterion. It does not run and does not affect the verdict (KD-15)                                                                       |

When several criteria share the same `argv`, the runner executes that command once (`plugins/dotbabel/src/quality/runner.mjs:102-115`), and the criteria core applies the result to each of those criteria by command key (REL-4).

### Evidence payload

The schema is `schemas/dotbabel.criteria-evidence.schema.json`. The example is illustrative. Specs are sorted by id, criteria by their number, and tests by file and then name (REL-5).

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
          "output_sha256": "9f2b5c0d4e8a7b6c1d3e5f7a9b0c2d4e6f8a1b3c5d7e9f0a2b4c6d8e0f1a3b5c"
        },
        {
          "id": "AC-10",
          "status": "pending"
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

<details><summary>AC-3 output</summary>

<redacted output tail>

</details>
```

- Line 1 must match exactly, like the local-attest marker (`plugins/dotbabel/src/local-attest-lib.mjs:53`).
- Line 2 carries the whole payload, and the payload holds no output text (OPS-3).
- The readable part holds the table and each criterion's redacted output tail. The gate never reads it.
- Every full `--post` run creates a new comment. The command then minimizes the older evidence comments that the authenticated user wrote, with `minimizeComment` and the `OUTDATED` classifier. It never edits a comment (OPS-4).
- The rendered body stays at or under 60,000 characters, and output tails shrink first (OPS-3).

### Merge gate

`checkMergeGate` in `plugins/dotbabel/src/pr-gates.mjs:248` gains optional inputs. A caller that omits them gets the same result as today.

| Input                     | Type                                                              | Source                                                                       |
| ------------------------- | ----------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `headRefOid`              | string                                                            | `gh pr view --json headRefOid`                                               |
| `comments`                | array of `{ body, authorAssociation, authorLogin, lastEditedAt }` | Paginated GraphQL pull request comments                                      |
| `requiredCriteria`        | map of spec id to active criterion ids                            | `spec.json` of each linked spec at `headRefOid`                              |
| `baseActiveCriteria`      | map of spec id to active criterion ids                            | `spec.json` of the same specs at `baseRefOid`                                |
| `unknownSpecIds`          | array of strings                                                  | Spec IDs in the body with no `spec.json` at `headRefOid`                     |
| `criteriaChangeRationale` | boolean                                                           | True when the body has a `## Criteria change rationale` section with content |
| `criteriaEnforcement`     | `block` or `warn`                                                 | `criteria.enforcement` in `.dotbabel.json` at `baseRefOid`                   |
| `trustedAssociations`     | array of strings                                                  | `criteria.trusted_associations` in `.dotbabel.json` at `baseRefOid`          |
| `requireCiCheck`          | boolean                                                           | `criteria.require_ci_check` in `.dotbabel.json` at `baseRefOid`              |
| `ciCriteriaCheck`         | check run conclusion, or null                                     | The check run named `dotbabel criteria` on `headRefOid`                      |

The gate evaluates the criteria codes in three groups. It reports each spec-level code whose condition holds, then the first evidence code whose condition holds, then the CI code.

| Group    | Code                           | Condition                                                                                                          |
| -------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| Spec     | `CRITERIA_SPEC_UNKNOWN`        | A Spec ID in the body names no spec at `headRefOid`                                                                |
| Spec     | `CRITERIA_WEAKENED`            | A criterion active at `baseRefOid` is planned or missing at `headRefOid`. A rationale section makes it a warning   |
| Evidence | `CRITERIA_EVIDENCE_MISSING`    | Required criteria exist, and no comment carries the marker                                                         |
| Evidence | `CRITERIA_EVIDENCE_UNTRUSTED`  | Marker comments exist, but none has a trusted author association and a null `lastEditedAt`                         |
| Evidence | `CRITERIA_EVIDENCE_STALE`      | Trusted, unedited marker comments exist, but none names `headRefOid`                                               |
| Evidence | `CRITERIA_EVIDENCE_INVALID`    | The payload of the matching comment does not decode, fails its schema, or names a `head_sha` other than its marker |
| Evidence | `CRITERIA_EVIDENCE_INCOMPLETE` | The payload's spec ids or active criterion ids differ from `requiredCriteria`                                      |
| Evidence | `CRITERIA_FAILED`              | The payload verdict is not `pass`                                                                                  |
| CI       | `CRITERIA_CI_CHECK_FAILED`     | `requireCiCheck` is true, and `ciCriteriaCheck` is not `success`                                                   |

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
| Profile escalation                          | When `critical_matches` is not empty, rule selection adds `correctness.tests` to the current profile, and adapters let `test` through (KD-6)  |
| Result state `not_triggered`                | New. Its verdict is `info`, and its message names the unmatched globs                                                                         |
| Envelope field `critical_matches`           | New. It lists the changed files that matched `critical_paths`                                                                                 |
| Report format `stryker-json`                | Same name. It now parses per mutant and scores changed lines (KD-7)                                                                           |
| Report formats `mutmut` and `gremlins-json` | New, with provisional names. P-C4 confirms them against captured tool output                                                                  |
| Built-in plans                              | Python `pytest` with `pytest-cov` coverage, and Node Vitest and Jest coverage (KD-8)                                                          |

`schemas/dotbabel.quality-report.schema.json` adds the new state and field.

### Criteria configuration

```json
{
  "criteria": {
    "enforcement": "block",
    "trusted_associations": ["OWNER"],
    "timeout_seconds": 600,
    "pass_env": [],
    "require_ci_check": false
  }
}
```

The project config loader (`plugins/dotbabel/src/project-sync.mjs:104`) and `schemas/dotbabel.config.schema.json` validate this object (KD-14). The merge gate reads it at the base ref (REL-16).

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
- HTTP checks use `redirect: "manual"`. A redirect is followed only when its `Location` keeps the same https origin, at most 3 times, and each hop passes the SEC-8 URL rules. Any other redirect fails the check, and a secret header never goes to a different origin (DOC-23).
- `--json` prints a report that validates against `schemas/dotbabel.smoke-report.schema.json` (OPS-2).
- SEC-8, PERF-6, and REL-8 guard every check.

### Hooks

| Hook                               | Setting                                                       | Behavior                                                                                                                                     |
| ---------------------------------- | ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `githooks/pre-push`                | `BYPASS_PRE_PUSH=1`                                           | Skip the check                                                                                                                               |
| `githooks/pre-push`                | `DOTBABEL_PRE_PUSH_TIMEOUT`                                   | Seconds before the check stops, 120 by default                                                                                               |
| `githooks/pre-push`                | Quality exit code                                             | `1` blocks the push. `2`, a timeout, or a missing `dotbabel` allows the push with a notice                                                   |
| `check-on-stop.sh`                 | `CHECK_ON_STOP_TESTS=1`                                       | Turn on the related-tests stage in a trusted repository                                                                                      |
| `hooks/guard-criteria-evidence.sh` | PreToolUse on Bash                                            | Deny a command that contains the `dotbabel-criteria` marker text, unless the command runs `dotbabel-criteria` or `dotbabel criteria` (KD-16) |
| `hooks/guard-criteria-evidence.sh` | `BYPASS_CRITERIA_EVIDENCE_GUARD=1` in the session environment | Skip the guard. A variable set inside the checked command itself has no effect                                                               |

## Database Schema

dotbabel has no database. Its persistent interfaces are repository files and pull request metadata.

### `spec.json`: `acceptance_criteria` (KD-1, KD-3, KD-15)

This is an optional array. When it is present, `dotbabel-validate-specs` checks the shape of every entry. The example is illustrative.

```json
{
  "acceptance_criteria": [
    {
      "id": "AC-1",
      "status": "active",
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

| Field          | Type             | Shape rule checked by the validator                                  | Check at verification time                                                                                                      |
| -------------- | ---------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `id`           | string           | Matches `AC-<number>` and is unique within the spec                  |                                                                                                                                 |
| `status`       | string           | Optional. `planned` or `active`. An absent status means `active`     | A `planned` criterion is recorded as `pending` and does not run                                                                 |
| `given`        | string           | Non-empty                                                            |                                                                                                                                 |
| `when`         | string           | Non-empty                                                            |                                                                                                                                 |
| `then`         | string           | Non-empty                                                            |                                                                                                                                 |
| `tests`        | array            | At least one entry                                                   |                                                                                                                                 |
| `tests[].file` | string           | Non-empty, repository-relative, and inside the repository            | The file exists                                                                                                                 |
| `tests[].name` | string           | Non-empty                                                            | The name appears in the file                                                                                                    |
| `argv`         | array of strings | A non-empty array of non-empty strings                               | Runs from the repository root without a shell. The exit code and output become evidence                                         |
| `report`       | object           | Optional. `format` is `junit-xml`, and `path` is repository-relative | The command deletes the file before the run. The file must exist after the run, parse under SEC-11, and confirm each named test |

### Removed interfaces

- `regression_paths` and `verification_commands` in `docs/repo-facts.json` and its templates (KD-9).
