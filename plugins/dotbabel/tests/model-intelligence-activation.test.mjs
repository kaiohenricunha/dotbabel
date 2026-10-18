import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync, writeFileSync, symlinkSync, readdirSync, mkdirSync, chmodSync, statSync } from "node:fs";
import fs from "node:fs";
import { acquireLock } from "../src/model-intelligence/catalog/lock.mjs";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import Ajv from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { makeTempDir } from "./fixtures/temp-dir.mjs";
import { projectActivation, readProjectActivation, setProjectActivation } from "../src/model-intelligence/activation/index.mjs";

const bin = fileURLToPath(new URL("../bin/dotbabel-models.mjs", import.meta.url));
const schema = JSON.parse(readFileSync(new URL("../../../schemas/dotbabel.config.schema.json", import.meta.url), "utf8"));
const validate = addFormats(new Ajv({ strict: false })).compile(schema);
function command(repo, ...args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [bin, ...args, "--repo-root", repo, "--json"], { cwd: repo });
    let stdout = "", stderr = "";
    child.stdout.on("data", x => { stdout += x; });
    child.stderr.on("data", x => { stderr += x; });
    child.on("error", reject);
    child.on("close", code => resolve({ code, stdout, stderr }));
  });
}

afterEach(() => vi.restoreAllMocks());
describe("project Model Intelligence activation", () => {
  it("rejects a non-object project document without accepting inherited activation", () => {
    for (const document of [null, [], "text", 3, false]) expect(() => projectActivation(document)).toThrow(/invalid_project_config/);
  });
  it("reports malformed content through both the read and write interfaces", () => {
    const repo = makeTempDir("mi-activation-");
    writeFileSync(join(repo, ".dotbabel.json"), '{"private":');
    expect(() => readProjectActivation(repo)).toThrow(/invalid_project_config/);
    expect(readFileSync(join(repo, ".dotbabel.json"), "utf8")).toBe('{"private":');
  });
  it("never repairs invalid activation implicitly while enabling it", () => {
    const repo = makeTempDir("mi-activation-");
    const file = join(repo, ".dotbabel.json");
    const text = JSON.stringify({ model_intelligence: { enabled: "true" } });
    writeFileSync(file, text);
    expect(() => setProjectActivation(repo, { enabled: true })).toThrow(/invalid_project_config/);
    expect(readFileSync(file, "utf8")).toBe(text);
  });
  it("refuses a mixed valid and unknown mutation without creating configuration", () => {
    const repo = makeTempDir("mi-activation-");
    expect(() => setProjectActivation(repo, { enabled: true, other: false })).toThrow(/invalid_activation_change/);
    expect(readdirSync(repo)).toEqual([]);
  });
  it("keeps a live configuration lock and refuses a contending writer within its deadline", () => {
    const repo = makeTempDir("mi-activation-");
    const file = join(repo, ".dotbabel.json");
    writeFileSync(file, "{}");
    const lock = acquireLock(`${file}.model-intelligence.lock`, { resource: file });
    expect(lock.acquired).toBe(true);
    const before = readFileSync(`${file}.model-intelligence.lock`, "utf8");
    let now = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => { now += 2500; return now; });
    try {
      expect(() => setProjectActivation(repo, { enabled: true })).toThrow(/project_config_locked/);
      expect(readFileSync(file, "utf8")).toBe("{}");
      expect(readFileSync(`${file}.model-intelligence.lock`, "utf8")).toBe(before);
    } finally { lock.release(); }
  });
  it.each(["fchmodSync", "writeFileSync", "fsyncSync", "closeSync", "renameSync"])("a %s failure preserves the old document and removes temporary files", operation => {
    const repo = makeTempDir("mi-activation-");
    const file = join(repo, ".dotbabel.json");
    writeFileSync(file, "{}");
    const original = fs[operation].bind(fs);
    let calls = 0;
    vi.spyOn(fs, operation).mockImplementation((...args) => {
      calls++;
      if (calls === (operation === "closeSync" ? 2 : 1)) throw Object.assign(new Error("injected_io_failure"), { code: "EIO" });
      return original(...args);
    });
    expect(() => setProjectActivation(repo, { enabled: true })).toThrow(/injected_io_failure/);
    expect(readFileSync(file, "utf8")).toBe("{}");
    expect(readdirSync(repo)).toEqual([".dotbabel.json"]);
  });
  it("reports an unavailable read without treating it as malformed JSON", () => {
    const repo = makeTempDir("mi-activation-");
    writeFileSync(join(repo, ".dotbabel.json"), "{}");
    vi.spyOn(fs, "readFileSync").mockImplementationOnce(() => { throw Object.assign(new Error("private failure text"), { code: "EIO" }); });
    expect(() => readProjectActivation(repo)).toThrow(/project_config_unavailable/);
  });
  it("accepts the maximum readable document size and maximum rendered document size", () => {
    const repo = makeTempDir("mi-activation-");
    const file = join(repo, ".dotbabel.json");
    const base = JSON.stringify({ padding: "" });
    writeFileSync(file, JSON.stringify({ padding: "x".repeat(1024 * 1024 - base.length) }));
    expect(readProjectActivation(repo).enabled).toBe(false);
    const document = { padding: "", model_intelligence: { enabled: true } };
    document.padding = "x".repeat(1024 * 1024 - JSON.stringify(document, null, 2).length - 1);
    writeFileSync(file, JSON.stringify(document));
    expect(setProjectActivation(repo, { enabled: true }).enabled).toBe(true);
    expect(statSync(file).size).toBe(1024 * 1024);
  });
  it("defaults both capabilities to disabled and never uses a global activation", () => {
    expect(projectActivation({})).toMatchObject({ enabled: false, routingRequested: false, routingEnabled: false });
    expect(readProjectActivation(makeTempDir("mi-activation-"))).toMatchObject({ enabled: false, routingEnabled: false });
  });
  it("requires independent explicit boolean opt-ins for intelligence and routing", () => {
    expect(projectActivation({ model_intelligence: { enabled: true } })).toMatchObject({ enabled: true, routingEnabled: false });
    expect(projectActivation({ model_intelligence: { adaptive_routing: { enabled: true } } })).toMatchObject({ enabled: false, routingRequested: true, routingEnabled: false });
    expect(projectActivation({ model_intelligence: { enabled: true, adaptive_routing: { enabled: true } } })).toMatchObject({ enabled: true, routingEnabled: true });
  });
  it.each(["true", 1, null, {}, []])("rejects an invalid activation value %j without interpreting truthiness", enabled => {
    expect(() => projectActivation({ model_intelligence: { enabled } })).toThrow(/invalid_project_config/);
    expect(validate({ model_intelligence: { enabled } })).toBe(false);
  });
  it("validates the routing namespace and existing policy fields strictly", () => {
    expect(validate({ model_intelligence: { enabled: true, adaptive_routing: { enabled: true }, floor: { mode: "floor", requirement: "deep" } } })).toBe(true);
    for (const adaptive_routing of [true, null, { enable: true }, { enabled: "true" }]) {
      expect(() => projectActivation({ model_intelligence: { adaptive_routing } })).toThrow(/invalid_project_config/);
    }
    expect(() => projectActivation({ model_intelligence: { floor: { mode: "floor", requirement: "genius" } } })).toThrow(/invalid_project_config/);
  });
  it("activation and deactivation preserve unrelated configuration and user files", () => {
    const repo = makeTempDir("mi-activation-");
    const config = { commands_dir: "my-commands", custom: { important: true }, model_intelligence: { pin: { mode: "pin", runtime: "codex", config: { model: "user-owned" } } } };
    writeFileSync(join(repo, ".dotbabel.json"), JSON.stringify(config));
    writeFileSync(join(repo, "agent.md"), "user-owned content");
    setProjectActivation(repo, { enabled: true });
    expect(readProjectActivation(repo)).toMatchObject({ enabled: true, routingEnabled: false });
    setProjectActivation(repo, { routingEnabled: true });
    expect(readProjectActivation(repo).routingEnabled).toBe(true);
    setProjectActivation(repo, { enabled: false });
    expect(readProjectActivation(repo)).toMatchObject({ enabled: false, routingRequested: true, routingEnabled: false });
    setProjectActivation(repo, { routingEnabled: false });
    const saved = JSON.parse(readFileSync(join(repo, ".dotbabel.json"), "utf8"));
    expect(saved.custom).toEqual(config.custom);
    expect(saved.commands_dir).toBe("my-commands");
    expect(saved.model_intelligence.pin).toEqual(config.model_intelligence.pin);
    expect(readFileSync(join(repo, "agent.md"), "utf8")).toBe("user-owned content");
    expect(readdirSync(repo).sort()).toEqual([".dotbabel.json", "agent.md"]);
  });
  it("rejects malformed and symbolic-link configuration without writes or content disclosure", () => {
    const repo = makeTempDir("mi-activation-");
    const outside = join(makeTempDir("mi-activation-"), "config.json");
    writeFileSync(outside, '{"private":"secret-marker"}');
    symlinkSync(outside, join(repo, ".dotbabel.json"));
    expect(() => setProjectActivation(repo, { enabled: true })).toThrow(/project_config_unavailable/);
    expect(readFileSync(outside, "utf8")).toBe('{"private":"secret-marker"}');
    const badRepo = makeTempDir("mi-activation-");
    writeFileSync(join(badRepo, ".dotbabel.json"), '{"secret-marker":');
    expect(() => setProjectActivation(badRepo, { enabled: true })).toThrow(/invalid_project_config/);
    expect(() => readProjectActivation(badRepo)).not.toThrow(/secret-marker/);
  });
  it("refuses oversized and non-file configuration and preserves file permissions", () => {
    const repo = makeTempDir("mi-activation-");
    const file = join(repo, ".dotbabel.json");
    writeFileSync(file, JSON.stringify({ padding: "x".repeat(1024 * 1024) }));
    expect(() => setProjectActivation(repo, { enabled: true })).toThrow(/project_config_unavailable/);
    writeFileSync(file, "{}");
    chmodSync(file, 0o600);
    setProjectActivation(repo, { enabled: true });
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const directoryRepo = makeTempDir("mi-activation-");
    mkdirSync(join(directoryRepo, ".dotbabel.json"));
    expect(() => readProjectActivation(directoryRepo)).toThrow(/project_config_unavailable/);
  });
  it("preserves group-write permissions excluded by the process umask", () => {
    const repo = makeTempDir("mi-activation-");
    const file = join(repo, ".dotbabel.json");
    writeFileSync(file, "{}");
    chmodSync(file, 0o660);
    const moduleUrl = new URL("../src/model-intelligence/activation/index.mjs", import.meta.url).href;
    const child = spawnSync(process.execPath, ["--input-type=module", "-e",
      `import { setProjectActivation } from ${JSON.stringify(moduleUrl)}; process.umask(0o022); setProjectActivation(${JSON.stringify(repo)}, { enabled: true });`], { encoding: "utf8" });
    expect(child.status, child.stderr).toBe(0);
    expect(statSync(file).mode & 0o777).toBe(0o660);
    expect(readProjectActivation(repo).enabled).toBe(true);
  });
  it("refuses an expanded configuration above the read limit before replacing it", () => {
    const repo = makeTempDir("mi-activation-");
    const file = join(repo, ".dotbabel.json");
    const text = JSON.stringify({ list: Array(130000).fill("x") });
    writeFileSync(file, text);
    expect(() => setProjectActivation(repo, { enabled: true })).toThrow(/project_config_unavailable/);
    expect(readFileSync(file, "utf8")).toBe(text);
    expect(readdirSync(repo)).toEqual([".dotbabel.json"]);
  });
  it("rejects empty or unknown activation mutations", () => {
    const repo = makeTempDir("mi-activation-");
    for (const change of [{}, { enabled: "true" }, { nonsense: true }, null]) {
      expect(() => setProjectActivation(repo, change)).toThrow(/invalid_activation_change/);
    }
    expect(readdirSync(repo)).toEqual([]);
  });
  it("runs enabled and disabled projects concurrently without policy or activation leakage", async () => {
    const a = makeTempDir("mi-activation-a-"), b = makeTempDir("mi-activation-b-");
    writeFileSync(join(a, ".dotbabel.json"), JSON.stringify({ model_intelligence: { floor: { mode: "floor", requirement: "frontier" } } }));
    const results = await Promise.all([command(a, "enable"), command(a, "enable", "--routing"), command(b, "status")]);
    expect(results.map(r => r.code), JSON.stringify(results)).toEqual([0, 0, 0]);
    const [sa, sb] = await Promise.all([command(a, "status"), command(b, "status")]);
    expect(sa.code, sa.stderr).toBe(0);
    expect(sb.code, sb.stderr).toBe(0);
    expect(JSON.parse(sa.stdout).activation).toMatchObject({ enabled: true, routingEnabled: true });
    expect(JSON.parse(sb.stdout).activation).toMatchObject({ enabled: false, routingEnabled: false });
    expect(JSON.parse(readFileSync(join(a, ".dotbabel.json"), "utf8")).model_intelligence.floor.requirement).toBe("frontier");
    expect(readdirSync(b)).toEqual([]);
    const off = await command(a, "disable", "--routing");
    expect(off.code).toBe(0);
    expect(JSON.parse(off.stdout).activation).toMatchObject({ enabled: true, routingEnabled: false });
  });
  it("reports configuration errors as coded JSON without leaking malformed content", async () => {
    const repo = makeTempDir("mi-activation-");
    writeFileSync(join(repo, ".dotbabel.json"), '{"secret-marker":');
    const result = await command(repo, "enable");
    expect(result.code).toBe(1);
    expect(result.stdout, JSON.stringify(result)).not.toBe("");
    expect(JSON.parse(result.stdout).diagnostics[0].code).toBe("invalid_project_config");
    expect(result.stdout + result.stderr).not.toContain("secret-marker");
  });
});
