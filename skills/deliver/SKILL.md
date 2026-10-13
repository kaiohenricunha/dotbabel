---
id: deliver
name: deliver
type: skill
version: 1.0.0
domain: [devex]
platform: [github-actions]
task: [testing, review]
maturity: draft
owner: "@kaiohenricunha"
created: 2026-10-13
updated: 2026-10-13
description: >
  Take one task contract (goal, inputs, constraints, done_when) from a prompt to
  a reviewable pull request in one run: test first, implement, prove the change
  works by running it, review the diff once, and open the pull request with the
  proof. CI on the head is the merge evidence. No review rounds, no local
  attestation, no merge. Triggers on: "deliver this", "implement this issue",
  "build this and open a PR", "take this task to a PR", or a task contract with
  a goal and done_when.
argument-hint: "<task contract as JSON or prose> [--draft]"
user-invocable: true
disable-model-invocation: false
headless_safe: true
---

Take one task from its contract to a reviewable pull request, back to back. The proof that the change works is part of the deliverable, not a later phase. Review rounds, `/pr-conductor`, and `local-attest` are not steps of this flow: the user runs them on demand.

Trigger: when the user gives a task and asks for it to end in a pull request, in prose or as a contract such as:

```json
{
  "goal": "ship the feature",
  "inputs": ["issue", "repository", "design"],
  "output": "reviewable pull request",
  "constraints": ["no schema changes", "preserve public API"],
  "done_when": ["tests pass", "visual check passes", "review passes"]
}
```

Arguments: `$ARGUMENTS`

- `<contract>` — the task, as JSON or prose.
- `--draft` — open the pull request as a draft.

**Consent.** The user's prompt starts this skill, and a prompt that asks for a pull request is the consent to push the task's branch and open its pull request. That consent covers this one task. This skill never merges: merging stays an explicit instruction, handed to `/merge-pr`.

## 1. Read the contract

Normalize the contract to five fields:

| Field         | Meaning                                    | If absent                                         |
| ------------- | ------------------------------------------ | ------------------------------------------------- |
| `goal`        | the change                                 | ask one question; with no goal there is no task   |
| `inputs`      | the issue, design, files, or links to read | read what the prompt names                        |
| `output`      | what the run ends with                     | a reviewable pull request                         |
| `constraints` | what the change must not do                | none beyond the rule floor                        |
| `done_when`   | the checks that make the task done         | `tests pass`, `the feature runs`, `review passes` |

Record it, so a later session can resume the task:

```bash
dotbabel task new <slug> --goal "<goal>" --done-when "<item>" ... --constraint "<item>" ...
```

Skip the record when `dotbabel` is not installed, and say so in the report.

## 2. Map every item to a check

Before you write code, give each `done_when` item and each constraint one mechanical check and the evidence it produces:

| Item                | Check                                                                              | Evidence                         |
| ------------------- | ---------------------------------------------------------------------------------- | -------------------------------- |
| tests pass          | the new tests, plus the existing tests that cover the changed code                 | the command and its last lines   |
| the feature runs    | step 6 below                                                                       | the command and its output       |
| visual check passes | `/run` the app, open the changed screen, take a screenshot                         | the screenshot and what it shows |
| review passes       | step 8 below                                                                       | findings found, fixed, answered  |
| no schema changes   | `git diff --stat origin/main...HEAD -- <schema paths>` is empty                    | the empty output                 |
| preserve public API | the diff of exports, CLI flags, `bin` entries, and endpoints is empty or only adds | that diff                        |
| criteria pass       | `dotbabel criteria verify --pr <N> --post`                                         | the evidence comment             |

An item you cannot map to a check is not done. Write it in the proof as unverified, with the reason. Never tick it.

## 3. Ground and isolate

1. Read the inputs and the code the goal touches. Cite `file:line` for each claim.
2. If the contract has two readings that lead to different code, ask one question. Otherwise state the reading you chose and continue.
3. Create a worktree from the latest `origin/main` under `.claude/worktrees/<slug>/`, per the rule floor. Where `dotbabel fleet` runs, claim the paths you will edit.

