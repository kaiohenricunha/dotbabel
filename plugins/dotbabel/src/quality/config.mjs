import fs from "node:fs";
import path from "node:path";

import { configDir } from "../lib/paths.mjs";
import { ERROR_CODES, ValidationError } from "../lib/errors.mjs";
import {
  QUALITY_CAPABILITIES,
  QUALITY_PROFILES,
  QUALITY_REPORT_FORMATS,
} from "./types.mjs";
import { FORBIDDEN_EXCEPTION_RULES, QUALITY_RULES, SHIPPED_QUALITY_DEFAULTS, hashQualityPolicy } from "./policy.mjs";

const QUALITY_KEYS = new Set([
  "enabled", "default_profile", "base_ref", "baseline_file", "exclude",
  "critical_paths", "rules", "components", "exceptions",
]);
const RULE_KEYS = new Set(["enabled", "level", "threshold", "scope", "on_unavailable", "profiles"]);
const COMPONENT_KEYS = new Set(["root", "languages", "tools"]);
const TOOL_KEYS = new Set(["argv", "timeout_seconds", "report"]);
const REPORT_KEYS = new Set(["format", "path"]);
const EXCEPTION_KEYS = new Set(["id", "rule", "fingerprint", "reason", "expires", "tracking"]);
const PROJECT_ONLY = new Set(["base_ref", "baseline_file", "critical_paths", "components", "exceptions"]);

function qualityError(message, pointer, source) {
  return new ValidationError({
    code: ERROR_CODES.QUALITY_CONFIG_INVALID,
    category: "quality",
    file: source === "user" ? "quality.json" : ".dotbabel.json",
    pointer,
    message,
  });
}

function object(value, label, source, pointer) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw qualityError(`${label} must be an object`, pointer, source);
  }
}

function rejectKeys(value, allowed, label, source, pointer) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw qualityError(`unknown ${label} key: ${key}`, `${pointer}/${key}`, source);
  }
}

function relativePath(value, label, source, pointer) {
  if (typeof value !== "string" || value.length === 0 || path.isAbsolute(value)) {
    throw qualityError(`${label} must be a repository-relative path`, pointer, source);
  }
  const normalized = path.posix.normalize(value.replaceAll("\\", "/"));
  if (normalized === ".." || normalized.startsWith("../")) {
    throw qualityError(`${label} must be a repository-relative path without '..'`, pointer, source);
  }
  return normalized === "" ? "." : normalized;
}

function validateTool(tool, source, pointer) {
  object(tool, "tool", source, pointer);
  rejectKeys(tool, TOOL_KEYS, "tool", source, pointer);
  if (!Array.isArray(tool.argv) || tool.argv.length === 0 || tool.argv.some((arg) => typeof arg !== "string" || arg.length === 0 || arg.includes("\0"))) {
    throw qualityError("tool argv must be a non-empty array of safe strings", `${pointer}/argv`, source);
  }
  const executable = tool.argv[0];
  if (path.isAbsolute(executable) || (executable.includes("/") && !executable.startsWith("./"))) {
    throw qualityError("tool executable must be a PATH name or repository-relative './' path", `${pointer}/argv/0`, source);
  }
  if (tool.timeout_seconds !== undefined && (!Number.isInteger(tool.timeout_seconds) || tool.timeout_seconds < 1 || tool.timeout_seconds > 3600)) {
    throw qualityError("timeout_seconds must be an integer from 1 through 3600", `${pointer}/timeout_seconds`, source);
  }
  if (tool.report !== undefined) {
    object(tool.report, "tool report", source, `${pointer}/report`);
    rejectKeys(tool.report, REPORT_KEYS, "report", source, `${pointer}/report`);
    if (!QUALITY_REPORT_FORMATS.includes(tool.report.format)) throw qualityError("unknown quality report format", `${pointer}/report/format`, source);
    if (tool.report.format !== "exit-code") relativePath(tool.report.path, "report path", source, `${pointer}/report/path`);
  }
}

