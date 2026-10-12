# Experiment: Jev as a triage gate for review findings — 2026-10-12

**Status: NOT RUN.** The harness and the dataset extraction are ready. The replay needs two things that this work does not have: the owner's approval to send review text and diff hunks to TypeSafe AI, a third party, and a `TYPESAFE_API_KEY`. Nothing in this document is a Jev result.

## Question

`/review-pr` step 3 sends every finding outside the mechanical categories to a full LLM validation (`skills/review-pr/SKILL.md:89-95`). Can Jev, a typed decision model, take that decision for part of the findings without dropping real defects?

Jev returns a typed answer with probabilities, not text. A `noul` question returns the probability that a statement is true (`POST https://api.typesafe.ai/v1/systemone`). The experiment asks Jev one `noul` per finding, "is this finding a real defect", and compares the answer with the verdict that `/review-pr` already gave.

## Decision rule (locked before any Jev output)

The rule is in `lib.mjs` as `DECISION_RULE`, and `analyze.mjs` applies it. I set it after the extraction counted the labels and before any Jev output existed. No threshold depends on a Jev answer.

The **primary set** is every finding with a `valid` or `false_positive` verdict, outside the mechanical categories (`style`, `comment`, `type`). Those three take the fast path under `--conductor` and get no independent validation (`skills/review-pr/SKILL.md:83-89`). A finding that does not state its category could not take the fast path, so it stays in.

1. **Sample floor.** The primary set has at least 100 findings and at least 30 false positives. If not, the result is INCONCLUSIVE and nothing is adopted.
2. **Agreement.** Cohen's kappa between `noul ≥ 0.5` and the verdict is at least 0.6. Kappa, not accuracy: the data is 98% `valid`, so a model that always says "valid" has 98% accuracy and a kappa of 0.
3. **Triage at hi = 0.9, lo = 0.1.** `noul ≥ 0.9` is auto-valid, `noul ≤ 0.1` is auto-false-positive, and anything between keeps the full validation. A `critical` finding is never auto-decided. Triage counts only findings that state a severity, because one that does not could be critical. On those findings:
   - wrong auto-decisions are at most 2%,
   - real defects auto-dismissed (a `valid` finding at `noul ≤ 0.1`) are at most 0.5%, because that error drops a defect and the other only costs a needless fix,
   - at least 20% of findings are auto-decided. Less saves too little to wire.
4. **ADOPT** only if 1 to 3 all hold. Otherwise REJECT. The threshold sweep in the report informs a later experiment. It never changes this decision.

## Environment

- **Data:** pull request review comments from the GitHub REST API, read on 2026-10-12. dotbabel is public. squadranks is private.
- **Tools:** Node v22.22.2, gh 2.89.0. The harness has no dependencies.
- **Model, when run:** `jev-latest` (the docs example answered as `jev-1.13.0`). Output is free. Input costs $0.042 per million tokens on the TypeSafe launch post and $0.084 on a third-party listing, so the estimates below use both.

## Dataset (counts only)

`extract.mjs` finds each comment that carries the `post-pr-review:v1:<16 hex>` marker and pairs it with the first reply in its thread. The verdict comes from the opening words of that reply: `Fixed in …` is `valid`, `False positive. …` is `false_positive`, and an opening the rules do not know is `unknown`. `deferred` counts as `valid`: the reply agrees the defect is real and postpones the fix.

| Repository           | Findings | PRs | valid | false positive | unknown | Primary | Primary false positive |
| -------------------- | -------- | --- | ----- | -------------- | ------- | ------- | ---------------------- |
| dotbabel (public)    | 418      | 43  | 361   | 13             | 44      | 347     | 12                     |
| squadranks (private) | 1571     | 204 | 1419  | 22             | 130     | 1345    | 21                     |
| pooled               | 1989     | 247 | 1780  | 35             | 174     | 1692    | 33                     |

