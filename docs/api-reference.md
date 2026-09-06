# Node API reference

_Last updated: v3.2.1_

The public contract lives at `plugins/dotbabel/src/index.mjs` — import from
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
  resolveQualityPolicy,
  detectQualityCapabilities,
  planQualityCheck,
  runQualityCheck,
  loadQualityBaseline,
} from "@dotbabel/dotbabel";
```

**Every symbol is documented with JSDoc in-source.** Run
`node scripts/check-jsdoc-coverage.mjs plugins/dotbabel/src` in the repo to
assert coverage is complete.

## Typical usage

```js
import { createHarnessContext, validateSpecs, formatError } from "@dotbabel/dotbabel";

const ctx = createHarnessContext(); // resolves repo root via git or DOTBABEL_REPO_ROOT
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

## Quality API

- `resolveQualityPolicy(options)` loads shipped, user, project, and operational layers with provenance.
- `detectQualityCapabilities(options)` returns components, evidence, trust state, and capability states without project execution.
- `planQualityCheck(options)` returns deduplicated adapter command plans for a profile and change set.
- `runQualityCheck(options)` executes trusted plans and returns a `schema_version: 1` result envelope.
- `loadQualityBaseline(options)` reads and validates a committed baseline, or returns `null` when absent.

Stable quality constants include profiles, rule classes, measurement states, verdicts, capabilities, report formats, and schema versions.

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
- **quality**: `QUALITY_CONFIG_INVALID`, `QUALITY_BASE_UNAVAILABLE`,
  `QUALITY_REPORT_INVALID`, `QUALITY_BASELINE_INVALID`,
  `QUALITY_TRUST_REQUIRED`, `QUALITY_EXECUTION_FAILED`.

## Exit codes

`EXIT_CODES` = `{ OK:0, VALIDATION:1, ENV:2, USAGE:64 }`. Use these instead
of string-matching error messages.

## Subpath exports

A few commonly-reached-for modules are also exposed as sub-paths in
`package.json.exports`:

```js
import { ValidationError, ERROR_CODES } from "@dotbabel/dotbabel/errors";
import { EXIT_CODES } from "@dotbabel/dotbabel/exit-codes";
```

Deep imports beyond these three subpaths are **not** part of the public
contract; any reshuffle inside `src/` can happen in a minor bump.

## Versioning

`version` is the package version at import time (read from the installed
`package.json`). Consumers can gate on it:

```js
import { version } from "@dotbabel/dotbabel";
if (!version.startsWith("0.2.")) throw new Error(`unsupported harness: ${version}`);
```

Semver: minor bumps add new codes/bins. Major bumps can rename codes or
remove bins. `ValidationError.prototype.toString()` keeps the
`"<file>: <message>"` format across minor bumps so stderr-grep pipelines
don't break.
