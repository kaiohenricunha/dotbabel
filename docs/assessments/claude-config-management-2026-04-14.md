# Claude Config Management (`@kaiohenricunha/dotclaude`) — Assessment — 2026-04-14

Assessment of the dual-purpose `dotclaude` repository: a portable npm package + Claude Code plugin that bootstraps SDD governance into consumer repos, and Kaio's personal global Claude Code dotfiles symlinked into `~/.claude/` via `bootstrap.sh`.

**Target type:** project
**Overall grade: 6.5 / 10 — Passable**

## Scope

Evaluated the repository at `df68006` (tip of `main`). Applied the built-in `project` rubric (7 dimensions, weights sum to 1.00).

Included: npm package (`plugins/dotclaude/`), global dotfiles (`commands/`, `skills/`, `bootstrap.sh`, `sync.sh`, `CLAUDE.md`, `README.md`), templates shipped to consumers (`plugins/dotclaude/templates/`), test suite (vitest + shell), root config surface.

Excluded: downstream consumers of the harness package, the MCP server ecosystem referenced in `README.md`, anything under `docs/plans/` (forward-looking, not current state).

## Rubric & scores

| Dimension                  |   Weight |  Score | Weighted | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| -------------------------- | -------: | -----: | -------: | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Architecture clarity       |     0.20 | 7.0/10 |     1.40 | Clean layer split `src/` + `bin/` + `scripts/` + `templates/`; helpers centralized at `plugins/dotclaude/src/spec-harness-lib.mjs:5-98`; but `package.json:6` `"main"` points at non-existent `plugins/dotclaude/src/index.mjs`; no barrel export; dual-persona layout undocumented                                                                                                                                                                                                                                                              |
| Code quality & consistency |     0.15 | 7.8/10 |     1.17 | Zero runtime deps (`package.json:29-31`); idiomatic ESM across 1,258 LOC (6 src + 5 bins + 4 scripts + 1 hook); JSDoc present only on 2 of 6 validators (`validate-specs.mjs:17-33`, `check-instruction-drift.mjs:7-24`); silent error swallows at `spec-harness-lib.mjs:28-29` and `:184-186`; no `.prettierrc`, no `.editorconfig`                                                                                                                                                                                                         |
| Test coverage & quality    |     0.15 | 7.5/10 |     1.13 | 38 vitest tests across 6 files + 8 shell tests in `test_validate_settings.sh`, all passing (`npm test` green in <600ms); `detect-branch-drift.mjs` + `auto-update-manifest.mjs` have no tests; no coverage thresholds in `vitest.config`; no bats suite for `bootstrap.sh`/`sync.sh`/hooks                                                                                                                                                                                                                                                   |
| CI/CD & automation         |     0.10 | 3.0/10 |     0.30 | Zero workflows at repo root (`.github/` does not exist); 3 workflow templates shipped to consumers (`plugins/dotclaude/templates/workflows/{ai-review,detect-drift,validate-skills}.yml`) — the library never runs its own validators; no Dependabot, no CodeQL, no release automation, no branch protection config checked in                                                                                                                                                                                                                 |
| Documentation              |     0.10 | 5.5/10 |     0.55 | `README.md` (8976 B, recently rewritten for public audience in `7dbd661`) + `CLAUDE.md` (7897 B, thorough contributor rules) are solid; **LICENSE file is missing** (hard blocker for npm publication legitimacy despite `package.json:36` `"license": "MIT"`); no CHANGELOG, CONTRIBUTING, CODE_OF_CONDUCT, SECURITY; README import block at `:67-72` advertises `plugins/dotclaude/src/spec-harness-lib.mjs` which exists but is not the package `"main"`; zero ADRs despite SEC-1..4 + OPS-1..2 decisions baked into `validate-settings.sh` |
| Security posture           |     0.15 | 7.5/10 |     1.13 | `guard-destructive-git.sh` hook present (23 LOC; plan flags regex gap at `:16`); `validate-settings.sh` enforces SEC1-4 + OPS1-2 (passes 8/8 self-tests); workflow templates SHA-pin all actions (`templates/workflows/validate-skills.yml:19-20`); zero runtime deps (clean supply chain); **4 moderate transitive CVEs via `vitest@1.6.0` → `vite` → `esbuild`** (GHSA-67mh-4wv8-2f99, GHSA-4w7w-66w2-5vf9); no SECURITY.md/disclosure policy; no npm provenance; no CodeQL                                                                |
| Observability              |     0.15 | 5.5/10 |     0.83 | Gold-standard ✓/✗/⚠ format in `validate-settings.sh:43-45` with ANSI gate on `-t 1`; but **no bin supports `--help`, `--version`, `--json`, `--verbose`, or `--no-color`**; errors are raw strings (no `code`, no machine-parseable structure); exit codes inconsistent across bins; no `dotclaude-doctor` diagnostic; silent catches at `spec-harness-lib.mjs:28-29` + `:184-186` drop failure signal                                                                                                                                         |
| **Overall**                | **1.00** |      — | **6.50** | —                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |

