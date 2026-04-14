# Architectural Decision Records

Short, immutable records of load-bearing decisions. Every file captures:

- **Context** — what forced the decision
- **Decision** — what we chose
- **Consequences** — what we gave up, what we unlocked
- **Alternatives** — what we looked at and rejected

Supersession is fine; amendment is not. To reverse a decision, write a new
ADR that supersedes the old and link both directions.

## Index

| #    | Title                                                                  | Status   |
| ---- | ---------------------------------------------------------------------- | -------- |
| 0001 | [Monorepo dual-persona layout](./0001-monorepo-dual-persona-layout.md) | Accepted |
| 0002 | [No TypeScript](./0002-no-typescript.md)                               | Accepted |
| 0012 | [Structured error contract](./0012-structured-error-contract.md)       | Accepted |
| 0013 | [Exit-code convention](./0013-exit-code-convention.md)                 | Accepted |
| 0014 | [CLI ✓/✗/⚠ output format](./0014-cli-tick-cross-warn-format.md)        | Accepted |

### Planned (not yet written)

Stub records exist in the issue tracker; they will land as additional ADRs
when a related change is proposed:

- 0003..0006 SEC-1..4 hardening decisions (enforced today in
  `plugins/harness/scripts/validate-settings.sh`; the ADRs capture the
  _why_).
- 0007..0008 OPS-1..2 hardening decisions (same).
- 0009 LSP plugins owned by `claude-code-lsps`.
- 0010 `context7` runs globally.
- 0011 Project-bound MCPs live in the project.

The gap in numbering (0003..0011) is intentional — numbers are stable
identifiers, not sequential counters.
