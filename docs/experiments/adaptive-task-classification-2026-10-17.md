# Local task classification comparison — 2026-10-17

## Goal and boundaries

Compare a lexical baseline and a bounded local contextual classifier on representative engineering fixtures. The implementation assignment requires a low-overhead private default, separate semantic capability/effort demands, explicit uncertainty, and a replaceable classifier interface. No extra provider inference is authorized for this comparison; no credentials or repository contents are sent anywhere.

## Reproduction

Sandbox: `.claude/worktrees/adaptive-session-routing-classifier`, branch `feat/adaptive-session-routing-classifier`, based on local resolver/activation integration 396ede5. The worktree starts from origin/main ec60c11 and fast-forwards to that dependency. Existing installed Node dependencies are referenced through a node_modules symlink; nothing is installed or changed in the shared dependency tree.

```bash
npx vitest run plugins/dotbabel/tests/adaptive-session-routing-classifier.test.mjs
node experiments/adaptive-session-routing-classifier/compare.mjs
```

The tests start with a missing-module failure. Further failing cases reproduce risk promotion from inline/truncated code examples and acceptance of null context. The implementation fixes those boundaries. The latest suite passes 34 tests. The comparison uses 10 authored task fixtures, including SquadRanks-style frontend work, payment integration, ingestion races, authentication, scoring correctness, architecture, misleading quoted/negated text and a vague prompt. Each performance sample measures classification only, without discovery or runtime execution, after one warm pass.

## Results

| Approach                 | Fixture agreement | Classifier p95, 1,000 calls | Extra inference |
| ------------------------ | ----------------- | --------------------------- | --------------- |
| Lexical baseline         | 5/10              | 0.001454 ms                 | 0               |
| Local contextual default | 10/10             | 0.005651 ms                 | 0               |
| Model-assisted option    | Not evaluated     | Not measured                | 0               |

The model-assisted option would require another inference invocation and an explicit privacy decision about prompt/context disclosure. No efficacy, latency or cost result is claimed for it. It remains a possible replacement strategy through the same function contract, rather than a default network operation.

## Interpretation and limitations

The contextual strategy matches all current fixture labels; the lexical baseline misses independent demand axes, quoted/negated context and uncertainty. These labels guide the rule implementation. There is no held-out dataset, and fixture agreement is not a real-world accuracy estimate or a benchmark of model quality. The reported p95 applies to this local measurement; the combined classifier/router performance requirement remains unproved until the router exists.

Confidence denotes rule/input completeness, not a calibrated probability of success. Unknown domains, implicit requirements and novel wording can still be misclassified. Removing quoted examples avoids false task instructions but can omit relevant failure logs; callers must supply bounded structured context for those facts. The initial lexical extraction is English only. Unknown or invalid tasks produce explicit fallback diagnostics; runtime application must preserve the existing configuration when classification is uncertain.

## Chosen default and remaining checks

Use the local contextual function as the initial default. It accepts at most 16 KiB of prompt bytes and a strict context object bounded to 4 KiB, never scans a repository and never emits a native model name. Capability class and effort intent are separate fields. Runtime integrations consume this contract without owning classification rules or a parallel model registry.

Classifier mutation initially scores 60.00%, then 78.26%, 83.70% and 83.97% as boundary gaps are tested. The final run scores 87.23% (321 killed, 47 surviving, zero uncovered, zero timeout), with 8.54 tests per mutant. The break threshold stays 85. PR-quality checks remain pending at this checkpoint. The classifier does not route a prompt, enforce a floor, observe an effective configuration, forward attachments or establish exactly-once delivery. Those remain AR-3 through AR-6 work.
