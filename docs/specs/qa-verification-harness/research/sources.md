# Research Sources

> Indexed documents feeding into this spec. Each tagged with which sections it informs.

- **DOC-1**: [QA practice report](qa-practice-report.md) — the lifecycle QA model and its mapping onto the idea → spec → work unit → PR → `pr-conductor` pipeline; names acceptance criteria as the test oracle and executed evidence as the gate. Feeds: §1, §2, §4.
- **DOC-2**: [Current-state analysis](../current-state/analysis.md) — grounded audit of the QA surface at `db08ece`, with the 6/10 assessment and the ranked gaps. Feeds: §1, §2, §3, §4, §8.
- **DOC-3**: `plugins/dotbabel/src/validate-specs.mjs` — the `spec.json` contract, the `acceptance_commands` shape check, and the §7 quantification lint. Feeds: §4, §5, §7.
- **DOC-4**: `plugins/dotbabel/src/pr-gates.mjs` — `CONDUCTOR_PHASES` and the merge-gate reason codes, including `DEFERRED_TEST_PLAN`. Feeds: §4, §5, §6.
- **DOC-5**: `skills/pr-conductor/SKILL.md` and `skills/review-pr/SKILL.md` step 11 — the phase table, test-plan execution, and the deferral marker. Feeds: §4, §6.
- **DOC-6**: `skills/validate-spec/SKILL.md` — Phase 3 constraint-evidence search and Phase 4 acceptance-command execution with stash proof. Feeds: §4, §6.
- **DOC-7**: `plugins/dotbabel/src/quality/` — the rule catalog (`policy.mjs`), the trust-gated runner (`runner.mjs`), the per-language test plans (`adapters/`), and the report parsers (`reports.mjs`). Feeds: §3, §4, §5, §7.
- **DOC-8**: `skills/release-conductor/SKILL.md` (`verify`) and `skills/deploy-status/SKILL.md` — today's post-publish and deploy-drift checks. Feeds: §2, §4.
- **DOC-9**: `plugins/dotbabel/src/init-harness-scaffold.mjs` and `plugins/dotbabel/templates/` — what a consumer repo receives from `dotbabel init`. Feeds: §2, §3.
- **DOC-10**: `docs/hooks.md`, `plugins/dotbabel/hooks/`, and `plugins/dotbabel/templates/githooks/pre-commit` — the hook surface and its opt-in model. Feeds: §2, §4.
- **DOC-11**: `commands/merge-pr.md` step 5, `docs/repo-facts.json`, and `plugins/dotbabel/templates/docs/repo-facts.json` — the prose-only data-regression gate and the unread `verification_commands` template key. Feeds: §2, §5.
- **DOC-12**: `docs/quality.md` — the "never installs a checker" principle, the `.dotbabel.json` tool declaration, and the report formats that yield each measurement. Feeds: §2, §4, §5.
- **DOC-13**: Local spec survey of 2026-09-10 — 38 `spec.json` files across dotbabel and one consumer repository; 37 are `approved`, `implementing`, or `done`, and none declares acceptance criteria. `validate-specs.mjs` checks every spec on each run and has no warning level. Feeds: §2, §6.
- **DOC-14**: Repo-facts key survey of 2026-09-10 — `verification_commands` entered as an empty template key in `2cadd27` and has no reader or documentation; `regression_paths` replaced hardcoded data globs in `59b5c63` and is read only by `merge-pr` prose and the rule floor; no local project gives either key a value; one consumer repository keeps several command lists and a parity check between two of them; `critical_paths` is parsed in `plugins/dotbabel/src/quality/config.mjs` and never used. Feeds: §2, §4, §5.
- **DOC-15**: JUnit XML test reports — the de facto per-test result format, written by pytest `--junitxml`, the Vitest `junit` reporter, `jest-junit`, `go-junit-report`, and bats-core. Feeds: §3, §4 (KD-3), §5, §6.
- **DOC-16**: Stryker Mutator mutation-testing-elements report schema, and its mutation score defined as detected ÷ valid × 100. Feeds: §4 (KD-7), §5, §7.
- **DOC-17**: OWASP Top 10 for Large Language Model Applications, LLM01 Prompt Injection — instructions hidden in content that a model reads. Feeds: §4 (KD-4), §7 (SEC-5), §8.
- **DOC-18**: GitHub documentation — Actions security hardening (pin actions to a full-length commit SHA; least-privilege `GITHUB_TOKEN` permissions), GitHub Security Lab guidance on `pull_request_target`, the 65,536-character comment body limit, and the REST limit of 5,000 requests per hour for authenticated users. Feeds: §3, §5, §7 (SEC-7, OPS-3, PERF-3).
- **DOC-19**: Martin Fowler, "Eradicating Non-Determinism in Tests" (2011) — quarantine non-deterministic tests and fix them. Feeds: §7 (REL-4), §8 (R-4, A-11).
- **DOC-20**: Dan North, "Introducing BDD" (2006), and the Gherkin Given/When/Then vocabulary. Feeds: §4 (KD-1), §8 (A-10).
- **DOC-21**: Semantic Versioning 2.0.0 — backward-compatible additions release as a minor version. Feeds: §3, §6.5.
