# §8 — Risks and Alternatives

> Known risks with mitigations, rejected approaches with reasoning.

## Risks

| ID   | Risk                                                                       | Likelihood | Impact | Mitigation                                                                                                                                                        |
| ---- | -------------------------------------------------------------------------- | ---------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R-1  | A test filter matches zero tests and exits 0, which looks like a pass      | High       | High   | KD-3 and REL-1. P-B1 test: `marks a criterion unconfirmed when the command exits 0 but a named test is missing from the output`                                   |
| R-2  | An untrusted commenter forges evidence                                     | Medium     | High   | KD-2 and SEC-3. P-B3 test: `fails with CRITERIA_EVIDENCE_UNTRUSTED when only an untrusted author posted the marker`                                               |
| R-3  | Evidence from an older commit passes the gate after a new push             | Medium     | High   | REL-2. P-B3 test: `fails with CRITERIA_EVIDENCE_STALE when evidence is pinned to an older commit`                                                                 |
| R-4  | Flaky criterion tests block merges and tempt people to retry until green   | Medium     | Medium | REL-4 forbids retries. The `/detect-flaky` skill diagnoses the test, and a flaky test is quarantined with a tracking issue (`agents/test-engineer.md:51`, DOC-19) |
| R-5  | The AI test-quality judgment is wrong, or content in a test steers it      | Medium     | Medium | KD-4 keeps it advisory. SEC-5 and SEC-6 limit it, and TEST-3 requires the P-B4 eval to pass before release                                                        |
| R-6  | A renamed test leaves a criterion pointing at a name that no longer exists | High       | Low    | The `error` status names the missing test, the spec edit ships in the same pull request, and the `validate-spec` audit checks criteria in Phase 4                 |
| R-7  | Authors write weak criteria that restate the implementation                | Medium     | Medium | P-A2 guidance in the `spec` skill, owner review in each spec session, and the mutation score backstop (KD-7)                                                      |
| R-8  | The current Stryker parser does not match real reports                     | High       | Medium | P-C4 replaces it and tests it against a captured real report (TEST-2)                                                                                             |
| R-9  | Mutation runs take too long for pull request time                          | High       | Low    | Mutation plans run only in `deep` (`docs/quality.md:199`), and scoring covers changed lines only (REL-11)                                                         |
| R-10 | Wrong path globs silently skip a regression tool                           | Medium     | High   | REL-9 makes every skip visible as `not_triggered` in the report                                                                                                   |
| R-11 | `critical_paths` escalation makes the pre-push hook slow                   | Medium     | Low    | PERF-4 bounds the check, and a timeout allows the push                                                                                                            |
| R-12 | A smoke check causes side effects in production                            | Low        | High   | REL-8 and SEC-8. Only GET checks retry, command checks run once, and the docs require read-only or idempotent journeys                                            |
| R-13 | An automatic rollback surprises operators                                  | Low        | High   | KD-13 and SEC-12. The skill recommends `/rollback-prod` and never invokes it. P-E2 test: `smoke-test: recommends /rollback-prod on failure and never invokes it`  |
| R-14 | Secrets in test output leak into a pull request comment                    | Medium     | High   | SEC-4 redacts before posting, and OPS-3 truncates. P-B1 test: `truncates each output tail to 40 lines and 2000 characters after redaction`                        |
| R-15 | GitHub API rate limits interrupt comment reads                             | Low        | Low    | PERF-3 uses 1 paginated read for each gate run                                                                                                                    |
| R-16 | Consumers never adopt the optional criteria                                | High       | Medium | The `spec` skill writes criteria by default (P-A2), the `validate-spec` audit reports missing criteria, and the CI template runs verification when criteria exist |
| R-17 | A hostile repository runs code through the new hooks or CI templates       | Low        | High   | SEC-1 and SEC-10 trust gates, and SEC-7 allows `pull_request` only                                                                                                |
| R-18 | A crafted JUnit report attacks the XML parser                              | Low        | High   | SEC-11. P-B1 test: `rejects a JUnit report that declares a DOCTYPE`                                                                                               |

## Rejected Alternatives

- **A-1 — A new `pr-conductor` phase for criteria.** It changes a phase order that a bats test locks and that `dotbabel pr-stack phases` prints, for no gain over a step inside `review-pr` (Q-3).
- **A-2 — A required `acceptance_criteria` field.** It fails validation for 37 of the 38 surveyed specs on upgrade (Q-5, DOC-13).
- **A-3 — A mutation runner bundled with dotbabel.** It breaks the rule that `dotbabel quality` never installs a checker (Q-4, `docs/quality.md:5`).
- **A-4 — A data comparison tool owned by dotbabel.** Data formats vary, and each repository already knows what a bad data change looks like (Q-2).
- **A-5 — SLO checks in this spec.** They need a metrics backend that no dotbabel feature has, so they move to a follow-up spec (Q-1).
- **A-6 — Evidence in the pull request body.** Anyone who can edit the body can forge the evidence, and the body has no author to check.
- **A-7 — Commit statuses or check runs for evidence.** A commit status carries only a short description, which has no room for per-test results, and a check run needs a GitHub App identity that dotbabel does not use.
- **A-8 — A model verdict for criteria.** Model output varies between runs and can be steered by the content it reads (KD-4, DOC-17).
- **A-9 — Commands derived from test names.** Each runner filters tests differently, so dotbabel would need per-runner logic and would have to guess (KD-1).
- **A-10 — Gherkin feature files with Cucumber step definitions.** They add a runner and glue code. Separate `given`, `when`, and `then` fields keep the vocabulary without that tooling (DOC-20).
- **A-11 — Automatic retries for failing criteria.** A retry until green hides a non-deterministic test instead of fixing it (DOC-19).
- **A-12 — CI posts the evidence comment.** The CI identity is not a trusted association by default, and a second writer races the local run. CI keeps its report as an artifact (KD-10).
- **A-13 — Exit code as the only verdict.** A filter that matches no test exits 0 (R-1, KD-3).
