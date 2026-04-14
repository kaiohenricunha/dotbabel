---
name: security-review
description: >
  path|staged]"|Analyze a diff or changed files for common security vulnerabilities (injection, XSS, SSRF, secrets). Defaults to staged changes.
argument-hint: "[PR#
---

Analyze a diff or set of changed files for common security vulnerabilities.

Arguments: `$ARGUMENTS` (optional: a PR number, file path, or `staged` for staged changes. Default: staged changes.)

## Stack detection

Detect what's in the repo before applying checks (run once at the start):

```bash
HAS_NODE=$([ -f package.json ] && echo 1)
HAS_GO=$([ -f go.mod ] && echo 1)
HAS_PY=$([ -f pyproject.toml ] || [ -f requirements.txt ] && echo 1)
HAS_RUST=$([ -f Cargo.toml ] && echo 1)
HAS_DOCKER=$([ -f Dockerfile ] || [ -f compose.yml ] || [ -f docker-compose.yml ] && echo 1)
HAS_K8S=$(ls k8s/*.yaml charts/ 2>/dev/null | head -1)
```

Apply only the relevant checklists below.

## What this checks

OWASP Top 10 adapted per detected stack. Each category lists the globs to target and the class of issue to flag.

### Frontend (if `HAS_NODE` and source looks like a web app)

Common frontend globs: `src/**/*.{js,jsx,ts,tsx,vue,svelte}`, `app/**/*.{js,jsx,ts,tsx}`, `pages/**/*.{js,jsx,ts,tsx}`, `components/**/*`.

1. **XSS:** React's raw-HTML injection prop (`dangerously*`), Vue's `v-html`, Svelte's `{@html ...}`, unescaped URL params rendered into the DOM, template-literal injection into DOM sinks.
2. **Open redirect:** Unvalidated `window.location` / `router.push` assignments from user input or URL params.
3. **Sensitive data in client:** API keys, tokens, or secrets hardcoded in source files. Anything prefixed `NEXT_PUBLIC_`, `VITE_`, `REACT_APP_` holding a secret-shaped value is a leak.
4. **localStorage / sessionStorage abuse:** Storing auth tokens or sensitive data without namespacing; reading without validation.
5. **Dependency risk:** New npm dependencies added. Run `npm audit` (or `pnpm audit` / `yarn audit`) and flag known CVEs at moderate+ severity.
6. **CSP / headers:** Regressions in `Content-Security-Policy`, `X-Frame-Options`, `Referrer-Policy`, `Permissions-Policy`.

### Backend (Go, if `HAS_GO`)

Globs: `**/*.go` (excluding `**/*_test.go` unless the test introduces real endpoints).

1. **SQL injection:** String concatenation in queries instead of parameterized statements (`$1`, `$2`, or driver-specific placeholders).
2. **Auth bypass:** New routes without the project's auth middleware; protected endpoints that don't call a `RequireAuth` / `RequireAdmin` wrapper.
3. **CORS misconfiguration:** Wildcard `*` origins combined with `credentials: true`; reflected `Origin` header without allowlist.
4. **Secret exposure:** Hardcoded secrets, API keys, database URLs in Go source or config files.
5. **Path traversal:** User-controlled file paths without `filepath.Clean` + containment checks.
6. **SSRF:** `http.Get` / `http.NewRequest` on URLs derived from user input without an allowlist.
7. **Deserialization:** `json.Unmarshal` into `interface{}` combined with type assertions on unvalidated input.

### Backend (Node/TS, if `HAS_NODE` and there's server code)

Globs: `api/**/*.{ts,js}`, `server/**/*.{ts,js}`, `app/api/**/*.{ts,js}` (Next.js route handlers), `middleware.{ts,js}`.

1. **NoSQL/SQL injection** via unparameterized queries.
2. **Prototype pollution:** unsafe `Object.assign` / spread into user-provided JSON.
3. **Auth bypass, CORS, secret exposure, path traversal, SSRF:** same as Go section above.
4. **Weak crypto:** `crypto.createHash('md5')` or `sha1` for anything security-relevant.

### Backend (Python, if `HAS_PY`)

Globs: `**/*.py` (excluding tests).

1. **SQL injection:** f-string / %-format SQL instead of parameterized cursors.
2. **Shell injection:** `subprocess.*(shell=True)` with user-controlled args; `os.system`.
3. **Unsafe deserialization:** Python's binary object-serialization module (flag imports and `loads` calls against untrusted input — prefer JSON); YAML without `SafeLoader`.
4. **Auth, CORS, secrets, path traversal, SSRF:** same mental model as above.

### Data / config files

Globs: any tracked data file (`data/**`, `content/**`, project-specific generated files), plus `.env*`, `config/**`, `infra/**`.

1. **Credential leakage:** Database URLs, API keys, tokens accidentally committed.
2. **SQL injection via migration:** Dynamic SQL or unsanitized interpolation in migration files (`migrations/**.sql`, `db/migrate/**`).

### Docker / Kubernetes (if detected)

1. **Privileged containers:** `privileged: true`, `allowPrivilegeEscalation: true`.
2. **Hostpath mounts** that expose the host filesystem.
3. **Secrets in env blocks:** plaintext values in `env:` where `envFrom: secretRef` is the right pattern.
4. **`latest` image tags** in production manifests.

## Steps

1. **Determine the diff to review:**
   - If a PR number was given: `gh pr diff <number>`
   - If a file path was given: `git diff HEAD -- <path>`
   - If `staged` or no argument: `git diff --cached` (fall back to `git diff` if nothing staged)

2. **For each changed file**, map to the applicable checklists above based on path and file extension.

3. **Classify each finding:**
   - **CRITICAL:** Exploitable vulnerability (XSS, SQL/NoSQL injection, auth bypass, credential exposure, SSRF with internal network reachable).
   - **WARNING:** Potential issue needing review (new dependency with unclear provenance, broad CORS, missing input validation, weak crypto).
   - **INFO:** Best practice suggestion (namespace localStorage keys, add rate limiting, tighten CSP, prefer typed query helpers).

4. **Report as a table:**

| Severity | File | Line | Finding | Recommendation |
| -------- | ---- | ---- | ------- | -------------- |

5. If no issues found, report "Security review: clean."

Do NOT auto-fix. Report findings for the user or the calling workflow to act on.
