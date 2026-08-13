# `.local-attest` configuration

Every consuming project supplies its own CI matrix. The skill discovers config
in this order (first match wins):

1. `--config <path>` (CLI flag)
2. `.local-attest.config.mjs`
3. `.local-attest.config.json`
4. `package.json` → `local-attest` key

## Schema

```ts
type Config = {
  // REQUIRED — the list of checks to run locally. Order is preserved.
  matrix: Array<{
    name: string; // unique within the matrix; appears in the result table
    mode:
      | "hard" // "hard" legs must pass to attest
      | "advisory"; // "advisory" legs report but never block
    command: string; // shell command (runs under `bash -c`)
    cwd?: string; // working dir relative to project root
    env?: Record<string, string>; // extra env vars for this leg only (values must be strings)
    lane?: string; // legs sharing a lane run serially in matrix order; distinct lanes run concurrently
    when?: { changedPaths: string[] }; // run only when SOME changed PR file matches a glob (CI path filter, mirrored)
    skipWhenDiffOnly?: string[]; // skip when EVERY changed PR file matches a glob (docs-only classify, mirrored)
    passPrBody?: boolean; // inject the PR body as env.PR_BODY for this leg
  }>;

  label?: string; // PR label to apply on attest (default: "ci/local-verified")
  auditLogPath?: string; // jsonl audit trail (default: ".local-attest-log.jsonl")
  trustedAssociations?: string[]; // gh author_association values that gate CI (default: ["OWNER"])
  requireClean?: boolean; // abort on dirty worktree (default: true)
  requireDocker?: boolean; // abort if `docker info` fails (default: false)
  pushAfterAttest?: boolean; // git push after the comment posts (default: true)

  // Optional toolchain pins. On an attest run a mismatch fails closed —
  // the attestation claims "CI would pass", and a matrix run on a different
  // Node or Go than CI uses certifies a run CI would never perform.
  // Diagnostic runs (--only/--from) warn instead of failing. Unparseable
  // versions count as mismatches.
  toolchain?: {
    node?: string; // exact major pin ("22"); range syntax (">=22", "^22") is rejected
    goMod?: string; // relative path (no "..") to a go.mod; its go directive major.minor must match `go version`
  };

  // Tracked files a leg is known to overwrite (e2e fixture seeders). They are
  // snapshotted before the matrix and restored byte-exact afterwards, BEFORE
  // the post-matrix head recheck — without this, the recheck aborts every run
  // on the matrix's own writes. Relative paths, no "..".
  restoreFiles?: string[];
};
```

### Lanes: the authoring contract

Concurrent lanes share one worktree. Two rules keep that safe: **legs that
mutate the tree, and every leg that reads what they mutate, must share one
lane, ordered readers-first in the matrix**; and glob-gated skipping never
reorders anything — skipped legs are marked, not removed. Diff globs use
`**` (crosses directories), `*` and `?` (single segment). All four fields are
plain data, so they work identically in `.mjs` and `.json` configs.

Fail-open rule: when the PR's changed-file list cannot be read, looks
truncated (the Files API caps at 3000 files — the tool cross-checks the
parsed list against the PR's declared `changedFiles` count), or is empty,
`when`/`skipWhenDiffOnly` skip nothing and every leg runs. Running too much
is safe; an attested PR that skipped too much has disabled CI on unverified
code. An all-skipped run refuses to attest for the same reason.

**The superset burden is yours.** Nothing verifies these globs against
`.github/workflows/**`. A `when` glob narrower than the mirrored CI job's
`paths:` filter skips the leg locally while the attestation switches that job
off remotely — unverified code merges with CI disabled. Keep every diff-rule
glob at least as broad as the CI filter it mirrors, and re-check the pair
whenever either side changes. The dialect is deliberately small (`**`, `*`,
`?`); CI syntax like `{a,b}` or `!` is rejected at validation rather than
silently matching nothing.

The matrix is the only required field; everything else has sensible defaults.

Pin the toolchain to whatever CI's setup steps install (`node-version:`,
`go-version-file:`). If CI runs a version matrix, pin the one you attest with
and note that the other legs are skipped under attestation regardless.

