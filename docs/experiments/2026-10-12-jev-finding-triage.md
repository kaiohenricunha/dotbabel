# Experiment: Jev as a triage gate for review findings — 2026-10-12

**Status: NOT RUN. Results: none.** The harness and the dataset extraction are ready. The replay needs three things that this work does not have: the owner's approval to send review text, file paths and diff hunks to TypeSafe AI, a third party; a `TYPESAFE_API_KEY`; and hand labels for the replies that the text rules cannot read. Nothing in this document is a Jev result. See [Status and next steps](#status-and-next-steps).

## Question

`/review-pr` step 3 sends every finding outside the mechanical categories to a full LLM validation (`skills/review-pr/SKILL.md:89-95`). Can Jev, a typed decision model, take that decision for part of the findings without dropping real defects?

Jev returns a typed answer with probabilities, not text. A `noul` question returns the probability that a statement is true (`POST https://api.typesafe.ai/v1/systemone`). The experiment asks Jev one `noul` per finding, "is this finding a real defect", and compares the answer with the verdict that `/review-pr` already gave.

## Decision rule (locked before any Jev output)

The rule is in `lib.mjs` as `DECISION_RULE`, and `analyze.mjs` applies it. `lib.test.mjs` pins every value and every boundary. I set the first version after the extraction counted the labels and before any Jev output existed. A review of that version showed that its triage gates did not test false-positive detection: a model that answers `noul = 0.95` for every finding passed all of them. No Jev output existed at that time either, so I changed the rule and locked it again on 2026-10-12. No threshold depends on a Jev answer.

**Sets.** Under `--conductor`, a comment takes the fast path only when it carries the marker, its author is the authenticated login, and its category is `style`, `comment`, or `type`. A `critical` finding never takes the fast path (`skills/review-pr/SKILL.md:83-89`). The extraction keeps only comments by the posting identity, so the author condition holds for every finding here. So a finding is **mechanical** when its category is one of the three and it is not `critical`. A finding that does not state its category cannot take the fast path, so it is not mechanical.

- The **primary set** is every finding that is not mechanical, has a `valid` or `false_positive` verdict, and has a usable Jev answer: no error and a `noul` in [0, 1]. A request that failed counts as failed, not as an answer.
- The **triage set** is the primary findings that state a severity. A finding that states none could be critical, so it stays on full validation.
- The **eligible set** is the triage findings that are not `critical`. Only these can be auto-decided.

**Rule.** Every bound below is inclusive.

1. **Sample floor.** The primary set has at least 100 findings, at least 30 of them false positives, and the eligible set has at least 20 false positives.
2. **Agreement.** Cohen's kappa between `noul ≥ 0.5` and the verdict, over the primary set, is at least 0.6. Kappa, not accuracy: the data is 98% `valid`, so a model that always says "valid" has 98% accuracy and a kappa of 0.
3. **Triage at hi = 0.9, lo = 0.1.** `noul ≥ 0.9` is auto-valid, `noul ≤ 0.1` is auto-false-positive, and anything between keeps the full validation. Each gate is a rate over the findings it applies to:
   - **(a) False positives auto-validated** are at most 25% of the false positives in the eligible set. Under `--conductor`, step 3 is the only stage that can reject a finding (`skills/review-pr/SKILL.md:89`), so an auto-validated false positive becomes a needless change.
   - **(b) Precision of the auto-false-positive band** is at least 80%: false positives at `noul ≤ 0.1` divided by all eligible findings at `noul ≤ 0.1`. If no finding is at `noul ≤ 0.1`, nothing is dismissed and this gate holds.
   - **(c) Real defects auto-dismissed** are at most 0.5% of the `valid` findings in the eligible set. This error drops a defect, so its cap is the tightest.
   - **(d) Auto-decided** findings are at least 20% of the triage set. Less saves too little to wire.

**Outcomes.**

- **INCONCLUSIVE** when item 1 fails. No other item is checked, and nothing is adopted.
- **REJECT** when item 1 holds and item 2 or any gate in item 3 fails.
- **ADOPT** when items 1 to 3 all hold.

