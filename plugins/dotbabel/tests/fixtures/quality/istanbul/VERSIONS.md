# Captured Istanbul coverage reports

Both files are `coverage-final.json` in Istanbul's JSON format, which is what
the built-in Node coverage plans request (KD-8). Vitest and Jest emit the same
shape through different flags, which is why one parser serves both.

- `vitest-coverage-final.json` — `vitest` 4.1.11 with `@vitest/coverage-v8` 4.1.11,
  via `vitest run --coverage --coverage.reporter=json --coverage.reportsDirectory=.dotbabel/quality`.
- `jest-coverage-final.json` — `jest` 29.7.0, via
  `jest --coverage --coverageReporters=json --coverageDirectory=.dotbabel/quality`.

Keyed by absolute path, as both tools write it; the parser normalizes
separators but does not rewrite the paths.