- Findings are dated 2026-05-08 to 2026-10-11.
- `unknown` verdicts: 58 have no reply, 96 have an opening the rules do not match, and 20 are partial ("Partly fixed in …"). All are outside the primary set.
- The comment rendering changed over time, so some comments do not state every field. Of the pooled findings, 468 state no severity and 1376 state no category. The contract fixes the fields, not the rendering (`skills/post-pr-review/references/agent-contract.md`). 124 findings are mechanical and outside the primary set.
- Of the primary set, 47 findings are `critical`, and 1274 state a severity.

**dotbabel alone is INCONCLUSIVE by construction.** It has 12 false positives against a floor of 30. Only the pooled set clears the floor, and only narrowly (33). A pooled run uploads code from a private repository.

## Method

1. `extract.mjs` reads every review comment of a repository with one paginated `gh api` GET and writes findings as JSONL to a temporary directory.
2. `replay.mjs` builds one request for each finding. The state is the file path, the title, the body, and the last 60 lines of the diff hunk. It never contains the posted severity, category, or agent, because two questions ask Jev to predict them:
   - `real_defect` (`noul`): is the finding correct about the diff?
   - `category` (`choice`): the nine categories of the agent contract.
   - `severity` (`score`): suggestion, important, critical.
3. `analyze.mjs` joins the answers to the findings and reports agreement, a reliability table, Brier score and expected calibration error, the triage simulation, a threshold sweep, and the decision.

Requests are about 1,000 input tokens at the median and 9,334 at the maximum, far below the 64k context.

## Cost

| Run                   | Requests | Input tokens (estimate) | Cost        |
| --------------------- | -------- | ----------------------- | ----------- |
| dotbabel, primary set | 347      | 397k                    | $0.02–$0.03 |
| pooled, primary set   | 1692     | 1.79M                   | $0.08–$0.15 |
| pooled, every finding | 1989     | 2.11M                   | $0.09–$0.18 |

The estimate is four characters per token. The launch post says the team cannot prove that its prices are not subsidized, and that prices may change.

## Privacy

A run sends each finding's text and a diff hunk to `api.typesafe.ai`. For dotbabel that is public text. For squadranks it is code and review text from a private repository. The owner decides each repository separately. `replay.mjs` sends nothing unless it gets both `--send` and `TYPESAFE_API_KEY`, and it prints a warning before it sends. The extracted JSONL holds review text, so it goes to a temporary directory and stays out of the repository.

## Limits of the evidence

- **The verdict is not ground truth.** It is the disposition that the review pipeline and the owner gave. A finding that was cheap to fix may be marked `Fixed` without being a real defect. Agreement with the verdict measures agreement with this pipeline, not correctness.
- **False positives are rare,** so their estimates are wide. With 33, one wrong auto-dismissal moves its rate by 3 points.
- **The verdict rules are text matches** on the first reply. `lib.test.mjs` pins each rule against openings seen in these repositories.
- **The vendor publishes no calibration data.** Its confidence page calls `confidence` "one reasonable way to summarize a distribution", and the Defapi model listing says "type safety does not guarantee correctness". The launch post's speed and cost claims come from its own workflows. The reliability table is the check this experiment adds.

## Reproduce

```bash
cd docs/experiments/jev-finding-triage
node --test lib.test.mjs
node extract.mjs --repo kaiohenricunha/dotbabel --out /tmp/jev/findings.jsonl
node replay.mjs --in /tmp/jev/findings.jsonl --primary-only > /tmp/jev/requests.jsonl   # dry run, sends nothing
# Only after the owner approves the upload:
TYPESAFE_API_KEY=... node replay.mjs --in /tmp/jev/findings.jsonl --primary-only --send --out /tmp/jev/answers.jsonl
node analyze.mjs --findings /tmp/jev/findings.jsonl --answers /tmp/jev/answers.jsonl
```

To pool repositories, run `extract.mjs` for each one and concatenate the JSONL files. Each record carries its `repo`.