## 4. Plan

Write at most five bullets in the form `Step → verify: <check>`. Do not wait for approval: the contract is the approval. Stop only for an ambiguity that changes the result, or for a constraint that the goal cannot meet.

## 5. Test first, then implement

1. Write the tests for each behavior: unit tests, and integration tests where the change crosses a process, file, network, or database boundary. Include a negative case and a boundary case.
2. Run them and see them fail for the right reason.
3. Implement until they pass. Keep to the constraints.

## 6. Prove it works

Run the feature the way a user does. Choose by the surface the change has:

| Surface     | Run                                                                    |
| ----------- | ---------------------------------------------------------------------- |
| CLI         | the command with real arguments, in a temporary directory if it writes |
| library     | a short script that calls the public function                          |
| server, API | start it, call the endpoint, read the response                         |
| UI          | `/run` the app, open the changed screen, take a screenshot             |
| docs only   | run each command the changed text shows, and check each link it adds   |
| none        | write `N/A — <reason>`: a pure refactor that the tests already cover   |

Record each command and the last ten lines of its output. A run that fails is a bug: fix it, and add the test that would have caught it.

## 7. Check the constraints

Run the check from step 2 for each constraint. A constraint that fails stops the task: report it rather than weaken it.

## 8. Review once

Run one review of the branch diff: `/code-review` on the changed files, or `/quality-review` where the project has a dotbabel quality policy. Fix each correct finding. Answer each wrong one in the proof, in one line. Do not post review comments, and do not start review rounds: `/post-pr-review`, `/review-pr`, and `/pr-conductor` run only when the user asks.

## 9. Open the pull request

1. Commit with conventional messages. Do not add `[skip ci]`: CI on the head is the merge evidence.
2. Push the branch and open the pull request with `gh pr create --body-file <file>` (add `--draft` for `--draft`).
3. Write the body with these sections, in this order:
   - `## Summary` — one to three bullets.
   - `## Test plan` — a checklist; tick only the items you ran.
   - `## Proof` — the format below.
   - `## Spec ID` or `## No-spec rationale` — last, when the project uses specs or the change touches a protected path.
4. If a linked spec declares active criteria, run `dotbabel criteria verify --pr <N> --post` from the worktree at the pull request head. A failing criterion is a failing `done_when` item.

The `## Proof` section:

````markdown
## Proof

| done_when         | Check                                | Result                       |
| ----------------- | ------------------------------------ | ---------------------------- |
| tests pass        | `npx vitest run tests/foo.test.mjs`  | 14 passed                    |
| the feature runs  | `dotbabel foo --bar baz`             | prints `3 items`, exit 0     |
| no schema changes | `git diff --stat main... -- schemas` | empty                        |
| review passes     | `/code-review` on the diff           | 3 found, 2 fixed, 1 answered |

<details><summary>Feature run</summary>

```text
$ dotbabel foo --bar baz
...
```

</details>
````

## 10. Wait for CI

Run `gh pr checks <N> --watch`. Fix a red check on the branch with a new commit, and repeat step 6 when the fix changes behavior. After three failed fixes for one check, stop and report it.

## 11. Report

Give the completion status: the `done_when` table with each result, the pull request link, and the CI state. Close the task record with `dotbabel task close <slug>`. Name the next step: `/merge-pr <N>` when the user says merge, or a review the user may want to run on demand.

## Rules

- The proof is the contract. Never tick a `done_when` item or a test-plan item without evidence in the pull request body.
- One review pass. No review fleet, no comment rounds, no local attestation, unless the user asks.
- Never weaken a test, a check, a constraint, or a threshold to reach done.
- Never add `[skip ci]` to the head commit.
- Never merge, and never force-push.
- Stop and ask only for: an ambiguity that changes the result, a constraint the goal cannot meet, a check that stays red after three fixes, or a destructive action.
