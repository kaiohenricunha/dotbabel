/**
 * JUnit XML parsing and test-name confirmation for `acceptance_criteria`
 * (P-B1, KD-1, KD-3, SEC-11).
 *
 * The parser is intentionally minimal: it recognizes only the `<testsuites>`
 * / `<testsuite>` / `<testcase>` subset that every JUnit-XML-producing
 * runner emits, plus a `<failure>`, `<error>`, or `<skipped>` child. It never
 * reads a DOCTYPE, never expands a named entity beyond the five predefined by
 * XML itself (`lt`, `gt`, `amp`, `apos`, `quot`) plus numeric character
 * references, and it never reads past 10 MiB (SEC-11) — the size is checked
 * with `fs.statSync` before any read.
 */
import fs from "node:fs";

const MAX_REPORT_BYTES = 10 * 1024 * 1024;

/** Raised for any JUnit report this module refuses or fails to parse. */
export class CriteriaReportError extends Error {}

/**
 * Read and parse a JUnit XML report from disk.
 *
 * @param {string} absolutePath
 * @returns {{ testcases: { name: string, outcome: "passed"|"failed"|"error"|"skipped" }[] }}
 * @throws {CriteriaReportError} when the file is missing, too large, declares
 *   a DOCTYPE, or does not parse as a JUnit report.
 */
export function parseJUnitReport(absolutePath) {
  let stat;
  try {
    stat = fs.statSync(absolutePath);
  } catch {
    throw new CriteriaReportError(`report was not rewritten by this run: ${absolutePath}`);
  }
  if (stat.size > MAX_REPORT_BYTES) {
    throw new CriteriaReportError(`report exceeds the 10 MiB limit: ${absolutePath}`);
  }
  const text = fs.readFileSync(absolutePath, "utf8");
  return parseJUnitText(text);
}

/**
 * Parse JUnit XML already read into memory. Exported separately so tests can
 * exercise the parser without touching the filesystem.
 *
 * @param {string} text
 * @returns {{ testcases: { name: string, outcome: "passed"|"failed"|"error"|"skipped" }[] }}
 */
export function parseJUnitText(text) {
  if (/<!DOCTYPE/i.test(text)) {
    throw new CriteriaReportError("report declares a DOCTYPE, which is refused (SEC-11)");
  }
  if (!/<testsuite\b/i.test(text)) {
    throw new CriteriaReportError("report does not contain a <testsuite> element");
  }

  const testcases = [];
  // The attrs group matches zero or more whitespace-separated `name="value"`
  // pairs, each value delimited by its own quotes — not a blanket `[^>]*`,
  // because a quoted attribute value (a test name with " > " in it, as
  // Vitest's nested describe/it names have) may legally contain a raw `>`
  // that a naive "anything but >" match would mistake for the tag's end.
  // Non-capturing on purpose: one attribute is `\s+name\s*=\s*(?:"..."|'...')`
  // with no capture groups of its own, so the outer TESTCASE_RE's group
  // numbering (attrs, the /> vs > branch, body) stays fixed regardless of
  // how many attributes a tag carries.
  const ATTR_SOURCE = String.raw`\s+[a-zA-Z_:][-a-zA-Z0-9_:.]*\s*=\s*(?:"[^"]*"|'[^']*')`;
  const TESTCASE_RE = new RegExp(`<testcase\\b((?:${ATTR_SOURCE})*)\\s*(/>|>([\\s\\S]*?)<\\/testcase>)`, "g");
  let match;
  while ((match = TESTCASE_RE.exec(text)) !== null) {
    const [, attrs, , body] = match;
    const name = readAttribute(attrs, "name");
    if (name === null) continue; // a nameless testcase confirms nothing; skip it
    const outcome = body === undefined ? "passed" : outcomeOf(body);
    testcases.push({ name: unescapeXml(name), outcome });
  }
  return { testcases };
}

