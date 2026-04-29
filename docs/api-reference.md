# Node API reference

_Last updated: v1.0.1_

The public contract lives at `plugins/dotclaude/src/index.mjs` — import from
the package root, not deep paths:

```js
import {
  createHarnessContext,
  validateSpecs,
  validateManifest,
  refreshChecksums,
  checkSpecCoverage,
  checkInstructionDrift,
  scaffoldHarness,
  ValidationError,
  ERROR_CODES,
  formatError,
  EXIT_CODES,
  version,
  // spec-harness helpers
  readJson,
  readText,
  pathExists,
  git,
  loadFacts,
  listSpecDirs,
  listRepoPaths,
  escapeRegex,
  globToRegExp,
  matchesGlob,
  anyPathMatches,
  toPosix,
  extractTemplateSection,
  isMeaningfulSection,
  getPullRequestContext,
  isBotActor,
  getChangedFiles,
} from "@dotclaude/dotclaude";
```

**Every symbol is documented with JSDoc in-source.** Run
`node scripts/check-jsdoc-coverage.mjs plugins/dotclaude/src` in the repo to
assert coverage is complete.

## Typical usage

```js
import { createHarnessContext, validateSpecs, formatError } from "@dotclaude/dotclaude";

const ctx = createHarnessContext(); // resolves repo root via git or DOTCLAUDE_REPO_ROOT
const { ok, errors } = validateSpecs(ctx);

if (!ok) {
  for (const err of errors) {
    console.error(formatError(err, { verbose: true }));
    // err.code   — stable enum (see ERROR_CODES)
    // err.file   — repo-relative path
    // err.pointer — JSON pointer for structured files
    // err.hint   — actionable remediation
  }
  process.exit(1);
}
```

## Exported types (JSDoc `@typedef`s)

- **`HarnessContext`** — `{ repoRoot, specsRoot, manifestPath, factsPath }`,
  the context threaded through every validator.
- **`ValidationResult`** — `{ ok: boolean, errors: ValidationError[] }`.
- **`StructuredError`** — the `ValidationError` object shape with
  `code`, `message`, optional `file`, `pointer`, `line`, `expected`, `got`,
  `hint`, `category`.
- **`PullRequestContext`** — `{ isPullRequest, body, actor }`, the shape
  `getPullRequestContext()` returns.

## Error codes

See `ERROR_CODES` for the full list (it's `Object.freeze`d). Renames are
breaking changes; additions are not. Enumerated families:

- **spec**: `SPEC_JSON_INVALID`, `SPEC_STATUS_INVALID`,
  `SPEC_MISSING_REQUIRED_FIELD`, `SPEC_ID_MISMATCH`,
  `SPEC_LINKED_PATH_MISSING`, `SPEC_ACCEPTANCE_EMPTY`,
  `SPEC_DEPENDENCY_UNKNOWN`.
- **skill**: `SKILL_FRONTMATTER_MISSING`, `SKILL_NAME_MISMATCH`.
- **manifest**: `MANIFEST_ENTRY_MISSING`, `MANIFEST_CHECKSUM_MISMATCH`,
  `MANIFEST_ORPHAN_FILE`, `MANIFEST_DEPENDENCY_CYCLE`.
- **coverage**: `COVERAGE_UNCOVERED`, `COVERAGE_NO_SPEC_RATIONALE`,
  `COVERAGE_UNKNOWN_SPEC_ID`.
- **drift**: `DRIFT_TEAM_COUNT`, `DRIFT_PROTECTED_PATH`,
  `DRIFT_INSTRUCTION_FILES`, `DRIFT_INSTRUCTION_FILE_MISSING`.
- **scaffold**: `SCAFFOLD_CONFLICT`, `SCAFFOLD_USAGE`.
- **settings**: `SETTINGS_SEC_1`..`SETTINGS_SEC_4`,
  `SETTINGS_OPS_1`, `SETTINGS_OPS_2`.
- **env/usage**: `ENV_REPO_ROOT_UNKNOWN`, `ENV_FACTS_MISSING`,
  `USAGE_UNKNOWN_FLAG`, `USAGE_MISSING_POSITIONAL`.

## Exit codes

`EXIT_CODES` = `{ OK:0, VALIDATION:1, ENV:2, USAGE:64 }`. Use these instead
of string-matching error messages.

## Subpath exports

A few commonly-reached-for modules are also exposed as sub-paths in
`package.json.exports`:

```js
import { ValidationError, ERROR_CODES } from "@dotclaude/dotclaude/errors";
import { EXIT_CODES } from "@dotclaude/dotclaude/exit-codes";
```

Deep imports beyond these three subpaths are **not** part of the public
contract; any reshuffle inside `src/` can happen in a minor bump.

## Versioning

`version` is the package version at import time (read from the installed
`package.json`). Consumers can gate on it:

```js
import { version } from "@dotclaude/dotclaude";
if (!version.startsWith("0.2.")) throw new Error(`unsupported harness: ${version}`);
```

Semver: minor bumps add new codes/bins. Major bumps can rename codes or
remove bins. `ValidationError.prototype.toString()` keeps the
`"<file>: <message>"` format across minor bumps so stderr-grep pipelines
don't break.
