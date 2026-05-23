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
    env?: Record<string, string>; // extra env vars for this leg only
  }>;

  label?: string; // PR label to apply on attest (default: "ci/local-verified")
  auditLogPath?: string; // jsonl audit trail (default: ".local-attest-log.jsonl")
  trustedAssociations?: string[]; // gh author_association values that gate CI (default: ["OWNER"])
  requireClean?: boolean; // abort on dirty worktree (default: true)
  requireDocker?: boolean; // abort if `docker info` fails (default: false)
  pushAfterAttest?: boolean; // git push after attest, before posting (default: true)
};
```

The matrix is the only required field; everything else has sensible defaults.

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
- Unknown top-level keys are ignored. Defaults are merged from
  `plugins/dotbabel/src/local-attest-config.mjs:DEFAULTS`.

`dotbabel local-attest --dry-run --pr <N>` runs the matrix and prints the
comment it would post without touching the PR — use it to validate a new
config end-to-end.