## Dimension detail

### Architecture clarity — 7.0/10

The three-layer split (`src/` pure logic → `bin/` thin CLI wrappers → `scripts/` + `hooks/` shell tooling → `templates/` consumer payload) is clean and each layer has a single responsibility. `createHarnessContext` at `plugins/dotclaude/src/spec-harness-lib.mjs:5-21` is a well-designed ambient context object reused across every validator. Helpers `readJson` / `readText` / `pathExists` / `git` / `loadFacts` / `listSpecDirs` / `listRepoPaths` / `toPosix` at `:33-98` form a coherent fs-and-git toolkit.

The hard flaws are productization, not design. `package.json:6` `"main": "plugins/dotclaude/src/index.mjs"` points at a file that does not exist — any `require('@kaiohenricunha/dotclaude')` throws `MODULE_NOT_FOUND`. There is no barrel export; consumers must deep-import validator files individually, which the READMEs get wrong (see Documentation dimension). The dual-persona nature (library + dotfiles) is load-bearing but undocumented; `bootstrap.sh`/`sync.sh` live at repo root with no ADR explaining why.

**To raise this score:** add `plugins/dotclaude/src/index.mjs` barrel (24 exports); fix `"main"` + add `"exports"` field; ADR-0001 documenting dual-persona layout; umbrella `dotclaude` dispatcher bin.

### Code quality & consistency — 7.8/10

Zero runtime dependencies (`package.json:29-31` shows only `vitest` as devDep). Code is tidy and idiomatic ESM. Naming is consistent (`validate-*`, `check-*`). Helper reuse avoids duplication. Where JSDoc exists it is high-quality (`validate-specs.mjs:17-33` + `check-instruction-drift.mjs:7-24`).

Problems are consistency holes and missing discipline, not bad code. JSDoc is present on 2 of 6 validators; `spec-harness-lib.mjs` (the shared toolkit — 18 exports) has none. Two silent catches (`spec-harness-lib.mjs:28-29` `resolveRepoRootFromGit`, `:184-186` `getChangedFiles`) swallow errors without even debug logging, making failures hard to trace. No `.prettierrc`, `.editorconfig`, `.markdownlint-cli2.jsonc`, or `.shellcheckrc` — the project is unopinionated about formatting. Shellcheck finds 4 minor notes across the shell surface (2× SC2088 tilde-in-quotes at `validate-settings.sh:166,175`; 1× SC2001 + 1× SC2016 in `test_validate_settings.sh`) — all safe, but unaddressed.

**To raise this score:** JSDoc every export in `spec-harness-lib.mjs`; replace silent catches with `debug()`-gated logging; add `.prettierrc` + `.shellcheckrc`; fix the 4 shellcheck notes.

### Test coverage & quality — 7.5/10

All 6 validator modules have corresponding test files and all 38 vitest tests pass (`npm test` green in 564 ms). `test_validate_settings.sh` contributes 8 further shell-level tests (all pass), which is disciplined given the criticality of the SEC1-4/OPS1-2 invariants.

