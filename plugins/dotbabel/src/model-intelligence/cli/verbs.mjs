/**
 * model-intelligence/cli/verbs — the one table of `dotbabel models` verbs (P-23,
 * docs/specs/model-intelligence §5 "CLI Surface").
 *
 * The usages and purposes of the first six verbs are copied verbatim from the §5 Commands table, so the
 * help and the spec cannot drift apart unnoticed: `model-intelligence-cli.test.mjs` reads that table.
 * `enable`, `disable` and `session` come from the adaptive-session-routing spec §5. `flags` lists the
 * verb-specific flags the bin accepts beyond the harness-wide set; any other flag is a usage error.
 * The table holds no domain behavior (IMPL-4).
 */

/**
 * @typedef {object} ModelsVerb
 * @property {string} name
 * @property {ReadonlyArray<{usage: string, purpose: string}>} forms Each documented invocation and its purpose.
 * @property {ReadonlyArray<string>} flags
 */

/** @type {ReadonlyArray<Readonly<ModelsVerb>>} */
export const MODELS_VERBS = Object.freeze([
  { name: "refresh", forms: [{ usage: "refresh [--source <id>] [--runtime <id>]", purpose: "Refresh runtime/catalog evidence" }], flags: ["source", "runtime"] },
  { name: "status", forms: [{ usage: "status [--json] [--check]", purpose: "Inspect source support, cache freshness, runtime availability, projections, and release baselines" }], flags: ["check", "repo-root", "snapshot-file"] },
  {
    name: "resolve",
    forms: [
      { usage: "resolve <artifact> --runtime <id> [--json]", purpose: "Resolve one artifact and explain the complete decision" },
      { usage: "resolve --requirement <class> --runtime <id> [options] [--json]", purpose: "Resolve an ad hoc semantic requirement without an artifact" },
    ],
    flags: ["repo-root", "runtime", "requirement", "artifact-kind"],
  },
  { name: "recommend", forms: [{ usage: "recommend <artifact> --runtime <id> [--json]", purpose: "Produce user-facing design-time/runtime advice from resolver output and observation" }], flags: ["repo-root", "runtime", "requirement", "artifact-kind", "observation-file"] },
  { name: "migrate", forms: [{ usage: "migrate [path] [--check | --write] [--json]", purpose: "Analyze or migrate legacy model/effort declarations to `dotbabel.compute`" }], flags: ["repo-root", "write", "check", "batch", "decisions"] },
  { name: "snapshot", forms: [{ usage: "snapshot [--check | --write] [--json]", purpose: "Validate or explicitly regenerate the release-time capability snapshot" }], flags: ["check", "write", "snapshot-file", "evidence-file"] },
  { name: "enable", forms: [{ usage: "enable [--routing] [--repo-root <path>] [--json]", purpose: "Opt this project in to Model Intelligence, or with --routing to adaptive routing; changes only these flags" }], flags: ["routing", "repo-root"] },
  { name: "disable", forms: [{ usage: "disable [--routing] [--repo-root <path>] [--json]", purpose: "Opt this project out of Model Intelligence, or with --routing out of adaptive routing only" }], flags: ["routing", "repo-root"] },
  {
    name: "session",
    forms: [{ usage: "session [--runtime codex|claude] [--model auto|<native-id>] [--effort auto|<native-value>]", purpose: "Run an enabled project's managed Codex terminal or native Claude UI with per-prompt routing" }],
    flags: ["repo-root", "runtime", "model", "effort"],
  },
].map((verb) => Object.freeze({ ...verb, forms: Object.freeze(verb.forms.map((form) => Object.freeze(form))), flags: Object.freeze([...verb.flags]) })));

/**
 * Render the verb section of `dotbabel models --help`: each documented form on its own line, with its
 * purpose indented below it, then the verb-specific flags the bin accepts. The flags line comes from
 * the same `flags` list the bin enforces, so a working flag cannot be missing from its verb's help.
 * @returns {string}
 */
export function renderVerbHelp() {
  return MODELS_VERBS.flatMap((verb) => [
    ...verb.forms.map((form) => `  ${form.usage}\n      ${form.purpose}`),
    `      flags: ${verb.flags.map((flag) => `--${flag}`).join(" ")}`,
  ]).join("\n");
}
