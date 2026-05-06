/**
 * Structured error taxonomy for every harness validator.
 *
 * Every validator emits instances of `ValidationError` rather than raw strings.
 * This gives consumers a machine-parseable `.code`, `.file`, and `.pointer`
 * while keeping `.toString()` readable for human-first CLI output.
 *
 * @typedef {object} StructuredError
 * @property {string} code      Stable enum value (see `ERROR_CODES`). Never rename.
 * @property {string} message   Human-readable one-liner. May contain identifier names.
 * @property {string} [file]    Repo-relative path where the error was detected.
 * @property {string} [pointer] JSON Pointer or dotted key when the error is inside a structured file.
 * @property {number} [line]    1-indexed line number when available.
 * @property {string} [expected] Text describing what the validator expected.
 * @property {string} [got]      Text describing what was observed.
 * @property {string} [hint]     Actionable remediation suggestion.
 * @property {'spec'|'skill'|'manifest'|'coverage'|'drift'|'scaffold'|'settings'|'env'|'usage'|'agent'} [category]
 */

/**
 * Stable error codes. Consumers may match on these; renames are breaking changes.
 */
export const ERROR_CODES = Object.freeze({
  // spec
  SPEC_JSON_INVALID: 'SPEC_JSON_INVALID',
  SPEC_STATUS_INVALID: 'SPEC_STATUS_INVALID',
  SPEC_MISSING_REQUIRED_FIELD: 'SPEC_MISSING_REQUIRED_FIELD',
  SPEC_ID_MISMATCH: 'SPEC_ID_MISMATCH',
  SPEC_LINKED_PATH_MISSING: 'SPEC_LINKED_PATH_MISSING',
  SPEC_ACCEPTANCE_EMPTY: 'SPEC_ACCEPTANCE_EMPTY',
  SPEC_DEPENDENCY_UNKNOWN: 'SPEC_DEPENDENCY_UNKNOWN',
  // skill
  SKILL_FRONTMATTER_MISSING: 'SKILL_FRONTMATTER_MISSING',
  SKILL_NAME_MISMATCH: 'SKILL_NAME_MISMATCH',
  // manifest
  MANIFEST_CHECKSUM_MISMATCH: 'MANIFEST_CHECKSUM_MISMATCH',
  MANIFEST_ENTRY_MISSING: 'MANIFEST_ENTRY_MISSING',
  MANIFEST_ORPHAN_FILE: 'MANIFEST_ORPHAN_FILE',
  MANIFEST_DEPENDENCY_CYCLE: 'MANIFEST_DEPENDENCY_CYCLE',
  // coverage
  COVERAGE_UNCOVERED: 'COVERAGE_UNCOVERED',
  COVERAGE_NO_SPEC_RATIONALE: 'COVERAGE_NO_SPEC_RATIONALE',
  COVERAGE_UNKNOWN_SPEC_ID: 'COVERAGE_UNKNOWN_SPEC_ID',
  // drift
  DRIFT_TEAM_COUNT: 'DRIFT_TEAM_COUNT',
  DRIFT_PROTECTED_PATH: 'DRIFT_PROTECTED_PATH',
  DRIFT_INSTRUCTION_FILES: 'DRIFT_INSTRUCTION_FILES',
  DRIFT_INSTRUCTION_FILE_MISSING: 'DRIFT_INSTRUCTION_FILE_MISSING',
  // scaffold
  SCAFFOLD_CONFLICT: 'SCAFFOLD_CONFLICT',
  SCAFFOLD_USAGE: 'SCAFFOLD_USAGE',
  // settings / hooks (sh validator parity)
  SETTINGS_SEC_1: 'SETTINGS_SEC_1',
  SETTINGS_SEC_2: 'SETTINGS_SEC_2',
  SETTINGS_SEC_3: 'SETTINGS_SEC_3',
  SETTINGS_SEC_4: 'SETTINGS_SEC_4',
  SETTINGS_OPS_1: 'SETTINGS_OPS_1',
  SETTINGS_OPS_2: 'SETTINGS_OPS_2',
  // agent frontmatter
  AGENT_MISSING_FIELD: 'AGENT_MISSING_FIELD',
  AGENT_INVALID_MODEL: 'AGENT_INVALID_MODEL',
  AGENT_WRITE_TOOL_IN_READONLY: 'AGENT_WRITE_TOOL_IN_READONLY',
  AGENT_SECRET_PATTERN: 'AGENT_SECRET_PATTERN',
  AGENT_TRIGGER_OVERLAP: 'AGENT_TRIGGER_OVERLAP',
  // env / usage
  ENV_REPO_ROOT_UNKNOWN: 'ENV_REPO_ROOT_UNKNOWN',
  ENV_FACTS_MISSING: 'ENV_FACTS_MISSING',
  USAGE_UNKNOWN_FLAG: 'USAGE_UNKNOWN_FLAG',
  USAGE_MISSING_POSITIONAL: 'USAGE_MISSING_POSITIONAL',
});

