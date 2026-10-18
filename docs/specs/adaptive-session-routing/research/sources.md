# Research Sources

Checked 2026-10-16/17. Exact installed versions: Claude Code 2.1.302; Codex CLI 0.163.0. These are observations, not minimum compatibility promises.

- **DOC-1:** Owner assignment `2a2431bf-6f1e-4b66-aeb4-4c8782304813/pasted-text-1.txt`, sections 1–14. Feeds all sections.
- **DOC-2:** [Codex App Server](https://learn.chatgpt.com/docs/app-server), configuration and turns. `turn/start` accepts model and effort; supplied overrides become defaults for subsequent turns. `turn/steer` does not accept these overrides. `model/list` supplies native effort options. Feeds §3, §5, §6.
- **DOC-3:** [Claude mods overview](https://code.claude.com/docs/en/plugins/mods), [events](https://code.claude.com/docs/en/plugins/mods/events) and [reference](https://code.claude.com/docs/en/plugins/mods/reference). Mods provide middleware inside Claude Code; `turn.step` can replace a request model, identifies subagents, and returns response usage. Exact effort/provenance support still needs installed-type and real-runtime validation. Feeds §3, §5, §6, §8.
- **DOC-4:** Existing [resolver contract](../../model-intelligence/spec/5-interfaces-apis.md#resolver-contract) and [implementation plan](../../model-intelligence/spec/6-implementation-plan.md). Feeds §3–§6.

A generated RPC object or a successful parser check alone is not evidence of a real effective configuration. No additional inference-based classifier was selected or called during this research.
