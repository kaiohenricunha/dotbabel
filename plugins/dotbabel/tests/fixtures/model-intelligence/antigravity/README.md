# Antigravity fixtures

- `models-doc2-1.2.5.tsv`: the full 14-row `agy models` stdout that DOC-2 records on 1.2.5
  (`docs/audits/model-runtime-capability-investigation.md`, "`agy models` Grammar and Stability"):
  `id<TAB>label`, with the `Fetching available models...` banner on stderr.
- `models-sign-in-1.4.2.stderr`: the stderr of `agy models` on 1.4.2 under a scratch home, recorded
  on 2026-10-22. The command exits 1 and stdout carries only `Fetching available models...`. A
  credential-free run can no longer list models.
