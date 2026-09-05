/** Stable quality profile names. */
export const QUALITY_PROFILES = Object.freeze(["fast", "pr", "deep"]);

/** Stable policy classes. */
export const QUALITY_RULE_CLASSES = Object.freeze([
  "hard",
  "regression",
  "budget",
  "advisory",
  "semantic",
]);

/** Stable measurement states. */
export const QUALITY_STATES = Object.freeze([
  "checked",
  "unsupported",
  "not_configured",
  "unavailable",
  "not_applicable",
  "skipped",
]);

/** Stable result verdicts. */
export const QUALITY_VERDICTS = Object.freeze(["pass", "fail", "warn", "info"]);

/** Tool capabilities accepted by project configuration. */
export const QUALITY_CAPABILITIES = Object.freeze([
  "format",
  "compile",
  "typecheck",
  "lint",
  "test",
  "coverage",
  "complexity",
  "mutation",
  "dead-code",
  "dependencies",
  "duplication",
  "security",
  "race",
]);

/** Report formats accepted by project configuration. */
export const QUALITY_REPORT_FORMATS = Object.freeze([
  "exit-code",
  "go-coverprofile",
  "coveragepy-json",
  "istanbul-json",
  "lcov",
  "sarif",
  "golangci-json",
  "eslint-json",
  "ruff-json",
  "jscpd-json",
  "stryker-json",
  "dotbabel-v1",
]);

/** Version of the normalized quality result envelope. */
export const QUALITY_RESULT_SCHEMA_VERSION = 1;

/** Version of committed quality baseline files. */
export const QUALITY_BASELINE_SCHEMA_VERSION = 1;
