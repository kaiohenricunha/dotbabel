import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { makeTempDir } from "./fixtures/temp-dir.mjs";
import { snapshotTree } from "./fixtures/model-intelligence/fake-runner.mjs";
import { MODELS_VERBS, renderVerbHelp } from "../src/model-intelligence/cli/verbs.mjs";

const standalone = fileURLToPath(new URL("../bin/dotbabel-models.mjs", import.meta.url));
const umbrella = fileURLToPath(new URL("../bin/dotbabel.mjs", import.meta.url));
const specText = readFileSync(new URL("../../../docs/specs/model-intelligence/spec/5-interfaces-apis.md", import.meta.url), "utf8");
const routingSpec = readFileSync(new URL("../../../docs/specs/adaptive-session-routing/spec/5-interfaces-apis.md", import.meta.url), "utf8");

/** A repository with no cache, no config, no network, and a fake credential that must never be printed. */
function sandbox(project = {}) {
  const repo = makeTempDir("mi-cli-repo-");
  spawnSync("git", ["init", "--quiet", repo]);
  writeFileSync(join(repo, ".dotbabel.json"), JSON.stringify(project));
  mkdirSync(join(repo, "config"), { recursive: true });
  const env = { PATH: process.env.PATH, HOME: join(repo, "home"), XDG_CACHE_HOME: join(repo, "cache"), XDG_CONFIG_HOME: join(repo, "config"), ANTHROPIC_API_KEY: "fixture-credential-never-printed", GH_TOKEN: "fixture-token-never-printed", HTTPS_PROXY: "http://127.0.0.1:9", HTTP_PROXY: "http://127.0.0.1:9" };
  const run = (bin, args) => spawnSync(process.execPath, bin === "umbrella" ? [umbrella, "models", ...args] : [standalone, ...args], { cwd: repo, env, encoding: "utf8", timeout: 60_000 });
  return { repo, env, run };
}