/** Validate a user or project quality object and return it unchanged. */
export function validateQualityConfig(value, { source = "project" } = {}) {
  object(value, "quality", source, "/quality");
  rejectKeys(value, QUALITY_KEYS, "quality", source, "/quality");
  if (source === "user") {
    for (const key of PROJECT_ONLY) {
      if (value[key] !== undefined) throw qualityError(`${key} is project-only`, `/quality/${key}`, source);
    }
  }
  if (value.enabled !== undefined && typeof value.enabled !== "boolean") throw qualityError("enabled must be boolean", "/quality/enabled", source);
  if (value.default_profile !== undefined && !QUALITY_PROFILES.includes(value.default_profile)) throw qualityError("unknown quality profile", "/quality/default_profile", source);
  for (const name of ["baseline_file"]) if (value[name] !== undefined) relativePath(value[name], name, source, `/quality/${name}`);
  for (const name of ["exclude", "critical_paths"]) {
    if (value[name] !== undefined && (!Array.isArray(value[name]) || value[name].some((item) => typeof item !== "string" || item.length === 0))) throw qualityError(`${name} must be an array of non-empty strings`, `/quality/${name}`, source);
  }
  if (value.rules !== undefined) {
    object(value.rules, "rules", source, "/quality/rules");
    for (const [id, override] of Object.entries(value.rules)) {
      const definition = QUALITY_RULES[id];
      if (!definition) throw qualityError(`unknown quality rule: ${id}`, `/quality/rules/${id}`, source);
      object(override, "rule override", source, `/quality/rules/${id}`);
      rejectKeys(override, RULE_KEYS, "rule override", source, `/quality/rules/${id}`);
      if (override.threshold !== undefined) {
        if (definition.threshold === undefined) throw qualityError(`rule ${id} does not own a threshold`, `/quality/rules/${id}/threshold`, source);
        if (!Number.isFinite(override.threshold) || override.threshold < 0) throw qualityError("threshold must be a non-negative number", `/quality/rules/${id}/threshold`, source);
        if (["percent", "score"].includes(definition.unit) && override.threshold > 100) throw qualityError("percent and score thresholds must be 0 through 100", `/quality/rules/${id}/threshold`, source);
      }
      if (override.level !== undefined && !["error", "warning", "info"].includes(override.level)) throw qualityError("unknown rule level", `/quality/rules/${id}/level`, source);
      if (override.on_unavailable !== undefined && !["error", "warning", "info"].includes(override.on_unavailable)) throw qualityError("unknown on_unavailable level", `/quality/rules/${id}/on_unavailable`, source);
      if (override.scope !== undefined && !["changed", "component", "repository"].includes(override.scope)) throw qualityError("unknown rule scope", `/quality/rules/${id}/scope`, source);
      if (override.profiles !== undefined && (!Array.isArray(override.profiles) || override.profiles.some((profile) => !QUALITY_PROFILES.includes(profile)))) throw qualityError("unknown rule profile", `/quality/rules/${id}/profiles`, source);
    }
  }
  if (value.components !== undefined) {
    if (!Array.isArray(value.components)) throw qualityError("components must be an array", "/quality/components", source);
    for (const [index, component] of value.components.entries()) {
      const pointer = `/quality/components/${index}`;
      object(component, "component", source, pointer);
      rejectKeys(component, COMPONENT_KEYS, "component", source, pointer);
      relativePath(component.root, "component root", source, `${pointer}/root`);
      if (!Array.isArray(component.languages) || component.languages.length === 0 || component.languages.some((item) => typeof item !== "string" || item.length === 0)) throw qualityError("component languages must be non-empty strings", `${pointer}/languages`, source);
      if (component.tools !== undefined) {
        object(component.tools, "component tools", source, `${pointer}/tools`);
        for (const [capability, tool] of Object.entries(component.tools)) {
          if (!QUALITY_CAPABILITIES.includes(capability)) throw qualityError(`unknown tool capability: ${capability}`, `${pointer}/tools/${capability}`, source);
          validateTool(tool, source, `${pointer}/tools/${capability}`);
        }
      }
    }
  }
  if (value.exceptions !== undefined) {
    if (!Array.isArray(value.exceptions)) throw qualityError("exceptions must be an array", "/quality/exceptions", source);
    const ids = new Set();
    for (const [index, exception] of value.exceptions.entries()) {
      const pointer = `/quality/exceptions/${index}`;
      object(exception, "exception", source, pointer);
      rejectKeys(exception, EXCEPTION_KEYS, "exception", source, pointer);
      if (!/^QEX-[0-9]+$/.test(exception.id ?? "") || ids.has(exception.id)) throw qualityError("exception id must be a unique QEX-<number>", `${pointer}/id`, source);
      ids.add(exception.id);
      if (!QUALITY_RULES[exception.rule]) throw qualityError("exception rule is unknown", `${pointer}/rule`, source);
      if (FORBIDDEN_EXCEPTION_RULES.has(exception.rule)) throw qualityError(`exceptions cannot apply to ${exception.rule}`, `${pointer}/rule`, source);
      if (typeof exception.fingerprint !== "string" || !exception.fingerprint.startsWith("sha256:")) throw qualityError("exception fingerprint must start with sha256:", `${pointer}/fingerprint`, source);
      if (typeof exception.reason !== "string" || exception.reason.trim().length === 0) throw qualityError("exception reason is required", `${pointer}/reason`, source);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(exception.expires ?? "") || Number.isNaN(Date.parse(`${exception.expires}T00:00:00Z`))) throw qualityError("exception expires must be an ISO date", `${pointer}/expires`, source);
      if (exception.tracking !== undefined) { try { new URL(exception.tracking); } catch { throw qualityError("exception tracking must be a URL", `${pointer}/tracking`, source); } }
    }
  }
  return value;
}

