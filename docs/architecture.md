# Architecture

_Last updated: v0.8.0_

## Layers

```
┌──────────────────────────────────────────────────────────────────────┐
│  Consumer repo                                                       │
│  ┌────────────────────────┐    ┌──────────────────────────────────┐  │
│  │  GitHub Actions        │    │  Local dev                       │  │
│  │  validate-skills.yml   │    │  npm test / npx dotclaude-doctor   │  │
│  │  detect-drift.yml      │    │  pre-commit → auto-update        │  │
│  │  ai-review.yml         │    │                                  │  │
│  └──────┬─────────────────┘    └──────────┬───────────────────────┘  │
└─────────┼─────────────────────────────────┼──────────────────────────┘
          │                                 │
┌─────────▼─────────────────────────────────▼──────────────────────────┐
│  bin/*                                                               │
│  dotclaude  dotclaude-doctor  dotclaude-init  dotclaude-validate-{specs,  │
│  skills}  dotclaude-check-{spec-coverage, instruction-drift}         │
│  dotclaude-detect-drift                                               │
│  Each bin: parse(lib/argv) → validator → createOutput(lib/output)    │
│            → formatError(lib/errors) → exit(lib/exit-codes)          │
└─────────┬────────────────────────────────────────────────────────────┘
          │
┌─────────▼────────────────────────────────────────────────────────────┐
│  src/lib/                                                            │
│  argv.mjs    output.mjs    errors.mjs    exit-codes.mjs   debug.mjs  │
└─────────┬────────────────────────────────────────────────────────────┘
          │
┌─────────▼────────────────────────────────────────────────────────────┐
│  Validators (src/*.mjs)                                              │
│  validate-specs  validate-skills-inventory  check-spec-coverage      │
│  check-instruction-drift  init-harness-scaffold                      │
│  — every errors.push() emits a ValidationError(code, …)              │
└─────────┬────────────────────────────────────────────────────────────┘
          │
┌─────────▼────────────────────────────────────────────────────────────┐
│  spec-harness-lib.mjs (filesystem + git + PR context primitives)     │
│  createHarnessContext  readJson  readText  pathExists  git           │
│  listSpecDirs  listRepoPaths  globToRegExp  getChangedFiles  …       │
└──────────────────────────────────────────────────────────────────────┘
```

Top of the stack (bins + CI) is what consumers see. The library layer
(`src/lib/` + `src/*.mjs`) is the public Node API, exposed via the barrel
at `src/index.mjs`. Below that, `spec-harness-lib.mjs` holds the small set
of filesystem/git primitives every validator shares.

## The PR-time coverage check — sequence

This is the most interesting data flow, because it spans the GitHub Actions
env, git history, and the spec tree.

```
validate-skills.yml
       │
       ▼  (runs `npx dotclaude-check-spec-coverage`)
bin/dotclaude-check-spec-coverage.mjs
       │
       │ 1. parse(argv, {--repo-root})
       ▼
createHarnessContext({ repoRoot })
       │
       │ 2. resolve repoRoot: arg → DOTCLAUDE_REPO_ROOT → git rev-parse
       ▼
getPullRequestContext()         ← reads GITHUB_EVENT_NAME / PR_BODY / GITHUB_ACTOR
getChangedFiles()               ← HARNESS_CHANGED_FILES csv || git diff origin/<base>...HEAD
       │
       ▼
checkSpecCoverage(ctx, input)
       │
       │ 3. filter changedFiles ∩ loadFacts(ctx).protected_paths
       │ 4. listSpecDirs(ctx) → map to {id, status, linked_paths}
       │ 5. filter status ∈ {approved, implementing, done}
       │ 6. uncovered = protectedFiles − linked_paths∪
       │ 7. extractTemplateSection(body, "Spec ID")
       │ 8. extractTemplateSection(body, "No-spec rationale")
       │ 9. if isBotActor(actor): short-circuit ok=true
       │ 10. if uncovered.length && !meaningful(rationale): push
       │      ValidationError(COVERAGE_UNCOVERED, ...)
       ▼
{ ok, errors: [ValidationError] }
       │
       ▼
for each err: out.fail(formatError(err), err.toJSON())
out.flush()                     ← pretty-print, or emit JSON envelope
process.exit(EXIT_CODES.VALIDATION)
```

Every helper on the left of arrows is a standalone JSDoc'd export — the
pipeline is composable for custom CI scripts that want different gating.

## Key design decisions

See `docs/adr/` for the canonical decision records. Summary:

- **Zero runtime dependencies** (ADR-0002 → Node 20+ ESM, no bundler, no TS).
- **Dual-persona monorepo** (ADR-0001 → plugin package + personal dotfiles in one checkout).
- **Structured-error contract** (ADR-0012 → `ValidationError` class with stable `.code`).
- **Exit-code convention** (ADR-0013 → `{0,1,2,64}` with 64 mirroring BSD `EX_USAGE`).
- **CLI `✓/✗/⚠` format** (ADR-0014 → gold-standard from `validate-settings.sh:43-45`).
- **`exit 2` on PreToolUse blocks** (Claude Code hook protocol, documented in the hook comment block).