/** The `dotbabel models …` rows of the §5 Commands table: [usage, purpose]. */
function specCommandRows() {
  const section = specText.slice(specText.indexOf("### Commands"), specText.indexOf("### `refresh`"));
  return section.split("\n").filter(line => line.startsWith("| `dotbabel models ")).map(line => line.split(/(?<!\\)\|/).map(cell => cell.trim().replaceAll("\\|", "|"))).map(cells => [cells[1].replace(/`/g, ""), cells[2]]);
}

describe("dotbabel models CLI consolidation (P-23)", () => {
  it("--help lists every verb with the same purpose as the spec's Commands table", () => {
    const rows = specCommandRows();
    expect(rows.length).toBe(7);
    const help = sandbox().run("standalone", ["--help"]);
    expect(help.status).toBe(0);
    for (const [usage, purpose] of rows) {
      expect(help.stdout, usage).toContain(usage.replace(/^dotbabel models /, ""));
      expect(help.stdout, usage).toContain(purpose);
    }
    // The adaptive-routing spec adds three verbs; their usage appears in its §5 prose.
    for (const verb of ["enable", "disable", "session"]) expect(help.stdout).toMatch(new RegExp(`^\\s+${verb}\\b`, "m"));
    expect(routingSpec).toContain("models enable|disable [--routing] [--repo-root <path>]");
  });

  it("one verb table drives both the help and the accepted verbs", () => {
    expect(MODELS_VERBS.map(verb => verb.name)).toEqual(["refresh", "status", "resolve", "recommend", "migrate", "snapshot", "enable", "disable", "session"]);
    for (const verb of MODELS_VERBS) { for (const form of verb.forms) expect(form.purpose.length, verb.name).toBeGreaterThan(10); expect(Array.isArray(verb.flags)).toBe(true); }
  });

  it("renderVerbHelp() prints each form on its own line with its purpose indented below", () => {
    const lines = renderVerbHelp().split("\n");
    const forms = MODELS_VERBS.flatMap(verb => verb.forms);
    expect(lines).toHaveLength(forms.length * 2);
    forms.forEach((form, index) => { expect(lines[index * 2]).toBe(`  ${form.usage}`); expect(lines[index * 2 + 1]).toBe(`      ${form.purpose}`); });
  });

  it("dotbabel models and dotbabel-models produce identical output for the same arguments", () => {
    const box = sandbox();
    for (const args of [["--help"], ["status", "--json"], ["resolve", "--requirement", "deep", "--runtime", "codex", "--json"], ["resolve", "--runtime", "no-such-runtime"], ["no-such-verb"]]) {
      const a = box.run("standalone", args), b = box.run("umbrella", args);
      expect(b.status, args.join(" ")).toBe(a.status);
      const stable = text => text.replace(/"(observedAt|generatedAt|checkedAt|now)": "[^"]*"/g, "").replace(/"releaseSnapshotAgeMs": \d+/g, "");
      expect(stable(b.stdout), args.join(" ")).toBe(stable(a.stdout));
    }
  });

  it("every verb maps its domain state to the shared exit codes 0, 1, 2 and 64 as §5 defines", () => {
    const box = sandbox();
    expect(box.run("standalone", ["status"]).status).toBe(0);
    expect(box.run("standalone", ["resolve", "--requirement", "deep", "--runtime", "codex", "--json"]).status).toBe(2);
    expect(box.run("standalone", ["resolve", "--requirement", "not-a-class", "--runtime", "codex"]).status).toBe(64);
    expect(box.run("standalone", ["resolve", "--requirement", "deep", "--runtime", "no-such-runtime"]).status).toBe(64);
    expect(box.run("standalone", ["no-such-verb"]).status).toBe(64);
    expect(box.run("standalone", ["snapshot", "--check", "--write"]).status).toBe(64);
    expect(box.run("standalone", ["migrate", "--check", "--write"]).status).toBe(64);
    const malformed = sandbox();
    writeFileSync(join(malformed.repo, ".dotbabel.json"), '{"private-policy-marker":');
    const invalid = malformed.run("standalone", ["resolve", "--requirement", "deep", "--runtime", "codex", "--json"]);
    expect(invalid.status).toBe(1);
    expect(invalid.stdout).not.toContain("private-policy-marker");
  });

  it("every read verb supports --json and the JSON parses to its documented envelope", () => {
    const box = sandbox();
    const json = args => { const r = box.run("standalone", [...args, "--json"]); return JSON.parse(r.stdout); };
    expect(json(["status"])).toHaveProperty("sources");
    expect(json(["resolve", "--requirement", "deep", "--runtime", "codex"])).toMatchObject({ status: "unresolved" });
    expect(json(["recommend", "--requirement", "deep", "--runtime", "codex"])).toBeTypeOf("object");
    expect(json(["snapshot", "--check"])).toMatchObject({ envelope: "ModelsSnapshotCheck", version: 1 });
    expect(json(["migrate"])).toBeTypeOf("object");
  });

  it("the recorded --json field names of the shipped release still parse with the same meanings (OPS-3)", () => {
    const recorded = JSON.parse(readFileSync(new URL("./fixtures/model-intelligence/cli-envelopes-baseline.json", import.meta.url), "utf8"));
    const box = sandbox();
    for (const [name, { args, fields }] of Object.entries(recorded).filter(([key]) => !key.startsWith("$"))) {
      const current = JSON.parse(box.run("standalone", [...args, "--json"]).stdout);
      for (const field of fields) expect(current, `${name}.${field}`).toHaveProperty(field);
    }
  });

  it("no verb adds trust or writes configuration, and output never carries a credential (SEC-6, OPS-4)", () => {
    const box = sandbox();
    const before = snapshotTree(box.env.XDG_CONFIG_HOME);
    for (const args of [["status"], ["status", "--json"], ["resolve", "--requirement", "deep", "--runtime", "codex", "--json"], ["recommend", "--requirement", "deep", "--runtime", "codex"], ["migrate"], ["snapshot", "--check"], ["refresh", "--runtime", "gemini"]]) {
      const result = box.run("standalone", args);
      expect(`${result.stdout}${result.stderr}`, args.join(" ")).not.toMatch(/fixture-(credential|token)/);
    }
    expect(snapshotTree(box.env.XDG_CONFIG_HOME)).toEqual(before);
  });

  it("with no network and no cache, dotbabel subcommands outside models exit as before (REL-5)", () => {
    const box = sandbox();
    const root = spawnSync(process.execPath, [umbrella, "--help"], { cwd: box.repo, env: box.env, encoding: "utf8" });
    expect(root.status).toBe(0);
    const version = spawnSync(process.execPath, [umbrella, "--version"], { cwd: box.repo, env: box.env, encoding: "utf8" });
    expect(version.status).toBe(0);
  });
});
