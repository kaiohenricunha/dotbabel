import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
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
    expect(rows.length).toBe(8);
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
    expect(MODELS_VERBS.map(verb => verb.name)).toEqual(["refresh", "status", "resolve", "recommend", "migrate", "snapshot", "enable", "disable", "session", "route"]);
    for (const verb of MODELS_VERBS) { for (const form of verb.forms) expect(form.purpose.length, verb.name).toBeGreaterThan(10); expect(Array.isArray(verb.flags)).toBe(true); }
  });

  it("renderVerbHelp() prints each form with its purpose below, then the verb's accepted flags", () => {
    const expected = MODELS_VERBS.flatMap(verb => [...verb.forms.flatMap(form => [`  ${form.usage}`, `      ${form.purpose}`]), `      flags: ${verb.flags.map(flag => `--${flag}`).join(" ")}`]);
    expect(renderVerbHelp().split("\n")).toEqual(expected);
  });

  it("--help names every flag each verb accepts, so no working flag is hidden", () => {
    const help = sandbox().run("standalone", ["--help"]).stdout;
    for (const verb of MODELS_VERBS) for (const flag of verb.flags) expect(help, `${verb.name} --${flag}`).toContain(`--${flag}`);
    for (const flag of ["snapshot-file", "evidence-file", "artifact-kind", "decisions", "batch", "observation-file"]) expect(help).toContain(`--${flag}`);
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

  it("no verb adds a repository to the trust allowlist, and an operation that would run a project-controlled command without trust returns a structured trust-required result and runs nothing", () => {
    // SEC-6. No `models` operation takes a command from repository configuration: runtime binaries are
    // fixed names found on the caller's PATH and start in a scratch directory (sources/runtime/process.mjs),
    // so the trust-required branch has no trigger today. This guards the invariant that makes it so: a
    // runtime binary planted in an untrusted repository never runs, even with relative PATH entries that
    // would resolve inside the repository, and no verb trusts the repository.
    const box = sandbox({ model_intelligence: { enabled: true, adaptive_routing: { enabled: true } } });
    const planted = [];
    for (const directory of ["", "bin", "node_modules/.bin"]) {
      mkdirSync(join(box.repo, directory), { recursive: true });
      for (const name of ["claude", "codex", "opencode", "gemini", "agy", "copilot"]) {
        const file = join(box.repo, directory, name);
        writeFileSync(file, `#!/bin/sh\necho ran > "${join(box.repo, `ran-${name}`)}"\n`); chmodSync(file, 0o755); planted.push(file);
      }
    }
    const env = { ...box.env, PATH: `.:bin:node_modules/.bin:${process.env.PATH}` };
    for (const args of [["status", "--json"], ["resolve", "--requirement", "deep", "--runtime", "claude", "--json"], ["recommend", "--requirement", "deep", "--runtime", "codex"], ["migrate"], ["snapshot", "--check"], ["refresh", "--runtime", "claude"], ["refresh", "--runtime", "codex"], ["refresh", "--runtime", "opencode"]]) {
      const result = spawnSync(process.execPath, [standalone, ...args], { cwd: box.repo, env, encoding: "utf8", timeout: 120_000 });
      expect(result.error, args.join(" ")).toBeUndefined();
    }
    expect(planted).toHaveLength(18);
    expect(readdirSync(box.repo).filter(name => name.startsWith("ran-")), "a planted runtime binary ran").toEqual([]);
    expect(existsSync(join(box.env.XDG_CONFIG_HOME, "dotbabel", "check-on-stop-trusted")), "the trust allowlist").toBe(false);
  }, 600_000);

  it("with no network and no cache, every dotbabel subcommand outside models exits as it did before", () => {
    // REL-5. Every umbrella subcommand other than `models` still loads and answers --help with exit 0
    // when the network is unreachable and no Model Intelligence cache exists, and none creates that cache.
    const box = sandbox();
    const source = readFileSync(umbrella, "utf8");
    const subcommands = JSON.parse(source.slice(source.indexOf("[", source.indexOf("const SUBCOMMANDS")), source.indexOf("];", source.indexOf("const SUBCOMMANDS")) + 1).replace(/,\s*\]$/, "]")).filter(name => name !== "models");
    expect(subcommands.length).toBeGreaterThan(20);
    for (const args of [["--help"], ["--version"], ...subcommands.map(name => [name, "--help"])]) {
      const result = spawnSync(process.execPath, [umbrella, ...args], { cwd: box.repo, env: box.env, encoding: "utf8", timeout: 60_000 });
      expect(result.status, args.join(" ")).toBe(0);
    }
    expect(existsSync(join(box.env.XDG_CACHE_HOME, "dotbabel", "model-intelligence")), "the Model Intelligence cache").toBe(false);
  }, 300_000);
});
