# P-19e skill compute decisions

Status: **approved by the owner** on 2026-10-20 ("Approve all three").

## Why a decision is required

IMPL-7 (`6-implementation-plan.md:777`) applies only to the DOC-1 class-F entries. These skills
follow the same principle: a semantic requirement is never guessed. Three skills postdate the
migration audit (`docs/audits/model-selection-audit.md`), so no audit row classifies them, and
the owner chose their requirements:

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
`unknown`. These decisions do not claim measured quality rankings.

## Scope against the plan

The plan defines P-19e as `post-pr-review`, `agents-search` and the `veracity-audit` topology
(`6-implementation-plan.md:558`). This unit migrates `post-pr-review` from that list. The three
other skills are outside the plan list; they join this unit because they are the remaining
unmigrated skills with an owner decision. Still open from P-19e: the `agents-search` taxonomy
redesign (F3), which changes the skill body and gets its own unit, and the `veracity-audit`
coordinator/worker topology check. The spec migration mapping does not yet name the three new
skills; adding them there is a spec change that needs owner approval.
