import path from "path";
import {
  anyPathMatches,
  listRepoPaths,
  listSpecDirs,
  readJson,
  readText,
  pathExists,
  toPosix,
} from "./spec-harness-lib.mjs";
import { ValidationError, ERROR_CODES } from "./lib/errors.mjs";

const VALID_STATUSES = new Set([
  "draft",
  "approved",
  "implementing",
  "done",
]);

// §7 constraint lines look like "- **PERF-1**: ..." or "PERF-1: ...".
const NFR_LINE = /^\s*(?:[-*]\s*)?\*{0,2}(PERF|REL|OPS|SEC)-(\d+)\*{0,2}\s*[:.]/i;

// Words that promise a threshold without stating one. A constraint may legitimately
// carry no number when it is an invariant ("all writes must be atomic", "must never
// overwrite a user file") — those are binary and testable as written. It is only
// unquantified when it leans on a comparative and then declines to give the value.
const VAGUE_QUANTITY = /\b(fast|slow|quick(?:ly)?|responsive|performant|scalable|efficient|timely|prompt(?:ly)?|reasonable|acceptable|adequate|sufficient|minimal|negligible|low|high|large|small|soon|frequent(?:ly)?|rare(?:ly)?|often|periodic(?:ally)?|regularly|as needed|reliable|robust)\b/i;

// Any digit, or a spelled-out small number, counts as quantified.
const HAS_NUMBER = /\d|\b(zero|one|two|three|four|five|six|seven|eight|nine|ten)\b/i;

// §5 acceptance_criteria: id must be "AC-<number>" (KD-1).
const CRITERION_ID = /^AC-\d+$/;
const VALID_CRITERION_STATUSES = new Set(["planned", "active"]);
const VALID_REPORT_FORMATS = new Set(["junit-xml"]);

/**
 * Shape-check one repository-relative path string: non-empty, not absolute,
 * and does not resolve outside the repository via `..` traversal. This is a
 * pure string check — it never touches the filesystem, so it never reads a
 * test file (Q-5). Existence and content are checked at verification time.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
function isSafeRelativePath(value) {
  if (typeof value !== "string" || !value.trim()) return false;
  if (/^[A-Za-z]:[\\/]/.test(value)) return false; // Windows drive-letter absolute path
  const VIRTUAL_ROOT = "/__dotbabel_repo_root__";
  // Resolving against a virtual root also rejects a POSIX-absolute path: a
  // resolve() whose second argument is itself absolute discards the base, so
  // "/etc/passwd" resolves to itself and fails the prefix check below —
  // there is no need for a separate path.isAbsolute() guard.
  const resolved = path.posix.resolve(VIRTUAL_ROOT, toPosix(value));
  return resolved === VIRTUAL_ROOT || resolved.startsWith(`${VIRTUAL_ROOT}/`);
}

/**
 * Shape-check one `acceptance_criteria[]` entry (KD-1, KD-3, KD-15). Never
 * reads a named test file and never runs `argv` (Q-5) — only string, array,
 * and enum shape is checked here.
 *
 * @param {unknown} criterion
 * @param {number} index
 * @param {Set<string>} seenIds  Ids already seen in this spec's array
 * @param {string} filePrefix    e.g. "docs/specs/<id>"
 * @returns {ValidationError[]}
 */
