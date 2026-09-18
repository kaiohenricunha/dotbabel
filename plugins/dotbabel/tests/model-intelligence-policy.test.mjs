import { describe, it, expect } from "vitest";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  POLICY_LAYERS,
  SHIPPED_POLICY,
  loadPolicyLayers,
  mergePolicy,
} from "../src/model-intelligence/policy/index.mjs";
import { WORKLOAD_CLASSES } from "../src/model-intelligence/domain/index.mjs";
import { makeTempDir } from "./fixtures/temp-dir.mjs";

const POLICY_SOURCE = fileURLToPath(new URL("../src/model-intelligence/policy/index.mjs", import.meta.url));
const SHIPPED_PATH = fileURLToPath(new URL("../src/model-intelligence/policy/shipped.json", import.meta.url));

/** A floor declaration as a layer contributes one. */
const floor = (requirement) => ({ mode: "floor", requirement });
/** A pin declaration, whose config stays opaque. */
const pin = (runtime, config) => ({ mode: "pin", runtime, config });

describe("policy layer merge", () => {
  it("merges shipped, user, project, and artifact layers and records the layer of each effective value", () => {
    const merged = mergePolicy({
      shipped: { floor: floor("mechanical"), preferences: { representation: "stable-alias" } },
      user: { floor: floor("routine") },
      project: { preferences: { representation: "native-id" } },
      artifact: { floor: floor("deep") },
    });
    expect(merged.floor.requirement).toBe("deep");
    expect(merged.preferences.representation).toBe("native-id");
    // Every effective value names the layer it came from, so an explanation can cite
    // it rather than asserting a result with no source (§5, Policy).
    expect(merged.provenance.floor).toBe("artifact");
    expect(merged.provenance["preferences.representation"]).toBe("project");
    expect(POLICY_LAYERS).toEqual(["shipped", "user", "project", "artifact"]);
  });

  it("composes floors by taking the strongest applicable minimum", () => {
    // A floor is monotonic: a broader layer may strengthen it, and no layer may
    // weaken a more specific one. Order of declaration must not matter.
    const strongestFromProject = mergePolicy({
      shipped: { floor: floor("routine") },
      project: { floor: floor("frontier") },
      artifact: { floor: floor("deep") },
    });
    expect(strongestFromProject.floor.requirement).toBe("frontier");
    expect(strongestFromProject.provenance.floor).toBe("project");

    const weakerLayerCannotLower = mergePolicy({
      shipped: { floor: floor("exceptional") },
      artifact: { floor: floor("mechanical") },
    });
    expect(weakerLayerCannotLower.floor.requirement).toBe("exceptional");

    for (const [a, b] of [["deep", "frontier"], ["frontier", "deep"]]) {
      expect(mergePolicy({ shipped: { floor: floor(a) }, user: { floor: floor(b) } }).floor.requirement).toBe("frontier");
    }
  });

  it("keeps a shadowed lower-scope pin in the effective policy with a shadowed marker", () => {
    const merged = mergePolicy({
      user: { pin: pin("claude", { model: "opus" }) },
      artifact: { pin: pin("codex", { model: "gpt-5.5" }) },
    });
    // ARCH-66: the artifact pin is effective. The shadowed one is recorded rather
    // than forgotten, so the resolver can explain why it did not apply.
    expect(merged.pin.runtime).toBe("codex");
    expect(merged.provenance.pin).toBe("artifact");
    expect(merged.shadowed).toHaveLength(1);
    expect(merged.shadowed[0]).toMatchObject({ layer: "user", declaration: { runtime: "claude" } });
    expect(merged.shadowed[0].reason).toMatch(/artifact/);
  });

  it("records every shadowed pin when three layers declare one", () => {
    // Shipped may not declare a pin at all, so the three layers here are the three
    // that may: user, project, and the artifact's own declaration.
    const merged = mergePolicy({
      user: { pin: pin("claude", { model: "a" }) },
      project: { pin: pin("codex", { model: "b" }) },
      artifact: { pin: pin("gemini", { model: "c" }) },
    });
    expect(merged.pin.runtime).toBe("gemini");
    expect(merged.shadowed.map((entry) => entry.layer)).toEqual(["user", "project"]);
  });

  it("rejects a provider model name inside shipped policy", () => {
    // ARCH-15: policy is the stable decision framework; today's market catalog is
    // not part of it. A concrete model belongs in the release snapshot or a
    // runtime-native pin, never in the shipped table.
    const raw = readFileSync(SHIPPED_PATH, "utf8");
    for (const name of ["opus", "sonnet", "haiku", "gpt-", "gemini-", "claude-", "o3", "grok"]) {
      expect(raw.toLowerCase(), name).not.toContain(name);
    }
    expect(SHIPPED_POLICY.pin).toBeUndefined();
    expect(() => mergePolicy({ shipped: { pin: pin("claude", { model: "opus" }) } })).toThrow(/shipped policy/);
  });

  it("declares a capability rule for every workload class, and no class without one", () => {
    expect(Object.keys(SHIPPED_POLICY.classes)).toEqual([...WORKLOAD_CLASSES]);
    for (const [name, rule] of Object.entries(SHIPPED_POLICY.classes)) {
      expect(rule.satisfied_by, name).toBeTypeOf("object");
      expect(Object.keys(rule.satisfied_by).length, name).toBeGreaterThan(0);
    }
  });

  it("reads user policy from configDir() and project policy from .dotbabel.json without mutating either", () => {
    const home = makeTempDir("mi-policy-test-");
    const repo = makeTempDir("mi-policy-test-");
    const userDir = join(home, "dotbabel");
    mkdirSync(userDir, { recursive: true });
    const userPath = join(userDir, "model-intelligence.json");
    const projectPath = join(repo, ".dotbabel.json");
    const userText = `${JSON.stringify({ floor: { mode: "floor", requirement: "routine" } }, null, 2)}\n`;
    const projectText = `${JSON.stringify({ model_intelligence: { floor: { mode: "floor", requirement: "deep" } } }, null, 2)}\n`;
    writeFileSync(userPath, userText);
    writeFileSync(projectPath, projectText);

    const layers = loadPolicyLayers({ repoRoot: repo, env: { XDG_CONFIG_HOME: home } });
    expect(layers.shipped).toEqual(SHIPPED_POLICY);
    expect(layers.user.floor.requirement).toBe("routine");
    expect(layers.project.floor.requirement).toBe("deep");
    expect(layers.sources.user).toBe(userPath);
    expect(layers.sources.project).toBe(projectPath);

    // Reading is read-only: neither file changes, byte for byte.
    expect(readFileSync(userPath, "utf8")).toBe(userText);
    expect(readFileSync(projectPath, "utf8")).toBe(projectText);
  });

  it("treats a missing user or project file as an empty layer rather than an error", () => {
    const layers = loadPolicyLayers({ repoRoot: makeTempDir("mi-policy-test-"), env: { XDG_CONFIG_HOME: makeTempDir("mi-policy-test-") } });
    expect(layers.user).toEqual({});
    expect(layers.project).toEqual({});
    expect(layers.shipped.classes).toBeTypeOf("object");
  });

  it("reports an unreadable layer rather than silently continuing", () => {
    const repo = makeTempDir("mi-policy-test-");
    writeFileSync(join(repo, ".dotbabel.json"), "{ not json");
    expect(() => loadPolicyLayers({ repoRoot: repo, env: { XDG_CONFIG_HOME: makeTempDir("mi-policy-test-") } })).toThrow(/\.dotbabel\.json/);
  });

  it("rejects a malformed declaration in any layer, naming the layer and the field", () => {
    // A policy file is author-written and may be wrong. Applying half of a bad
    // declaration would silently change what the resolver may choose.
    expect(() => mergePolicy({ user: { floor: { mode: "pin", requirement: "deep" } } })).toThrow(/user policy: floor\.mode/);
    expect(() => mergePolicy({ project: { floor: { mode: "floor", requirement: "genius" } } })).toThrow(/project policy: floor\.requirement must be one of mechanical, routine, deep, frontier, exceptional/);
    expect(() => mergePolicy({ artifact: { floor: { mode: "floor" } } })).toThrow(/artifact policy: floor\.requirement/);
    expect(() => mergePolicy({ user: { pin: { mode: "floor", runtime: "claude", config: { a: 1 } } } })).toThrow(/user policy: pin\.mode/);
    for (const runtime of [undefined, "", 7]) {
      expect(() => mergePolicy({ project: { pin: { mode: "pin", runtime, config: { a: 1 } } } })).toThrow(/project policy: pin\.runtime is required/);
    }
  });

  it("skips an absent layer and a comment key rather than treating either as a value", () => {
    const merged = mergePolicy({
      shipped: SHIPPED_POLICY,
      user: undefined,
      project: null,
      artifact: { preferences: { $comment: "not a preference", representation: "native-id" } },
    });
    expect(merged.preferences.$comment).toBeUndefined();
    expect(merged.preferences.representation).toBe("native-id");
    // The shipped preferences still came through, so skipping did not drop the layer.
    expect(merged.preferences.prefer_locally_verified).toBe(true);
    expect(merged.provenance["preferences.prefer_locally_verified"]).toBe("shipped");
  });

  it("attributes a floor to the layer whose value is in force, not the last layer that mentioned one", () => {
    const merged = mergePolicy({
      shipped: { floor: floor("frontier") },
      user: { floor: floor("routine") },
      project: { floor: floor("mechanical") },
    });
    expect(merged.floor.requirement).toBe("frontier");
    // Two later layers declared a weaker floor, and neither steals the attribution
    // from the layer whose value actually holds.
    expect(merged.provenance.floor).toBe("shipped");
    expect(merged.shadowed).toEqual([]);
  });

  it("returns an empty effective policy for no layers at all", () => {
    const merged = mergePolicy({});
    expect(merged.floor).toBeUndefined();
    expect(merged.pin).toBeUndefined();
    expect(merged.preferences).toEqual({});
    expect(merged.shadowed).toEqual([]);
    expect(merged.provenance).toEqual({});
  });

  it("reports an unreadable user policy file rather than ignoring it", () => {
    const home = makeTempDir("mi-policy-test-");
    const userDir = join(home, "dotbabel");
    mkdirSync(userDir, { recursive: true });
    writeFileSync(join(userDir, "model-intelligence.json"), "{ nope");
    expect(() => loadPolicyLayers({ repoRoot: makeTempDir("mi-policy-test-"), env: { XDG_CONFIG_HOME: home } })).toThrow(/model-intelligence\.json/);
  });

  it("reports a user policy path that cannot be read for a reason other than absence", () => {
    // A directory where a file is expected fails with EISDIR, not ENOENT, and must
    // not be swallowed by the missing-file path.
    const home = makeTempDir("mi-policy-test-");
    mkdirSync(join(home, "dotbabel", "model-intelligence.json"), { recursive: true });
    expect(() => loadPolicyLayers({ repoRoot: makeTempDir("mi-policy-test-"), env: { XDG_CONFIG_HOME: home } })).toThrow(/cannot read/);
  });

  it("merges over supplied layers only: no filesystem, process, or clock use in mergePolicy", () => {
    const source = readFileSync(POLICY_SOURCE, "utf8");
    // `loadPolicyLayers` owns the only I/O in this module (ARCH-56); the merge is pure.
    const mergeBody = source.slice(source.indexOf("export function mergePolicy"));
    expect(mergeBody).not.toMatch(/readFileSync|writeFileSync|existsSync|process\.env|Date\.now\(/);
    const imports = [...source.matchAll(/^\s*import\s[^;]*?from\s+["']([^"']+)["']/gm)].map((m) => m[1]);
    expect(imports.filter((s) => /quality|sources|catalog|resolver/.test(s))).toEqual([]);
  });

  it("ships the model_intelligence namespace in the project config schema", async () => {
    const { default: Ajv } = await import("ajv/dist/2020.js");
    const schema = JSON.parse(readFileSync(join(fileURLToPath(new URL("../../../schemas/", import.meta.url)), "dotbabel.config.schema.json"), "utf8"));
    expect(schema.properties.model_intelligence).toBeTypeOf("object");
    const ajv = new Ajv({ strict: false, allErrors: true });
    const validate = ajv.compile(schema);
    expect(validate({ model_intelligence: { floor: { mode: "floor", requirement: "deep" } } })).toBe(true);
    expect(validate({ model_intelligence: { floor: { mode: "floor", requirement: "genius" } } })).toBe(false);
    // A project may not pin a provider model into shipped-policy shape by mistake:
    // an unknown key inside the namespace is rejected.
    expect(validate({ model_intelligence: { nonsense: true } })).toBe(false);
  });
});