function outcomeOf(body) {
  if (/<failure\b/i.test(body)) return "failed";
  if (/<error\b/i.test(body)) return "error";
  if (/<skipped\b/i.test(body)) return "skipped";
  return "passed";
}

function readAttribute(attrs, key) {
  // The boundary before `key` must be whitespace (or start of string), or
  // "name" would also match inside "classname=" — attrs always starts with
  // a leading space per ATTR_SOURCE above, so requiring \s is sufficient.
  const rx = new RegExp(`[\\s]${key}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "i");
  const m = attrs.match(rx);
  if (!m) return null;
  return m[1] ?? m[2] ?? "";
}

// Only the five XML-predefined entities and numeric character references are
// ever resolved. Anything else — including any name a DOCTYPE could have
// declared — is left as literal text, so no custom entity is ever expanded.
function unescapeXml(value) {
  return value.replace(/&(lt|gt|amp|apos|quot|#x[0-9a-fA-F]+|#[0-9]+);/g, (whole, entity) => {
    switch (entity) {
      case "lt":
        return "<";
      case "gt":
        return ">";
      case "amp":
        return "&";
      case "apos":
        return "'";
      case "quot":
        return '"';
      default: {
        const codePoint = entity[1] === "x" ? Number.parseInt(entity.slice(2), 16) : Number.parseInt(entity.slice(1), 10);
        // String.fromCodePoint throws RangeError outside 0..0x10FFFF; leaving
        // the reference unresolved (rather than letting that escape as an
        // uncaught RangeError) keeps every failure inside this module's own
        // CriteriaReportError contract.
        const valid = Number.isInteger(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff;
        return valid ? String.fromCodePoint(codePoint) : whole;
      }
    }
  });
}

const SEPARATORS = [">", "::", ".", "/"];

/**
 * Whether a reported test name (from a JUnit report or from raw command
 * output) confirms a criterion's declared test name: an exact match, or a
 * suffix match after the last `>`, `::`, `.`, or `/` (KD-3).
 *
 * @param {string} reportedName
 * @param {string} criterionName
 * @returns {boolean}
 */
export function junitNameMatches(reportedName, criterionName) {
  const reported = reportedName.trim();
  const target = criterionName.trim();
  if (reported === target) return true;
  for (const separator of SEPARATORS) {
    const index = reported.lastIndexOf(separator);
    if (index === -1) continue;
    if (reported.slice(index + separator.length).trim() === target) return true;
  }
  return false;
}

/**
 * Confirm one named test against a JUnit report's testcases, or (with no
 * report) against raw command output text.
 *
 * @param {{ file: string, name: string }} test
 * @param {{ testcases: { name: string, outcome: string }[] } | null} report
 * @param {string} outputText  Combined stdout+stderr, already redacted by the
 *   runner (`quality/runner.mjs`) before this module ever sees it — so a test
 *   name that happens to look secret-shaped (matching a redaction rule) can
 *   never be confirmed this way; it reports `absent` instead.
 * @returns {{ found_in_file: true, confirmed_by: "junit", result: "passed"|"failed"|"error"|"skipped"|"absent" } | { found_in_file: true, confirmed_by: "output", result: "passed"|"absent" }}
 *   Only JUnit-report confirmation can distinguish failed/error/skipped;
 *   output-only confirmation can only ever say a name was found or not.
 */
export function confirmTest(test, report, outputText) {
  if (report) {
    const match = report.testcases.find((testcase) => junitNameMatches(testcase.name, test.name));
    if (!match) return { found_in_file: true, confirmed_by: "junit", result: "absent" };
    return { found_in_file: true, confirmed_by: "junit", result: match.outcome };
  }
  // outputText.includes(test.name) alone is sufficient: any junitNameMatches
  // match against a line (exact, or a suffix after a separator) is itself a
  // substring of that line, so it is already a substring of outputText — a
  // separate per-line scan can never find a match this check would miss.
  const found = outputText.includes(test.name);
  return { found_in_file: true, confirmed_by: "output", result: found ? "passed" : "absent" };
}
