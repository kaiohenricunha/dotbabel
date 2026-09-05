import { createHash } from "node:crypto";

import { QUALITY_PROFILES as PROFILE_NAMES } from "./types.mjs";

/** Fixed quality profiles. */
export const QUALITY_PROFILES = PROFILE_NAMES;

const all = PROFILE_NAMES;
const fast = ["fast", "pr", "deep"];
const pr = ["pr", "deep"];
const deep = ["deep"];

function rule(id, ruleClass, scope, profiles, level, unavailable, threshold, unit, direction) {
  return Object.freeze({
    id,
    class: ruleClass,
    scope,
    profiles: Object.freeze(profiles),
    default_level: level,
    on_unavailable: unavailable,
    ...(threshold === undefined ? {} : { threshold }),
    ...(unit === undefined ? {} : { unit }),
    ...(direction === undefined ? {} : { direction }),
  });
}

/** Shipped rule definitions. Numeric defaults have one executable owner. */
export const QUALITY_RULES = Object.freeze(Object.fromEntries([
  rule("correctness.format", "hard", "changed", fast, "error", "error"),
  rule("correctness.compile", "hard", "component", fast, "error", "error"),
  rule("correctness.types", "hard", "component", fast, "error", "error"),
  rule("correctness.tests", "hard", "component", pr, "error", "error"),
  rule("correctness.lint", "hard", "component", fast, "error", "error"),
  rule("security.high_confidence", "hard", "component", pr, "error", "warning"),
  rule("coverage.no_regression", "regression", "component", pr, "error", "error", undefined, "percent", "min"),
  rule("complexity.cognitive", "budget", "changed", fast, "error", "warning", 15, "count", "max"),
  rule("complexity.cyclomatic", "budget", "changed", fast, "error", "warning", 15, "count", "max"),
  rule("coverage.changed_lines", "budget", "changed", pr, "error", "error", 90, "percent", "min"),
  rule("coverage.changed_branches", "budget", "changed", pr, "error", "info", 90, "percent", "min"),
  rule("mutation.changed_score", "budget", "changed", deep, "error", "info", 85, "score", "min"),
  rule("duplication.percent", "budget", "component", pr, "error", "warning", 5, "percent", "max"),
  rule("size.function_loc", "advisory", "changed", fast, "warning", "info", 75, "loc", "max"),
  rule("size.file_loc", "advisory", "changed", fast, "warning", "info", 500, "loc", "max"),
  rule("maintainability.dead_code", "advisory", "changed", pr, "warning", "info"),
  rule("maintainability.unused_dependencies", "advisory", "changed", pr, "warning", "info"),
  rule("semantic.ignored_errors", "semantic", "changed", fast, "warning", "info"),
  rule("semantic.swallowed_errors", "semantic", "changed", fast, "warning", "info"),
  rule("semantic.dynamic_types", "semantic", "changed", fast, "warning", "info"),
  rule("semantic.unchecked_assertions", "semantic", "changed", fast, "warning", "info"),
  rule("semantic.unbounded_concurrency", "semantic", "changed", fast, "warning", "info"),
  rule("semantic.lifecycle", "semantic", "changed", fast, "warning", "info"),
  rule("architecture.speculative_abstraction", "semantic", "changed", fast, "warning", "info"),
  rule("policy.new_suppression", "advisory", "changed", all, "warning", "info"),
].map((item) => [item.id, item])));

/** Shipped non-rule defaults. */
export const SHIPPED_QUALITY_DEFAULTS = Object.freeze({
  enabled: true,
  default_profile: "fast",
  baseline_file: ".dotbabel/quality-baseline.json",
  exclude: Object.freeze([
    "vendor/**",
    "node_modules/**",
    ".venv/**",
    "dist/**",
    "build/**",
  ]),
  critical_paths: Object.freeze([]),
  components: Object.freeze([]),
  exceptions: Object.freeze([]),
});

/** Compare one measured value against a rule threshold. Limits are inclusive. */
export function compareThreshold(ruleDefinition, actual) {
  if (ruleDefinition.threshold === undefined || !Number.isFinite(actual)) return true;
  return ruleDefinition.direction === "min"
    ? actual >= ruleDefinition.threshold
    : actual <= ruleDefinition.threshold;
}

/** Return enabled shipped rules that belong to a profile. */
export function selectProfileRules(profile, rules = QUALITY_RULES) {
  if (!PROFILE_NAMES.includes(profile)) throw new Error(`unknown quality profile: ${profile}`);
  return Object.values(rules).filter((item) => item.enabled !== false && item.profiles.includes(profile));
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  }
  return value;
}

/** Compute a deterministic SHA-256 policy hash. */
export function hashQualityPolicy(policy) {
  return `sha256:${createHash("sha256").update(JSON.stringify(stable(policy))).digest("hex")}`;
}
