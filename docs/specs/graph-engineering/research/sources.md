# Research Sources

> Indexed documents feeding into this spec. Each tagged with which sections it informs.

<!-- Format:
- **DOC-N**: {title} — {one-line description}. Feeds: §N, §N.
-->

- **DOC-1**: Xu, Subramanian, Karthik (2026), "AI Agent Pull Requests on GitHub: Frequency, Structure, and Merge Conflict Rates", [arXiv:2607.04697](https://arxiv.org/abs/2607.04697) — measured conflict rates of concurrent agent pull requests. Feeds: §1.
- **DOC-2**: `docs/fleet.md` — the fleet's claims, merge token, event feed, and CPU lanes, with their limits. Feeds: §1, §2, §4.
- **DOC-3**: `plugins/dotbabel/src/task-state.mjs` — the task contract and its per-worktree storage. Feeds: §1, §4, §5.
- **DOC-4**: `plugins/dotbabel/src/pr-stack.mjs` — the pull request stack graph and its topological plan. Feeds: §1, §4.
- **DOC-5**: `plugins/dotbabel/src/agents.mjs` — the registry of the six supported CLIs. Feeds: §1, §3.
- **DOC-6**: `skills/review-pr/SKILL.md` — the review triage step: the fast path and the full validation. Feeds: §1, §2.
- **DOC-7**: `docs/experiments/2026-10-12-jev-finding-triage.md` — the Jev triage experiment, its locked decision rule, and its status. Feeds: §1, §8.
- **DOC-8**: [`graph-engineering-state-of-art-2026-10-12.md`](graph-engineering-state-of-art-2026-10-12.md) — survey of graph-engineering practice, compared with the fleet. A copy of the audit written on 2026-10-12. Feeds: §1, §2.
- **DOC-9**: [`jev-for-graph-engineering-2026-10-12.md`](jev-for-graph-engineering-2026-10-12.md) — where Jev fits as a router, and where it must not be used. A copy of the audit written on 2026-10-12. Feeds: §2, §8.
- **DOC-10**: [`graph-engineering-wiring-2026-10-12.md`](graph-engineering-wiring-2026-10-12.md) — the three-layer shape and the genericity constraints. A copy of the audit written on 2026-10-12. Feeds: §1, §2, §3.
- **DOC-11**: TypeSafe AI, [Introduction](https://docs.typesafe.ai/introduction) — Jev's question types: `choice` and `score` return probabilities and a confidence, and `noul` returns a value from 0 to 1. Feeds: §5.
- **DOC-12**: [A2A Protocol specification](https://a2a-protocol.org/latest/specification/), version 1.0.0 — the `TaskState` values, with four terminal and two interrupted states. Feeds: §5.
- **DOC-13**: OpenTelemetry, [GenAI agent spans](https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/gen-ai-agent-spans.md) — the agent operations, with status Development. Feeds: §5, §8.