**Point estimates decide.** `analyze.mjs` prints a 95% bootstrap interval beside each gate. The bootstrap resamples whole pull requests, 2,000 times with a fixed seed, because the findings on one pull request are not independent. A gate is **fragile** when its point estimate passes but its interval crosses the threshold. A gate on the interval bound cannot reach ADOPT at this size: the 25 eligible false positives sit in 17 pull requests, so the interval of gate (a) is wide for any model. A fragile gate therefore changes what ADOPT leads to (see [Status and next steps](#status-and-next-steps)), not the decision. The threshold sweep that `analyze.mjs` prints informs a later experiment. It never changes this decision.

## Environment

- **Data:** pull request review comments from the GitHub REST API, read on 2026-10-12. dotbabel is public. squadranks is private.
- **Tools:** Node v22.22.2, gh 2.89.0. The harness has no dependencies.
- **Model, when run:** `jev-latest` (the docs example answered as `jev-1.13.0`). Output is free. Input costs $0.042 per million tokens on the TypeSafe launch post and $0.084 on a third-party listing, so the estimates below use both.

## Dataset (counts only)

`extract.mjs` finds each comment that carries the `post-pr-review:v1:<16 hex>` marker and pairs it with the first reply in its thread. It keeps only comments by an allowlisted author, the repository owner by default, both for findings and for replies: the marker is public text that anyone can paste. The verdict comes from the opening words of that reply: `Fixed in …` is `valid`, `False positive. …` is `false_positive`, and an opening the rules do not know is `unknown`. `deferred` counts as `valid`: the reply agrees the defect is real and postpones the fix. An opening that agrees but declines the change in its first sentence, such as "Correct as written", is `unknown` (rule `ambiguous`).

| Repository           | Findings | PRs | valid | false positive | unknown | Primary | Primary false positive | Eligible false positive |
| -------------------- | -------- | --- | ----- | -------------- | ------- | ------- | ---------------------- | ----------------------- |
| dotbabel (public)    | 418      | 43  | 356   | 13             | 49      | 342     | 12                     | 10                      |
| squadranks (private) | 1571     | 204 | 1415  | 22             | 134     | 1325    | 21                     | 15                      |
| pooled               | 1989     | 247 | 1771  | 35             | 183     | 1667    | 33                     | 25                      |

The primary columns count findings before any Jev answer exists. The floor in rule item 1 counts only the findings with a usable answer, and `analyze.mjs` reports both numbers.

- Findings are dated 2026-05-08 to 2026-10-11.
- Every marker comment and every reply in their threads comes from the owner login, so the author filter removes nothing from this dataset. The `authors_seen` block in the `extract.mjs` output shows any other author.
- `unknown` verdicts: 58 have no reply, 96 have an opening the rules do not match, 20 are partial ("Partly fixed in …"), and 9 are ambiguous. All are outside the primary set.
- The severity comes only from a structured position: a leading `[…]` bracket, the first word of the header before a separator, a parenthetical such as `(suggestion · agent)`, or a `severity:` label. A title word never sets it. Of the pooled findings, 472 state no severity and 1283 state no category. 140 findings are mechanical.
- Of the primary set, 46 findings are `critical`, 1246 state a severity, and 1200 are eligible.
- The first count of this dataset read the severity from any word in the header. With the stricter rules, 25 findings left the primary set. Its 33 false positives did not change.

**dotbabel alone is INCONCLUSIVE by construction.** It has 12 false positives against a floor of 30, and 10 eligible false positives against a floor of 20. Only the pooled set clears the floors, and only narrowly (33 and 25). A pooled run uploads code from a private repository.

## Method

1. `extract.mjs` reads every review comment of a repository with one paginated `gh api` GET. It writes the findings as JSONL to a new private temporary directory. Each record also keeps `commit_id`, `original_commit_id` and `line`, so that a later run can add a file window at that commit.
2. `replay.mjs` builds one request for each finding. The state is the file path, the title, the body, and the last 60 lines of the diff hunk. The posted severity, category, and agent fields are not sent, because two questions ask Jev to predict them. Body prose is sent as written, so it can still name a severity, a category, or an agent. It asks three questions:
   - `real_defect` (`noul`): is the finding correct about the diff?
   - `category` (`choice`): the nine categories of the agent contract.
   - `severity` (`score`): suggestion, important, critical.

   A 429, a 5xx, a timeout or a network error is retried with backoff, and a `Retry-After` header is honored. `--resume` sends only the findings without a usable answer.

3. `analyze.mjs` joins the answers to the findings. It reports the extracted and the answered counts, agreement, a reliability table, Brier score and expected calibration error, each gate with its bootstrap interval, a threshold sweep, and the decision.

Requests are about 1,020 input tokens at the median and 9,334 at the maximum, far below the 64k context.

## Cost

| Run                   | Requests | Input tokens (estimate) | Cost        |
| --------------------- | -------- | ----------------------- | ----------- |
| dotbabel, primary set | 342      | 391k                    | $0.02–$0.03 |
| pooled, primary set   | 1667     | 1.75M                   | $0.07–$0.15 |
| pooled, every finding | 1989     | 2.11M                   | $0.09–$0.18 |

The estimate is four characters per token. Retries add to it. The launch post says the team cannot prove that its prices are not subsidized, and that prices may change.

## Privacy

A run sends each finding's file path, title, body and diff hunk to `api.typesafe.ai`. For dotbabel that is public text. For squadranks it is code, file paths and review text from a private repository. The owner decides each repository separately. `replay.mjs` sends nothing unless it gets both `--send` and `TYPESAFE_API_KEY`, prints a warning before it sends, and does not overwrite an answers file.

The local files hold the same text, so keep each one outside the repository:

- The `extract.mjs` output holds review text, file paths and diff hunks. By default it goes to a new directory from `fs.mkdtempSync`, and the file has mode 0600.
- `extract.mjs --dump` saves every review comment of the repository, not only the findings, with logins and full hunks. It also has mode 0600.
- The `replay.mjs` dry run writes every request, with that text, to stdout. Redirect it to a file outside the repository.
- A labels file holds only comment ids and verdicts. To write it, you read the private replies, so do it locally.
- `.gitignore` ignores `docs/experiments/jev-finding-triage/*.jsonl` in case a run writes there.

The answers file holds ids, verdict metadata, the model, the answers and the usage. It holds no review text and never the key.

## Limits of the evidence

- **The verdict is not ground truth.** It is the disposition that the review pipeline and the owner gave. A finding that was cheap to fix may be marked `Fixed` without being a real defect. Agreement with the verdict measures agreement with this pipeline, not correctness.
- **False positives are rare,** so the gates on them are noisy. Gate (a) divides by the 25 eligible false positives, so one false positive moves it by 4 points, and the cap allows 6. Gate (c) divides by about 1,175 eligible `valid` findings, so one dismissed real defect moves it by about 0.09 points, and the cap allows 5. Kappa moves by about 0.03 for one false positive. The 33 false positives sit in 24 pull requests, which is why the bootstrap resamples pull requests.
- **The verdict rules are text matches** on the first reply. `lib.test.mjs` has a case for every rule in `VERDICT_RULES` and for the ambiguous openings. A false-positive reply is a free-form explanation (`skills/review-pr/SKILL.md:97-104`), so the 125 replies that the rules cannot read (96 unmatched, 20 partial, 9 ambiguous) likely hold false positives. Until they get hand labels, the minority class is too small.
- **Jev sees less than the label did.** Each verdict came from a validation that read the file and the code around it (`skills/review-pr/SKILL.md:93`). Jev sees a 60-line hunk. A REJECT cannot show whether Jev cannot judge, or whether its state lacks that context. This experiment decides on the hunk-only state.
- **A false positive can count twice.** The marker key includes the line (`skills/post-pr-review/SKILL.md:275-278`), so the same finding raised again in a later review round, at a shifted line, gets a new marker. 11 of the 33 false positives share a pull request and a file with another one.
- **The rendering is not documented.** The agent contract (`skills/post-pr-review/references/agent-contract.md:40-41`) makes `severity` and `category` required in the JSON an agent returns. It says nothing about how a posted comment shows them. The many renderings are an observation from this dataset.
- **The secondary severity check assumes** that Jev's `score` is a 0-based index into the criteria. I could not check this against the Jev API.
- **The vendor publishes no calibration data.** Its confidence page calls `confidence` "one reasonable way to summarize a distribution", and the Defapi model listing says "type safety does not guarantee correctness". The launch post's speed and cost claims come from its own workflows. The reliability table is the check this experiment adds.

## Harness

- [`extract.mjs`](./jev-finding-triage/extract.mjs): reads the review comments and writes the findings with their verdicts.
- [`replay.mjs`](./jev-finding-triage/replay.mjs): builds the Jev requests; a dry run by default, and sends only with `--send` and the key.
- [`analyze.mjs`](./jev-finding-triage/analyze.mjs): scores the answers and applies the rule.
- [`lib.mjs`](./jev-finding-triage/lib.mjs): the parsing, the verdict rules, `isPrimary`, `simulateTriage`, `decide`, and `DECISION_RULE`.
- [`lib.test.mjs`](./jev-finding-triage/lib.test.mjs): the tests, offline. Run them with `node --test`.

## Status and next steps

Done: the harness, its tests, and the counts above. Not done: everything that needs a Jev answer. In order:

1. **Owner approval, per repository,** to send its text to TypeSafe AI. A decision needs squadranks, because dotbabel alone is INCONCLUSIVE.
2. **Key.** Provision `TYPESAFE_API_KEY`.
3. **Hand labels.** Label the 125 unreadable replies in a JSON file, `{"<comment_id>": "valid" | "false_positive" | "unknown"}`, and run `extract.mjs --labels` again. Check the 11 false positives that share a pull request and a file. The `hand_labels` count in the output shows how many false positives the labels add.
4. **Dry run.** Run `replay.mjs` without `--send`, and check the request count and the cost.
5. **Send.** Run `replay.mjs --send`. If it exits 1, run it again with `--resume` until it exits 0.
6. **Analyze.** Run `analyze.mjs`, and record its output in a Results section here.
7. **Act on the outcome:**
   - **ADOPT:** write a spec for Jev as a triage gate in `/review-pr` step 3, behind a flag. If any gate is fragile, the gate first runs in shadow mode: it logs its band beside the full validation and auto-decides nothing, until new findings narrow the interval.
   - **INCONCLUSIVE:** change nothing. Collect more labeled findings and run again under the same rule.
   - **REJECT:** change nothing in `/review-pr`. A later experiment can give Jev a file window at `commit_id`, and the threshold sweep informs it.

## Reproduce

```bash
cd docs/experiments/jev-finding-triage
node --test lib.test.mjs
out=$(mktemp -d)   # private and outside the repository
node extract.mjs --repo kaiohenricunha/dotbabel --out "$out/findings.jsonl"
node replay.mjs --in "$out/findings.jsonl" --primary-only > "$out/requests.jsonl"   # dry run, sends nothing
# Only after the owner approves the upload:
TYPESAFE_API_KEY=... node replay.mjs --in "$out/findings.jsonl" --primary-only --send --out "$out/answers.jsonl"
# If a request failed (exit 1), send only the findings without a usable answer:
TYPESAFE_API_KEY=... node replay.mjs --in "$out/findings.jsonl" --primary-only --send --resume --out "$out/answers.jsonl"
node analyze.mjs --findings "$out/findings.jsonl" --answers "$out/answers.jsonl"
```

To pool repositories, run `extract.mjs` for each one and concatenate the JSONL files. Each record carries its `repo`.
