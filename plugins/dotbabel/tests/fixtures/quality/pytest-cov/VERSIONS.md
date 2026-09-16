# Captured pytest-cov report

`coverage.json` is a `coverage.py` JSON report as
`pytest --cov --cov-report=json:.dotbabel/quality/coveragepy.json` writes it
(KD-8) — the exact argv the Python adapter builds. Captured from:

- `pytest` 8.3.3
- `pytest-cov` 5.0.0
- `coverage` 7.6.1 (`meta.version` in the file)

`meta.branch_coverage` is true, which is what makes `num_branches` and the
`executed_branches` / `missing_branches` pairs present. A report captured
without branch coverage omits them, and the parser must then emit no branch
result rather than a zero one.
