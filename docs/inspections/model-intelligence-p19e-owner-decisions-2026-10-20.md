# P-19e skill compute decisions

Status: **approved by the owner** on 2026-10-20 ("Approve all three").

## Why a decision is required

IMPL-7 forbids a guessed semantic requirement. Three skills postdate the migration audit
(`docs/audits/model-selection-audit.md`), so no audit row classifies them:

- `skills/language-review/SKILL.md` (created 2026-10-15)
- `skills/security-audit/SKILL.md` (created 2026-09-22)
- `skills/smoke-test/SKILL.md` (created 2026-09-18)

`post-pr-review` needs no new decision. The audit classes its coordinator as C, Routine Engineering (`model-selection-audit.md`, "C for itself; D for the fleet").

## Approved requirements

| Skill             | Native controls kept | Requirement                | Reason                                                                                                      |
| ----------------- | -------------------- | -------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `language-review` | `opus`, `medium`     | dynamic, Deep, consumer    | Read-only editorial review across seven languages and their regional variants.                              |
| `security-audit`  | `opus`               | floor, Frontier, consumer  | Security coordinator with parallel hunters and independent verifiers; matches the security floors of P-19d. |
| `smoke-test`      | `sonnet`, `medium`   | dynamic, Routine, consumer | Runs the smoke checks that a repository declares, and reports the result.                                   |
| `post-pr-review`  | `sonnet`, `medium`   | dynamic, Routine, consumer | Audit class C coordinator. The fleet cost prose (class D) stays unchanged in this unit.                     |

## Limits

Each migration keeps the authored native `model` and `effort`, every body byte, and all tools.
Skill model and effort metadata have no verified native binding, so resolver enforcement stays
`unknown`. These decisions do not claim measured quality rankings. The `agents-search` taxonomy
redesign (F3) is a separate unit because it changes the skill body.