Gaps: `plugins/dotclaude/scripts/detect-branch-drift.mjs` (81 LOC) and `plugins/dotclaude/scripts/auto-update-manifest.mjs` (20 LOC) have zero tests. There are no tests for the shell entry points (`bootstrap.sh`, `sync.sh`, `refresh-worktrees.sh`) or for the `guard-destructive-git.sh` hook's regex matrix. `vitest.config` (absent from the repo) sets no coverage thresholds; the true coverage number is unknown.

**To raise this score:** add test files for `detect-branch-drift` + `auto-update-manifest`; `vitest.config.mjs` with 85/85/80/85 thresholds; bats suite for `bootstrap`/`sync`/`refresh-worktrees`/`guard-destructive-git`; end-to-end integration test that `git init`s a tmpdir, runs `dotclaude-init`, then runs each validator.

### CI/CD & automation — 3.0/10

The starkest dimension. The library ships CI templates to consumers (`plugins/dotclaude/templates/workflows/{ai-review,detect-drift,validate-skills}.yml`, all SHA-pinned — good) but runs none on itself: `.github/workflows/` does not exist at the repo root. No push or PR ever runs `npm test`, `shellcheck`, `validate-settings`, or any of the harness bins. There is no Dependabot, no CodeQL, no release workflow, no link checker, no PR template, no CODEOWNERS, no issue templates.

This is the single highest-leverage remediation area: publishing a governance tool without automating its own governance undermines credibility.

**To raise this score:** 7 workflows (`test.yml` matrix 20/22, `lint.yml`, `codeql.yml`, `links.yml`, `dogfood.yml`, `docs.yml`, `release.yml` with OIDC provenance); Dependabot weekly; CODEOWNERS; PR template enforcing Spec ID.

### Documentation — 5.5/10

`README.md` was rewritten for public audience in `7dbd661` (8976 B, restructured); `CLAUDE.md` (7897 B) is a thorough global rule floor. Both are high-signal where they exist.