/**
 * Structured validator error. Extends `Error` so existing `throw`/`catch`
 * paths continue to work; extra properties give consumers a machine-parseable
 * view.
 */
export class ValidationError extends Error {
  /**
   * @param {StructuredError} details
   */
  constructor(details) {
    if (!details || typeof details !== 'object') {
      throw new TypeError('ValidationError requires a StructuredError details object');
    }
    if (!details.code || typeof details.code !== 'string') {
      throw new TypeError('ValidationError requires a non-empty `code`');
    }
    if (!details.message || typeof details.message !== 'string') {
      throw new TypeError('ValidationError requires a non-empty `message`');
    }
    super(details.message);
    this.name = 'ValidationError';
    this.code = details.code;
    if (details.file !== undefined) this.file = details.file;
    if (details.pointer !== undefined) this.pointer = details.pointer;
    if (details.line !== undefined) this.line = details.line;
    if (details.expected !== undefined) this.expected = details.expected;
    if (details.got !== undefined) this.got = details.got;
    if (details.hint !== undefined) this.hint = details.hint;
    if (details.category !== undefined) this.category = details.category;
  }

  /**
   * Legacy string format: `"<file>: <message>"` so existing tests and CI
   * pipelines that regex on stderr continue to work unchanged.
   * @returns {string}
   */
  toString() {
    return this.file ? `${this.file}: ${this.message}` : this.message;
  }

  /**
   * JSON-safe representation for `--json` output.
   * @returns {StructuredError}
   */
  toJSON() {
    /** @type {StructuredError} */
    const out = { code: this.code, message: this.message };
    if (this.file !== undefined) out.file = this.file;
    if (this.pointer !== undefined) out.pointer = this.pointer;
    if (this.line !== undefined) out.line = this.line;
    if (this.expected !== undefined) out.expected = this.expected;
    if (this.got !== undefined) out.got = this.got;
    if (this.hint !== undefined) out.hint = this.hint;
    if (this.category !== undefined) out.category = this.category;
    return out;
  }
}

/**
 * Render a single error for human-readable CLI output. Mirrors the
 * `✗ <message>` prefix style used by `plugins/dotbabel/scripts/validate-settings.sh:43-45`.
 *
 * @param {ValidationError | StructuredError | Error} err
 * @param {{ verbose?: boolean }} [opts]
 * @returns {string}
 */
export function formatError(err, opts = {}) {
  const verbose = Boolean(opts.verbose);
  const prefix = err.file ? `${err.file}: ` : '';
  const head = `${prefix}${err.message ?? String(err)}`;
  if (!verbose) return head;

  const tail = [];
  if (err.code) tail.push(`  code:     ${err.code}`);
  if (err.pointer !== undefined) tail.push(`  pointer:  ${err.pointer}`);
  if (err.line !== undefined) tail.push(`  line:     ${err.line}`);
  if (err.expected !== undefined) tail.push(`  expected: ${err.expected}`);
  if (err.got !== undefined) tail.push(`  got:      ${err.got}`);
  if (err.hint !== undefined) tail.push(`  hint:     ${err.hint}`);
  if (err.category !== undefined) tail.push(`  category: ${err.category}`);
  return tail.length > 0 ? `${head}\n${tail.join('\n')}` : head;
}
