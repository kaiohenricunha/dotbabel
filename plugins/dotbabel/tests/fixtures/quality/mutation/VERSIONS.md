# Captured mutation reports

Every file here is the real output of a real run against a small sample project
(one source file with a branchy `classify` and a trivial `add`, and a test suite
that deliberately leaves some mutants alive). Nothing is hand-written: the
lesson from the coverage fixtures is that a parser proved against an invented
shape is not proved at all.

| File                     | Tool     | Version                               | Command                                            |
| ------------------------ | -------- | ------------------------------------- | -------------------------------------------------- |
| `stryker-mutation.json`  | Stryker  | 10.0.0                                | `stryker run` with `reporters: ["json"]`           |
| `gremlins-report.json`   | Gremlins | `dev` (built from source, `go1.25.3`) | `gremlins unleash --output=gremlins-report.json .` |
| `mutmut-cicd-stats.json` | mutmut   | 3.8.0                                 | `mutmut run` then `mutmut export-cicd-stats`       |

## What each tool does and does not give us

**Stryker** emits the mutation-testing-elements schema (`schemaVersion: "1.0"`):
`files[path].mutants[]`, each with `id`, `mutatorName`, `status`, and
`location.start.line` / `location.end.line`. Per-mutant with original-source
line attribution, so changed-line scoring works. The captured report holds 18
mutants across `Killed`, `Survived` and `NoCoverage`.

**Gremlins** emits `files[].mutations[]`, each with `type`, `status`, `line` and
`column`, plus aggregate totals. Also per-mutant with original-source lines, so
changed-line scoring works. The captured report holds 6 mutants, 5 `KILLED` and
1 `LIVED`.

**mutmut gives aggregate counts only**, and this is architectural rather than a
missing flag. `export-cicd-stats` writes `{killed, survived, total, no_tests,
skipped, suspicious, timeout, ...}` with no per-mutant records. The `results`
subcommand lists mutant names and statuses with no line numbers. The `.spans`
sidecar does carry line ranges, but they index the **generated** mutant file —
mutmut rewrites every mutant as a separate function in one synthesized module —
so they cannot be mapped back to a line in the original source. `mutmut show
<id>` prints a diff hunk from which a line could be inferred, but only one
mutant per subprocess.

That is why `mutation.changed_score` reports `not_applicable` for mutmut while
the whole-file score is still available (KD-7). Reporting a changed-line score
derived from aggregate counts would be a number with no basis.

## Regenerating

The sample projects are not committed — they are three files each and exist
only to produce these reports. To recapture, build a source file with a few
branches plus a test suite that leaves some mutants alive, then run the command
in the table above. If a tool's schema changes, the parser tests fail here
rather than silently reporting a zero score.
