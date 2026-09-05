# Quality policy reference

## Classes

- A `hard` rule protects correctness or a high-confidence security boundary.
- A `regression` rule compares compatible current and baseline evidence.
- A `budget` rule uses an inclusive numeric threshold.
- An `advisory` rule identifies a design signal that needs judgment.
- A `semantic` rule requires an agent or human review.

## Measurement states

`checked` means a tool produced usable evidence. `unsupported` means no adapter can measure the rule.
`not_configured` means a compatible tool exists but the repository did not select one. `unavailable` means a selected tool or report failed.
`not_applicable` means the rule has no relevant scope. `skipped` means the selected profile did not execute it.

Never convert these states into a pass without policy evidence.

## Baselines and exceptions

A baseline can record quantitative legacy debt and reliable advisory findings. It cannot record compiler, type, test, formatter, hard-lint, or high-security failures.

A legacy value above its target passes when the changed value does not become worse. Report an improvement even when it stays above the target.

An exception matches one exact fingerprint. It changes an error to an acknowledged warning until its expiration date.
Do not add a broad exception. Do not use an exception for trust, execution, report, or hard correctness failures.