function validateCriterion(criterion, index, seenIds, filePrefix) {
  const errors = [];
  const base = `/acceptance_criteria/${index}`;

  const push = (pointer, message) => {
    errors.push(new ValidationError({
      code: ERROR_CODES.SPEC_CRITERIA_INVALID,
      category: "spec",
      file: filePrefix,
      pointer,
      message,
    }));
  };

  if (typeof criterion !== "object" || criterion === null || Array.isArray(criterion)) {
    push(base, `acceptance_criteria[${index}] must be an object`);
    return errors;
  }

  if (typeof criterion.id !== "string" || !CRITERION_ID.test(criterion.id)) {
    push(`${base}/id`, `acceptance_criteria[${index}].id must match "AC-<number>"`);
  } else if (seenIds.has(criterion.id)) {
    push(`${base}/id`, `acceptance_criteria[${index}].id "${criterion.id}" is a duplicate`);
  } else {
    seenIds.add(criterion.id);
  }

  if (criterion.status !== undefined && !VALID_CRITERION_STATUSES.has(criterion.status)) {
    push(`${base}/status`, `acceptance_criteria[${index}].status "${criterion.status}" must be "planned" or "active"`);
  }

  for (const field of ["given", "when", "then"]) {
    if (typeof criterion[field] !== "string" || !criterion[field].trim()) {
      push(`${base}/${field}`, `acceptance_criteria[${index}].${field} must be a non-empty string`);
    }
  }

  if (!Array.isArray(criterion.tests) || criterion.tests.length === 0) {
    push(`${base}/tests`, `acceptance_criteria[${index}].tests must be a non-empty array`);
  } else {
    criterion.tests.forEach((test, testIndex) => {
      const testBase = `${base}/tests/${testIndex}`;
      if (typeof test !== "object" || test === null) {
        push(testBase, `acceptance_criteria[${index}].tests[${testIndex}] must be an object`);
        return;
      }
      if (!isSafeRelativePath(test.file)) {
        push(`${testBase}/file`, `acceptance_criteria[${index}].tests[${testIndex}].file must be a non-empty, repository-relative path`);
      }
      if (typeof test.name !== "string" || !test.name.trim()) {
        push(`${testBase}/name`, `acceptance_criteria[${index}].tests[${testIndex}].name must be a non-empty string`);
      }
    });
  }

  if (!Array.isArray(criterion.argv) || criterion.argv.length === 0) {
    push(`${base}/argv`, `acceptance_criteria[${index}].argv must be a non-empty array`);
  } else {
    criterion.argv.forEach((arg, argIndex) => {
      if (typeof arg !== "string" || !arg.trim()) {
        push(`${base}/argv/${argIndex}`, `acceptance_criteria[${index}].argv[${argIndex}] must be a non-empty string`);
      }
    });
  }

  if (criterion.report !== undefined) {
    if (typeof criterion.report !== "object" || criterion.report === null) {
      push(`${base}/report`, `acceptance_criteria[${index}].report must be an object`);
    } else {
      if (!VALID_REPORT_FORMATS.has(criterion.report.format)) {
        push(`${base}/report/format`, `acceptance_criteria[${index}].report.format must be "junit-xml"`);
      }
      if (!isSafeRelativePath(criterion.report.path)) {
        push(`${base}/report/path`, `acceptance_criteria[${index}].report.path must be a non-empty, repository-relative path`);
      }
    }
  }

  return errors;
}

/**
 * Find §7 constraints that lean on a vague quantity word without giving a value.
 *
 * @param {string} body  Contents of spec/7-non-functional-requirements.md
 * @returns {{ tag: string, line: number, text: string }[]}
 */
function findUnquantifiedConstraints(body) {
  const found = [];
  const lines = body.split("\n");
  let inComment = false;

  lines.forEach((raw, index) => {
    // Scaffold guidance lives in HTML comments; never lint it.
    if (inComment) {
      if (raw.includes("-->")) inComment = false;
      return;
    }
    if (raw.trimStart().startsWith("<!--")) {
      if (!raw.includes("-->")) inComment = true;
      return;
    }

    const match = raw.match(NFR_LINE);
    if (!match) return;

    // Strip the tag itself so "PERF-1" does not read as its own quantity.
    const text = raw.slice(match[0].length);
    if (VAGUE_QUANTITY.test(text) && !HAS_NUMBER.test(text)) {
      found.push({
        tag: `${match[1].toUpperCase()}-${match[2]}`,
        line: index + 1,
        text: text.trim(),
      });
    }
  });

  return found;
}

/**
 * Validate every spec.json under docs/specs/.
 *
 * Checks performed per spec:
 *  - spec.json exists
 *  - required fields present and non-empty: id, title, status, owners, linked_paths, acceptance_commands, depends_on_specs, active_prs
 *  - status is one of the allowed enum values
 *  - id matches the directory name
 *  - linked_paths entries are non-empty strings
 *  - acceptance_commands entries are non-empty strings
 *  - acceptance_criteria entries match the §5 shape (KD-1, KD-3, KD-15), when present
 *
 *  - §7 constraints do not lean on a comparative without stating its value
 *
 * Cross-spec checks:
 *  - depends_on_specs references resolve to known spec ids
 *
 * @param {object} ctx  Harness context from createHarnessContext().
 * @returns {{ ok: boolean, errors: ValidationError[] }}
 */
