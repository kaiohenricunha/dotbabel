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

TDD first — write tests before implementation:
{List specific test function names: TestX_Y, TestA_B, ...}

<constraints>
- Files modified: {explicit list}
- Files created: {explicit list}
- Do NOT touch: {explicit exclusions}
</constraints>

<verify>
go test ./path/to/... -race -v
{additional verification commands}
</verify>
```

## Key Rules for Prompts

1. **Always include `<read-first>`** — CC must scan files before writing
2. **Always list test names** — TDD is non-negotiable
3. **Always include `<verify>`** — automated check that work is correct
4. **Always specify file scope** — modified, created, do-not-touch
5. **Reference the spec doc by section** — not by line number (lines change)
6. **One prompt = one deliverable** — don't combine unrelated work
7. **Command selection:**
   - `/think` — implementation tasks with a locked spec
   - `/ultraplan` — complex tasks requiring deep reasoning
   - `/plan` — when CC previously got an approach wrong
