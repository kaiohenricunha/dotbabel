# CC Prompt Templates

Templates for generating Claude Code prompts in Section 6 of the spec.

## Analysis Prompt (Phase: Research)

Use when the user needs CC to analyze existing code before designing the new architecture.

````
Read the files listed below and produce a single markdown report at
{output_path}. Do NOT modify any source files. Read-only analysis.

<read-first>
{list 5-15 source files, one per line, with brief note on what each contains}
</read-first>

<report-structure>
For each section, extract ONLY facts from the code.
No opinions, no recommendations, no "should" statements.

## 1. {Section Title}
{What to extract: line numbers, function signatures, SQL, data flow}

## 2. {Section Title}
...
</report-structure>

<constraints>
- Output: ONE file only — {output_path}
- Do NOT create, modify, or delete any other file
- Do NOT run tests or build commands
- Copy exact code snippets (with line numbers)
- If a file doesn't exist, note MISSING and continue
- Use ```{lang} fenced blocks for code snippets
</constraints>

<verify>
cat {output_path} | head -20
grep -c "^##" {output_path}
# expect: {N} sections
</verify>
````

## Implementation Prompt (Phase: Build)

Use for each step in the implementation plan.

```
<read-first>
{primary spec doc} (§{relevant section} — {what to read})
{2-4 source files the step depends on, with notes}
{1-2 files the step will create/modify}
</read-first>

{Brief description of what to implement and where.}

TDD first — write tests before implementation, each paired with the criterion
it proves:
{List each test name with its criterion id: AC-1 → TestX_Y, AC-2 → TestA_B, ...}

Pair every test name with a criterion id (AC-N) from spec.json. A test name
with no criterion is a test nothing verifies against; a criterion with no test
name is a claim nothing proves. The name must match the test verbatim —
verification looks it up by exact string in the JUnit report, so a paraphrase
silently never matches. Set those criteria to `active` in this same change,
since that is the pull request that makes their tests real.

<constraints>
- Files modified: {explicit list}
- Files created: {explicit list}
- Do NOT touch: {explicit exclusions}
</constraints>

<verify>
go test ./path/to/... -race -v
{additional verification commands}
</verify>

<proof>
tests: {the unit tests above; integration tests where the unit crosses a
        process, file, network, or database boundary}
run:   {the exact command, page, or call that exercises the new behavior the
        way a user does}
expect: {what the run must show: an output line, a file, a screen state}
done_when:
- tests pass
- the run shows the expected result
- {one line per extra check: a constraint, a visual check, a review pass}
</proof>
```

The `<proof>` block is the unit's task contract. `/deliver` takes it as
`done_when`, runs every line, and puts the evidence in the pull request's
`## Proof` section. Write `N/A — <reason>` for `run` only when the unit has no
runnable surface, such as a pure refactor that the tests already cover.

## Key Rules for Prompts

1. **Always include `<read-first>`** — CC must scan files before writing
2. **Always list test names** — TDD is non-negotiable
3. **Always include `<verify>` and `<proof>`** — automated check that work is correct, and a run of the feature that shows it works
4. **Always specify file scope** — modified, created, do-not-touch
5. **Reference the spec doc by section** — not by line number (lines change)
6. **One prompt = one deliverable** — don't combine unrelated work
7. **Command selection:**
   - Use the existing `/plan` workflow for an implementation approach or a revised plan.
   - For complex work, recommend an explicit reasoning effort only if the active runtime
     supports that control. Keep effort selection separate from model selection.
   - Do not invent a slash command to request more reasoning.