## Audit log

Every run whose matrix executes appends exactly one JSONL line to
`auditLogPath`, tagged `result: attested | hard-fail | head-moved | push-fail
| post-fail | dry-run | diagnostic`, with per-leg
`{name, mode, status, durationS}` (`status ∈ pass | fail | advisory-fail |
skipped | not-run`), the invocation `flags`, the certified `toolchain` versions when
pins are configured, and — for diagnostic runs — a `dirty` marker, because a
dirty tree's `sha` does not identify the tree that ran.
Lines written by versions before `result` existed were only ever written
after a successful post, so a missing `result` implies `attested`.

## Example 1 — minimal Node app

```js
// .local-attest.config.mjs
export default {
  matrix: [
    { name: "npm ci", mode: "hard", command: "npm ci" },
    { name: "lint", mode: "hard", command: "npm run lint" },
    { name: "tests", mode: "hard", command: "npm test" },
    { name: "build", mode: "hard", command: "npm run build" },
    { name: "audit", mode: "advisory", command: "npm audit --omit=dev --audit-level=high" },
  ],
};
```

## Example 2 — Node frontend + Go backend monorepo

```js
// .local-attest.config.mjs
export default {
  matrix: [
    { name: "npm ci", mode: "hard", command: "npm ci" },
    { name: "frontend lint", mode: "hard", command: "npm run lint" },
    { name: "frontend tests", mode: "hard", command: "npm run test:coverage" },
    { name: "frontend build", mode: "hard", command: "npm run build" },
    { name: "knip", mode: "advisory", command: "npm run knip" },
    {
      name: "e2e",
      mode: "hard",
      command: "npx playwright install chromium && npm run test:e2e",
      env: { CI: "1" },
    },
    { name: "backend tests", mode: "hard", command: "go test -race -count=1 ./...", cwd: "api" },
    {
      name: "backend vuln",
      mode: "hard",
      command: "go run golang.org/x/vuln/cmd/govulncheck@v1.1.4 ./...",
      cwd: "api",
    },
    {
      name: "golangci-lint",
      mode: "advisory",
      command: "go run github.com/golangci/golangci-lint/v2/cmd/golangci-lint@v2.11.4 run",
      cwd: "api",
    },
  ],
  requireDocker: true, // testcontainers-based integration tests
  trustedAssociations: ["OWNER"],
};
```

## Example 3 — Python (uv + pytest)

```json
{
  "matrix": [
    { "name": "uv sync", "mode": "hard", "command": "uv sync --frozen" },
    { "name": "ruff", "mode": "hard", "command": "uv run ruff check ." },
    { "name": "mypy", "mode": "hard", "command": "uv run mypy ." },
    { "name": "pytest", "mode": "hard", "command": "uv run pytest -q" },
    {
      "name": "coverage",
      "mode": "advisory",
      "command": "uv run pytest --cov=src --cov-fail-under=80"
    }
  ],
  "trustedAssociations": ["OWNER", "MEMBER"]
}
```

## Validation rules

- `matrix` must be a non-empty array.
- Every leg must have a non-empty `name`, a `mode` of `"hard"` or `"advisory"`,
  and a non-empty `command`.
- Leg `name`s must be unique within the matrix.
- `auditLogPath` must not contain `..` segments (path-traversal guard).
- `trustedAssociations` must be a non-empty array of strings.
- `env` values must be strings; `lane` non-empty; `when` exactly
  `{ changedPaths: [globs] }` (non-empty); `skipWhenDiffOnly` a non-empty glob
  array; `passPrBody` boolean; `restoreFiles` relative paths without `..`.
- Unknown top-level keys are ignored. Defaults are merged from
  `plugins/dotbabel/src/local-attest-config.mjs:DEFAULTS`.

`dotbabel local-attest --dry-run --pr <N>` runs the matrix and prints the
comment it would post without touching the PR — use it to validate a new
config end-to-end.
