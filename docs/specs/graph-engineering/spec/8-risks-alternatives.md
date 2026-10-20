# §8 — Risks and Alternatives

> Known risks with mitigations, rejected approaches with reasoning.

## Risks

<!-- Tag each as R-N -->

| ID   | Risk                                                                                                                                                                                        | Likelihood | Impact | Mitigation                                                                                                                             |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| R-1  | `linked_paths` spans task, fleet, and review code. Once the spec is approved, a pull request that touches those files needs this spec or a `No-spec rationale` (`docs/specs/README.md:53`). | High       | Medium | `linked_paths` holds only the files of the phase in progress, and grows when each phase starts (§2 Boundaries). Decided on 2026-10-12. |
| R-2  | Phase 3 is designed before the Jev triage experiment has a result (`docs/experiments/2026-10-12-jev-finding-triage.md:3`).                                                                  | Medium     | Low    | Shadow mode until the step's experiment returns ADOPT (KD-9). No step is adopted (DOC-15).                                             |
| R-3  | The 2-0 research may find that most CLIs lack the hooks or the session registry that Phase 2 needs. The agent registry records no hook support today (`plugins/dotbabel/src/agents.mjs`).   | High       | Medium | Support states (ARCH-4) and the doctor report. Phases 1 and 3 work on every CLI anyway, because they are CLI commands.                 |
| R-4  | Jev comes from one vendor in early access, and its prices may change (`docs/experiments/2026-10-12-jev-finding-triage.md:88`).                                                              | Medium     | Low    | A vendor-neutral `decide` (KD-5), and the built-in fallback (REL-1).                                                                   |
| R-5  | The OpenTelemetry agent conventions are still in development, and their names may change (DOC-13).                                                                                          | High       | Low    | Each export file names the convention version it follows (§5).                                                                         |
| R-6  | Closed: the merge-verification work that edited `plugins/dotbabel/bin/dotbabel-pr-stack.mjs` and `schemas/dotbabel.config.schema.json` shipped as #465 (`94b2797`) before unit 3a.          | Low        | Low    | None needed: 3a edits both files on top of `main` (§2, §6.1).                                                                          |
| R-7  | Schema version 2 breaks an older dotbabel that reads the same task files.                                                                                                                   | Low        | Low    | The session-start hook fails open, and §6.6 gives the recovery.                                                                        |
| R-8  | Two clones of one repository on one machine can use the same slug, because KD-4 checks uniqueness per clone only.                                                                           | Low        | Low    | The graph reports an ambiguous reference instead of choosing a clone (§5).                                                             |
| R-9  | A queue head that is slow to retry loses its place after 10 minutes (REL-2).                                                                                                                | Medium     | Low    | It rejoins the queue on its next retry.                                                                                                |
| R-10 | In shadow mode, an adapter already sends the step's input to the vendor, before any adoption.                                                                                               | High       | Medium | Only with the repository's consent (KD-8), and only the step's input (SEC-3).                                                          |

## Rejected Alternatives

All were rejected on 2026-10-12.

- **A-1 — A write-through index file.** Two copies of the same data can disagree, and a crash between the two writes leaves the index stale (KD-1).
- **A-2 — Branch-qualified references, `<branch>:<slug>`.** A bare slug is simpler, and the uniqueness check reuses the worktree scan of KD-1 (KD-4).
- **A-3 — An advisory-only decider.** The model would still choose, so Phase 3 would save no work (KD-5).
- **A-4 — A merge queue that waits in `fleet-shell-prefix.sh`.** The agent's command would block until its turn and could hit the Bash tool's timeout (KD-6).
- **A-5 — A shared topological sort, with `pr-stack.mjs` refactored onto it.** Phase 1 would edit a tested module to share about 30 lines (KD-7).
- **A-6 — A user-scope switch for a model decider.** A contributor could send a private repository's code to a third party without the owner's consent (KD-8).
- **A-7 — An owner switch that enables a model adapter without an experiment.** Nothing would measure whether the adapter is right (KD-9).
- **A-8 — An opt-in push of spans to an OTLP endpoint.** It adds a network path, and files cover the need (KD-3).
- **A-9 — Model-tier routing in this spec.** The model-intelligence spec owns it as in-scope item 6 (§2).
- **A-10 — A general workflow engine.** dotbabel is the verification layer, and engines such as LangGraph exist (§2, DOC-8).
- **A-11 — Cross-repo references to pull requests only.** They would put a network call in the default path (ARCH-3, KD-2).
