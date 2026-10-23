# OpenCode fixtures

- `models-warm-doc2.txt`: the four rows that DOC-2 (`docs/audits/model-runtime-capability-investigation.md`,
  "`opencode models` Grammar and Stability") records from a warm `opencode models` run on v2.0.5. The
  other five rows of that run are elided in DOC-2, so they are not reproduced here.

A credential-free run under an isolated home always prints zero lines with exit 0 (re-measured on
2026-10-22 with `--standalone`), so no non-empty listing can be recorded without a user's configuration.