export function validateSpecs(ctx) {
  const errors = [];
  const specDirs = listSpecDirs(ctx);
  const repoPaths = listRepoPaths(ctx);

  // Collect known spec IDs for cross-reference resolution.
  const specIds = new Set(specDirs);

  for (const specDir of specDirs) {
    const specJsonRelative = `docs/specs/${specDir}/spec.json`;
    const prefix = `docs/specs/${specDir}`;

    if (!pathExists(ctx, specJsonRelative)) {
      errors.push(new ValidationError({
        code: ERROR_CODES.SPEC_JSON_INVALID,
        category: "spec",
        file: prefix,
        message: "missing spec.json",
        hint: "create spec.json with required fields (id, title, status, owners, linked_paths, acceptance_commands)",
      }));
      continue;
    }

    let metadata;
    try {
      metadata = readJson(ctx, specJsonRelative);
    } catch (err) {
      errors.push(new ValidationError({
        code: ERROR_CODES.SPEC_JSON_INVALID,
        category: "spec",
        file: prefix,
        message: `spec.json is not valid JSON — ${err.message}`,
        hint: "run `node -e \"JSON.parse(require('fs').readFileSync('docs/specs/<id>/spec.json','utf8'))\"` to locate the parse error",
      }));
      continue;
    }

    // id must match directory name.
    if (metadata.id !== specDir) {
      errors.push(new ValidationError({
        code: ERROR_CODES.SPEC_ID_MISMATCH,
        category: "spec",
        file: prefix,
        pointer: "id",
        expected: specDir,
        got: String(metadata.id),
        message: `spec.json id "${metadata.id}" must equal directory name "${specDir}"`,
      }));
    }

    // title: required, non-empty string.
    if (typeof metadata.title !== "string" || !metadata.title.trim()) {
      errors.push(new ValidationError({
        code: ERROR_CODES.SPEC_MISSING_REQUIRED_FIELD,
        category: "spec",
        file: prefix,
        pointer: "title",
        message: "spec.json title must be a non-empty string",
      }));
    }

    // status: required, must be in enum.
    if (!VALID_STATUSES.has(metadata.status)) {
      errors.push(new ValidationError({
        code: ERROR_CODES.SPEC_STATUS_INVALID,
        category: "spec",
        file: prefix,
        pointer: "status",
        expected: [...VALID_STATUSES].join(", "),
        got: String(metadata.status),
        message: `invalid status "${metadata.status}" (allowed: ${[...VALID_STATUSES].join(", ")})`,
      }));
    }

    // owners: required, non-empty array.
    if (!Array.isArray(metadata.owners) || metadata.owners.length === 0) {
      errors.push(new ValidationError({
        code: ERROR_CODES.SPEC_MISSING_REQUIRED_FIELD,
        category: "spec",
        file: prefix,
        pointer: "owners",
        message: "owners must be a non-empty array",
      }));
    }

    // linked_paths: required, non-empty array of strings.
    if (!Array.isArray(metadata.linked_paths) || metadata.linked_paths.length === 0) {
      errors.push(new ValidationError({
        code: ERROR_CODES.SPEC_LINKED_PATH_MISSING,
        category: "spec",
        file: prefix,
        pointer: "linked_paths",
        message: "linked_paths must be a non-empty array",
      }));
    } else {
      for (const linkedPath of metadata.linked_paths) {
        if (typeof linkedPath !== "string" || !linkedPath.trim()) {
          errors.push(new ValidationError({
            code: ERROR_CODES.SPEC_LINKED_PATH_MISSING,
            category: "spec",
            file: prefix,
            pointer: "linked_paths[]",
            got: JSON.stringify(linkedPath),
            message: "linked_paths entries must be non-empty strings",
          }));
        }
      }
    }

    // acceptance_commands: required, non-empty array of non-empty strings.
    if (!Array.isArray(metadata.acceptance_commands) || metadata.acceptance_commands.length === 0) {
      errors.push(new ValidationError({
        code: ERROR_CODES.SPEC_ACCEPTANCE_EMPTY,
        category: "spec",
        file: prefix,
        pointer: "acceptance_commands",
        message: "acceptance_commands must be a non-empty array",
      }));
    } else {
      for (const cmd of metadata.acceptance_commands) {
        if (typeof cmd !== "string" || !cmd.trim()) {
          errors.push(new ValidationError({
            code: ERROR_CODES.SPEC_ACCEPTANCE_EMPTY,
            category: "spec",
            file: prefix,
            pointer: "acceptance_commands[]",
            got: JSON.stringify(cmd),
            message: "acceptance_commands entries must be non-empty strings",
          }));
        }
      }
    }

    // acceptance_criteria: optional array (KD-1, KD-3, KD-15). Never read a
    // named test file and never run argv here — that happens at verification
    // time (Q-5); this validator checks only the shape.
    if (metadata.acceptance_criteria !== undefined) {
      if (!Array.isArray(metadata.acceptance_criteria)) {
        errors.push(new ValidationError({
          code: ERROR_CODES.SPEC_CRITERIA_INVALID,
          category: "spec",
          file: prefix,
          pointer: "/acceptance_criteria",
          message: "acceptance_criteria must be an array",
        }));
      } else {
        const seenIds = new Set();
        metadata.acceptance_criteria.forEach((criterion, index) => {
          errors.push(...validateCriterion(criterion, index, seenIds, prefix));
        });
      }
    }

    // depends_on_specs: must be an array (can be empty).
    if (!Array.isArray(metadata.depends_on_specs)) {
      errors.push(new ValidationError({
        code: ERROR_CODES.SPEC_MISSING_REQUIRED_FIELD,
        category: "spec",
        file: prefix,
        pointer: "depends_on_specs",
        message: "depends_on_specs must be an array",
      }));
    }

    // active_prs: must be an array (can be empty).
    if (!Array.isArray(metadata.active_prs)) {
      errors.push(new ValidationError({
        code: ERROR_CODES.SPEC_MISSING_REQUIRED_FIELD,
        category: "spec",
        file: prefix,
        pointer: "active_prs",
        message: "active_prs must be an array",
      }));
    }
  }

  // §7 constraints must not promise a threshold without stating it.
  for (const specDir of specDirs) {
    const nfrRelative = `docs/specs/${specDir}/spec/7-non-functional-requirements.md`;
    if (!pathExists(ctx, nfrRelative)) continue;

    let body;
    try {
      body = readText(ctx, nfrRelative);
    } catch {
      continue;
    }

    for (const constraint of findUnquantifiedConstraints(body)) {
      errors.push(new ValidationError({
        code: ERROR_CODES.SPEC_NFR_UNQUANTIFIED,
        category: "spec",
        file: `${nfrRelative}:${constraint.line}`,
        pointer: constraint.tag,
        got: constraint.text,
        message: `${constraint.tag} uses a comparative but states no value`,
        hint: "give the metric, the threshold and what happens on breach — or reword as an invariant if no threshold applies",
      }));
    }
  }

  // Cross-spec: depends_on_specs references must resolve.
  for (const specDir of specDirs) {
    const specJsonRelative = `docs/specs/${specDir}/spec.json`;
    if (!pathExists(ctx, specJsonRelative)) continue;
    let metadata;
    try {
      metadata = readJson(ctx, specJsonRelative);
    } catch {
      continue;
    }
    for (const dependency of metadata.depends_on_specs ?? []) {
      if (typeof dependency !== "string" || !dependency.trim()) continue;
      if (!specIds.has(dependency)) {
        errors.push(new ValidationError({
          code: ERROR_CODES.SPEC_DEPENDENCY_UNKNOWN,
          category: "spec",
          file: `docs/specs/${specDir}`,
          pointer: "depends_on_specs",
          got: dependency,
          message: `depends_on_specs references unknown spec "${dependency}"`,
        }));
      }
    }
  }

  return { ok: errors.length === 0, errors };
}