function readJson(file, required = false) {
  if (!fs.existsSync(file)) return undefined;
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch (error) {
    if (!required) throw qualityError(`cannot parse ${path.basename(file)}: ${error.message}`, "/", file.endsWith("quality.json") ? "user" : "project");
    throw error;
  }
}

function normalizePatterns(values) {
  return [...new Set(values.map((item) => path.posix.normalize(item.replaceAll("\\", "/"))))];
}

function mergeRules(userRules = {}, projectRules = {}) {
  const result = {};
  for (const [id, definition] of Object.entries(QUALITY_RULES)) {
    const user = userRules[id] ?? {};
    const project = projectRules[id] ?? {};
    const merged = { ...definition, ...user, ...project };
    merged.level = merged.level ?? merged.default_level;
    merged.provenance = {};
    for (const key of ["enabled", "level", "threshold", "scope", "on_unavailable", "profiles"]) {
      merged.provenance[key] = project[key] !== undefined ? "project" : user[key] !== undefined ? "user" : "shipped";
    }
    result[id] = merged;
  }
  return result;
}

/** Resolve shipped, user, project, and operational quality policy layers. */
export function resolveQualityPolicy({ repoRoot, env = process.env, profile, base, head, jobs } = {}) {
  const userPath = path.join(configDir(env), "quality.json");
  const user = readJson(userPath) ?? {};
  validateQualityConfig(user, { source: "user" });
  const projectFile = path.join(repoRoot ?? process.cwd(), ".dotbabel.json");
  const projectDocument = readJson(projectFile) ?? {};
  const project = projectDocument.quality ?? {};
  validateQualityConfig(project, { source: "project" });
  const result = {
    ...SHIPPED_QUALITY_DEFAULTS,
    ...user,
    ...project,
    exclude: normalizePatterns([...(SHIPPED_QUALITY_DEFAULTS.exclude ?? []), ...(user.exclude ?? []), ...(project.exclude ?? [])]),
    critical_paths: project.critical_paths ?? SHIPPED_QUALITY_DEFAULTS.critical_paths,
    components: project.components ?? SHIPPED_QUALITY_DEFAULTS.components,
    exceptions: project.exceptions ?? SHIPPED_QUALITY_DEFAULTS.exceptions,
    rules: mergeRules(user.rules, project.rules),
    provenance: {
      enabled: project.enabled !== undefined ? "project" : user.enabled !== undefined ? "user" : "shipped",
      default_profile: project.default_profile !== undefined ? "project" : user.default_profile !== undefined ? "user" : "shipped",
    },
  };
  if (profile !== undefined) result.default_profile = profile;
  // base_ref/head_ref/jobs are run metadata (the revisions being diffed, the
  // concurrency level), not policy content — excluded so the hash reflects
  // only what can change a verdict, and stays stable across the same policy
  // run against different commits.
  const { base_ref: _baseRef, head_ref: _headRef, jobs: _jobs, ...hashable } = result;
  result.policy_hash = hashQualityPolicy(hashable);
  if (base !== undefined) result.base_ref = base;
  if (head !== undefined) result.head_ref = head;
  if (jobs !== undefined) result.jobs = jobs;
  return result;
}
