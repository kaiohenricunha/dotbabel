import fs from "node:fs";
import path from "node:path";

import { capabilityInProfile, capabilityRules } from "./shared.mjs";

/**
 * Built-in mutation-tool detection (KD-7) under the declared-tool-only rule
 * (KD-8): a tool is planned only when the repository CONFIGURES it. `dotbabel
 * quality` never installs a checker, so planning `npx stryker` for a project
 * that has never configured Stryker yields a plan that can only resolve
 * through `on_unavailable` — which reads as a finding rather than as "there is
 * nothing to measure here".
 *
 * Mutation lives in `DEEP_CAPABILITIES` alone, so `capabilityInProfile` keeps
 * every plan below out of the fast and pr profiles. That gate is not repeated
 * per tool; it is applied once, at the end.
 */

function has(root, name) { return fs.existsSync(path.join(root, name)); }

function read(root, name) {
  try { return fs.readFileSync(path.join(root, name), "utf8"); } catch { return null; }
}

const STRYKER_CONFIG_FILES = [
  "stryker.conf.json", "stryker.config.json", ".stryker.conf.json",
  "stryker.conf.js", "stryker.config.js", "stryker.conf.mjs", "stryker.config.mjs",
  "stryker.conf.cjs", "stryker.config.cjs",
];

/** Stryker's `jsonReporter.fileName` default, used when the config sets none. */
const STRYKER_DEFAULT_REPORT_PATH = "reports/mutation/mutation.json";

/**
 * The report path this repository's Stryker will actually write to.
 *
 * `jsonReporter.fileName` is a configuration key, not a contract — the
 * captured fixture carries it. Assuming the default for a repository that
 * overrides it produces no report at the expected path, which resolves
 * through `on_unavailable: info` and reads as a silent pass rather than as a
 * missing measurement. Only the JSON config forms can be read this way; a
 * `.js`/`.mjs` config would have to be executed, so those keep the default and
 * `docs/quality.md` names the project-tool override as the escape hatch.
 */
function strykerReportPath(root) {
  for (const file of STRYKER_CONFIG_FILES.filter((name) => name.endsWith(".json"))) {
    const text = read(root, file);
    if (text === null) continue;
    try {
      const name = JSON.parse(text)?.jsonReporter?.fileName;
      if (typeof name === "string" && name.length > 0) return name;
    } catch { /* a malformed config is the tool's problem to report, not ours */ }
  }
  try {
    const name = JSON.parse(read(root, "package.json") ?? "{}")?.stryker?.jsonReporter?.fileName;
    if (typeof name === "string" && name.length > 0) return name;
  } catch { /* same */ }
  return STRYKER_DEFAULT_REPORT_PATH;
}

const GREMLINS_CONFIG_FILES = [".gremlins.yaml", ".gremlins.yml", "gremlins.yaml", "gremlins.yml"];

/** Where the built-in Gremlins plan is told to write. */
const GREMLINS_REPORT_PATH = ".dotbabel/quality/gremlins.json";

function declaresStryker(root) {
  if (STRYKER_CONFIG_FILES.some((file) => has(root, file))) return true;
  // Stryker also reads its configuration from a `stryker` key in package.json.
  try { return Object.hasOwn(JSON.parse(read(root, "package.json") ?? "{}"), "stryker"); } catch { return false; }
}

function declaresMutmut(root) {
  // `[ \t]*`, not `\s*`: `\s` matches a newline, so pairing it with a
  // multiline `^` makes the engine re-scan the file from every line start —
  // quadratic on a file of many blank lines. Same reasoning as `declaresPytest`
  // in python.mjs, and this also runs on a checkout that may come from an
  // untrusted fork.
  if (/^[ \t]*\[tool\.mutmut\]/m.test(read(root, "pyproject.toml") ?? "")) return true;
  return /^[ \t]*\[mutmut\]/m.test(read(root, "setup.cfg") ?? "");
}

function plan(component, extra) {
  return { id: `${component.id}:mutation`, componentId: component.id, capability: "mutation", ruleIds: capabilityRules("mutation"), cwd: component.absoluteRoot, ...extra };
}

/**
 * Mutation plans for one component, or `[]` when the repository declares no
 * mutation tool for its language.
 *
 * @param {object} component
 * @param {string} profile
 * @param {Set<string>} claimed Capabilities a higher-priority source already planned.
 * @returns {object[]}
 */
export function mutationToolPlans(component, profile, claimed) {
  // Mutation is never an escalated test, so `includeTests` does not apply: the
  // profile gate is absolute.
  if (claimed.has("mutation") || !capabilityInProfile("mutation", profile)) return [];
  const root = component.absoluteRoot;
  if (!root) return [];

  if (["javascript", "typescript"].includes(component.language) && declaresStryker(root)) {
    // The binary must be resolved here rather than deferred to `npx`, because
    // `npx` ALWAYS spawns successfully. `runner.mjs` derives `unavailable`
    // from a SPAWN error, which is why a missing `golangci-lint` (ENOENT)
    // correctly becomes `unavailable` — but `npx stryker` on a repository that
    // never installed the package exits non-zero instead, landing as `checked`
    // and HARD-FAILING mutation.changed_score. That turns "nothing to measure"
    // into a blocking finding, the exact outcome this module exists to avoid.
    // `typescript.mjs` resolves `tsc` against the local bin for the same reason.
    if (!has(root, path.join("node_modules", ".bin", "stryker"))) {
      return [plan(component, {
        availability: "not_configured",
        source: "configured",
        evidence: "Stryker is configured here but is not installed in node_modules — install @stryker-mutator/core, or declare a project mutation tool whose command runs it",
      })];
    }
    // `candidate`, not `available`: the binary exists, but whether it runs is
    // still the execution's verdict to report.
    return [plan(component, {
      executable: "./node_modules/.bin/stryker",
      argv: ["run", "--reporters", "json"],
      report: { format: "stryker-json", path: strykerReportPath(root) },
      availability: "candidate",
      source: "configured",
      requiresTrust: true,
    })];
  }

  if (component.language === "go" && GREMLINS_CONFIG_FILES.some((file) => has(root, file))) {
    return [plan(component, {
      executable: "gremlins",
      argv: ["unleash", `--output=${GREMLINS_REPORT_PATH}`, "."],
      report: { format: "gremlins-json", path: GREMLINS_REPORT_PATH },
      availability: "candidate",
      source: "configured",
      requiresTrust: true,
    })];
  }

  if (component.language === "python" && declaresMutmut(root)) {
    // mutmut needs `mutmut run` and THEN `mutmut export-cicd-stats`, and
    // neither accepts an output path (verified against mutmut 3.8.0: `run`
    // takes only `--max-children`, `export-cicd-stats` takes no options and
    // writes `mutmut-stats.json` into the working directory). A plan is one
    // argv with no shell, so there is no honest built-in command here. Report
    // the tool and name the remediation instead of planning something that
    // could only ever produce a missing report.
    return [plan(component, {
      availability: "not_configured",
      source: "configured",
      evidence: "mutmut is configured here but needs two commands — `mutmut run` then `mutmut export-cicd-stats` — so declare it as a project mutation tool whose command produces mutmut-stats.json",
    })];
  }

  return [];
}
