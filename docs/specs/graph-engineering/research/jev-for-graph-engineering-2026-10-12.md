# Jev for Graph Engineering — 2026-10-12

An assessment of where Jev, TypeSafe AI's typed decision model, can improve the decision edges of dotbabel's multi-agent graph, and where it must not be used.

## Scope

**Included:** Jev's documented interface, independent and secondary descriptions of it, the Jev triage experiment in this repository, and the decision points in dotbabel's review, conductor, fleet, and model-intelligence flows. Builds on [`graph-engineering-state-of-art-2026-10-12.md`](graph-engineering-state-of-art-2026-10-12.md).

**Excluded:** any Jev output. No request was sent. Every fit rating below is a hypothesis until a locked experiment measures it.

## Findings

### 1. What Jev is, from evidence

| Item                         | Status                     | Details                                                                                                                                                                                                                                                                                                                   |
| ---------------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Output type                  | Typed answers, no text     | `Choice` returns `choice`, `probabilities`, `confidence`. `Score` returns `score`, `probabilities`, `confidence`. `Noul` returns only a 0-1 value ([TypeSafe docs](https://docs.typesafe.ai/introduction)).                                                                                                               |
| Intended shape of a question | One narrow decision        | "System One models work best when each question asks one specific, well-scoped thing". Extended reasoning should be split into questions combined in code (TypeSafe docs).                                                                                                                                                |
| Fit as a router              | Plausible, vendor-adjacent | Jev can "classify the request's intent as a Choice, score its complexity as a Score", and choose a tool, a subagent, or continue, retry, ask, or stop. The caller still owns policy, the record, and the fallback ([Paper Compute](https://papercompute.com/concepts/jev/), a gateway vendor with a commercial interest). |
| Accuracy                     | Unmeasured                 | "Picking the wrong valid option remains possible", and "Jev is not independently benchmarked yet" (Paper Compute). The vendor publishes no calibration data (`docs/experiments/2026-10-12-jev-finding-triage.md:113`).                                                                                                    |
| Cost                         | Negligible                 | The whole pooled review set costs an estimated $0.07-$0.15 (`docs/experiments/2026-10-12-jev-finding-triage.md:85`).                                                                                                                                                                                                      |
| Data handling                | Third party                | Every question sends its state to `api.typesafe.ai` (`docs/experiments/2026-10-12-jev-finding-triage.md:92`).                                                                                                                                                                                                             |

### 2. Where Jev fits in the graph

In graph terms, Jev is a candidate **router node**: it picks the outgoing edge where today an LLM or a fixed heuristic picks it. It is not a coordination primitive. The ranking below puts first the edges where a wrong answer is cheap and a locked rule can measure it.

| Rank | Graph edge                                                              | Today                                                | Jev question                                                      | Fit                  | Evidence                                                                                                                                                                                                                 |
| ---- | ----------------------------------------------------------------------- | ---------------------------------------------------- | ----------------------------------------------------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1    | Review triage: auto-valid, auto-false-positive, or full validation      | Full LLM validation for every non-mechanical finding | `Noul`: is this finding a real defect                             | High, measurable now | Harness and locked rule exist (`docs/experiments/2026-10-12-jev-finding-triage.md:11-35`). Edge defined at `skills/review-pr/SKILL.md:83-89`.                                                                            |
| 2    | Workload-class router: which model tier runs a task                     | Static class per agent and skill                     | `Choice` over mechanical, routine, deep, frontier, exceptional    | High                 | The classes are already defined (`docs/specs/model-intelligence/spec/3-high-level-architecture.md:75`). This is Paper Compute's "semantic routing" case.                                                                 |
| 3    | Conductor retry edge: retry, fix, or ask the owner after a failed phase | A fixed attempt cap per phase                        | `Choice` over flaky, real defect, environment, on the failure log | Medium               | The cap is read from config (`plugins/dotbabel/src/pr-gates.mjs:213-235`). Jev may pick the edge inside the cap, never raise it.                                                                                         |
| 4    | Reviewer dispatch router: which review agents run                       | First matching size and path rule                    | `Choice` with probabilities over review profiles                  | Medium-low           | The rules are cheap and auditable (`skills/post-pr-review/SKILL.md:112-126`). Jev could only add a reviewer, never drop `security-auditor`, which is in every profile on purpose (`skills/post-pr-review/SKILL.md:128`). |
| 5    | Planning edges: does task A have to land before task B                  | No dependency field exists                           | `Noul` over two task contracts                                    | Low                  | Produces proposals for the missing `depends_on` field (previous audit, WARNING 1). Cross-task reasoning is the kind of question the vendor says to decompose.                                                            |

### 3. Where Jev must not be used

| Edge                                                         | Why not                                                                                                                                                                                         | Evidence                                                                                    |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| File claims, merge token, topological merge order, CPU lanes | A deterministic answer already exists and is exact. A model adds error and a network dependency.                                                                                                | `docs/fleet.md:25-65`, `docs/fleet.md:444-449`, `plugins/dotbabel/src/pr-stack.mjs:445-446` |
| Any input to a gate that skips verification                  | An agent requests the answer and records it, so the result is agent-asserted. That is the forgery class the unforgeable-evidence spec closes: a forged evidence comment "removes verification". | `docs/specs/unforgeable-evidence/spec/1-problem-motivation.md:20`, `:29`, `:37`             |
| Hook-time decisions in `PreToolUse`                          | A network call in a hook adds an outage path to every edit. The fleet hooks fail open by design and already cost 0.6-0.8 s of Node startup each.                                                | `docs/fleet.md:166-176`                                                                     |

## Issues

| Severity | Issue                                                                                                                   | Location                                                             | Recommendation                                                                                                                                   |
| -------- | ----------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| WARNING  | No Jev answer has been measured, and `Noul` returns no confidence. Every fit rating above is unproven.                  | `docs/experiments/2026-10-12-jev-finding-triage.md:3`                | Finish the triage run first. Adopt a new edge only after its own locked rule, and run it in shadow mode first, as the experiment plans (`:134`). |
| WARNING  | A Jev answer used as gate evidence would reopen the agent-asserted evidence path.                                       | `docs/specs/unforgeable-evidence/spec/1-problem-motivation.md:20-37` | Keep Jev advisory. It may route work to more or less validation, never past a gate.                                                              |
| WARNING  | Each new edge sends new state to a third party: task text, failure logs, file paths.                                    | `docs/experiments/2026-10-12-jev-finding-triage.md:92`               | Get per-repository approval for each edge, as for the triage run. Send failure logs only after secret scrubbing.                                 |
| INFO     | The experiment harness already does batching, backoff, resume, a bootstrap by pull request, and a locked decision rule. | `docs/experiments/jev-finding-triage/lib.mjs:524-588`                | Reuse it for edges 2 and 3 instead of building a new harness.                                                                                    |
| INFO     | No decision record or fallback is defined for a live Jev edge.                                                          | `plugins/dotbabel/src/run-receipt.mjs:2-7`                           | Log each Jev band and the edge it chose in the run receipt. Fall back to today's rule when the API fails.                                        |

## Summary

Jev can improve graph engineering only as a router on judgment edges: review triage, workload-class routing, and the conductor's retry choice are the best candidates. It adds nothing to the coordination primitives, which are already deterministic, and it must never count as evidence for a gate skip. The recommended next action is to finish the triage experiment, which waits only on the 125 hand labels, and to reuse its harness for workload-class routing if it reaches ADOPT.

## Sources

- [TypeSafe AI, Introduction](https://docs.typesafe.ai/introduction)
- [Paper Compute, What Is Jev](https://papercompute.com/concepts/jev/)
- [TypeSafe AI home](https://typesafe.ai/)
- `docs/experiments/2026-10-12-jev-finding-triage.md`
- [`graph-engineering-state-of-art-2026-10-12.md`](graph-engineering-state-of-art-2026-10-12.md)