But **`LICENSE` is missing** — despite `package.json:36` `"license": "MIT"`, there is no license file at the repo root, which is a hard credibility hit for an npm package. No `CHANGELOG.md`, `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `SECURITY.md`. No `docs/` beyond `docs/plans/` — no quickstart, architecture diagram, API reference, CLI reference, troubleshooting, upgrade guide. Zero ADRs despite SEC-1..4 + OPS-1..2 decisions hard-coded into `validate-settings.sh` with no decision record. Commands under `commands/*.md` lack the YAML frontmatter that `skills/*/SKILL.md` already uses (verified: `commands/ground-first.md:1` starts with prose; `skills/spec/SKILL.md:1-11` has frontmatter) — undocumented schema divergence. The README import block at `:67-72` advertises a path (`plugins/dotclaude/src/spec-harness-lib.mjs`) that works only if the consumer deep-imports around the broken `"main"`.

**To raise this score:** LICENSE, CHANGELOG (Keep-a-Changelog), CONTRIBUTING, CODE_OF_CONDUCT, SECURITY; full `docs/` tree (index, quickstart, architecture, cli-reference, api-reference, troubleshooting, upgrade-guide, personas); 14 ADRs covering the hardening decisions; unified command/skill frontmatter schema.

### Security posture — 7.5/10

Strong fundamentals: the `guard-destructive-git.sh` hook blocks `rm -rf`, `git push --force`, `git reset --hard` on untrusted branches, etc. at the Claude Code hook layer. `validate-settings.sh` enforces SEC-1 (no secret literals), SEC-2 (no `--dangerously-skip-permissions`), SEC-3 (no `@latest` in MCP args), SEC-4 (credentials mode 0600) plus OPS-1/2 — all 8 self-tests pass. Workflow templates pin every action by commit SHA (`templates/workflows/validate-skills.yml:19-20`). Zero runtime dependencies → clean supply chain. `.gitignore:1-4` proactively excludes `settings.local.json` to prevent secret leaks.

Weaknesses: `npm audit` reports 4 moderate transitive CVEs in the devDep tree (via `vitest@1.6.0` → `vite` → `esbuild`; fix is a breaking vitest bump). The guard hook's regex at `hooks/guard-destructive-git.sh:16` has a gap (tab-vs-space and aliasable `git` invocations slip through — flagged in the remediation plan). No `SECURITY.md` / disclosure policy / CVE window. No npm publish provenance. No CodeQL scanning. No private-vuln-reporting enabled. No 2FA statement for the publisher account.

**To raise this score:** harden `guard-destructive-git.sh:16` regex + bypass env; upgrade vitest to 3.x/4.x to clear the CVE chain; `SECURITY.md` with 3 threat-model subsections; CodeQL workflow; npm provenance via OIDC trusted publisher; secret-scan step in `sync.sh` pre-stage.

### Observability — 5.5/10

`validate-settings.sh:43-45` defines gold-standard `pass()`/`fail()`/`warn()` with ✓/✗/⚠ prefixes and an ANSI gate on `-t 1` — this is the house UI standard worth replicating. Exit code _intent_ is clear (0 good, non-zero bad).

But nothing else consumers can parse exists. **No bin supports `--help`, `--version`, `--json`, `--verbose`, or `--no-color`** — verified by inspection of the 5 bins in `plugins/dotclaude/bin/`. Errors propagate as plain strings with no `code` / `category` / `pointer` → downstream CI pipelines can only regex stderr. Exit codes are inconsistent across bins (no named enum, no convention documented). There is no `dotclaude-doctor` diagnostic to validate install + env + dogfood manifests. Silent catches at `spec-harness-lib.mjs:28-29` + `:184-186` actively erase failure signal in git-related code paths — the thing an operator most wants visibility into.

**To raise this score:** structured-error taxonomy (`StructuredError` with `code`/`file`/`pointer`/`expected`/`got`/`hint`/`category`); named exit-code enum (0/1/2/64); `--help`/`--version`/`--json`/`--verbose`/`--no-color` on every bin; `dotclaude-doctor` umbrella diagnostic; replace silent catches with `DOTCLAUDE_DEBUG=1`-gated debug output.

## Highest-leverage improvements

Ranked by estimated grade lift.

1. **Stand up repo-level CI (7 workflows)** — `CI/CD (+5.0)`, `Documentation (+0.3 via PR template)`, `Security (+0.5 via CodeQL + Dependabot)`. Estimated lift: **+0.63**.
2. **Fix package.json contract + add barrel export + umbrella CLI** — `Architecture (+2.0)`, `Documentation (+0.5 via working imports)`. Estimated lift: **+0.45**.
3. **Docs workstream (LICENSE, CHANGELOG, CONTRIBUTING, SECURITY, 14 ADRs, `docs/` tree, command frontmatter)** — `Documentation (+3.5)`, `Security (+0.5)`. Estimated lift: **+0.43**.
4. **Observability contract: structured errors + exit codes + `--help`/`--version`/`--json`/`--verbose` on every bin + `dotclaude-doctor`** — `Observability (+4.0)`, `Code quality (+0.3)`. Estimated lift: **+0.65**.
5. **Shell hardening: `set -euo pipefail`, `guard-destructive-git.sh:16` regex + bypass env, bats suite, vitest CVE upgrade** — `Security (+1.5)`, `Tests (+1.0)`. Estimated lift: **+0.38**.
6. **Dogfood: root `.claude/skills-manifest.json` + `docs/repo-facts.json` + `docs/specs/dotclaude-core/` + `examples/minimal-consumer/` + `dogfood.yml`** — `Architecture (+0.5)`, `Tests (+0.5)`, `CI (+0.5)`. Estimated lift: **+0.23**.

Cumulative estimated lift: **+2.77** → projected overall ~9.3 if all land.

## Summary

A well-designed small library with disciplined shell hardening and zero runtime deps, undone by productization gaps: broken `package.json` `"main"`, no LICENSE file, zero CI on itself, raw-string errors, no `--help`/`--version`/`--json` on any bin, and no decision records for the security invariants it enforces. The code layer is near production-ready; the packaging, governance, and observability layers need a coherent remediation sweep (see `docs/plans/2026-04-14-ten-out-of-ten-remediation.md`). Single highest-leverage action: ship the 7-workflow CI set so the library dogfoods its own validators on every push.
