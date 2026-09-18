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
import { WORKLOAD_CLASSES, RUNTIME_IDS } from "../src/model-intelligence/domain/index.mjs";
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
    // An ALLOWLIST, because the denylist above cannot fail for a model name nobody
    // has coined yet: `satisfied_by: { model: "some-future-model" }` would pass every
    // forbidden-token check. Constraining the keys to declared capability facts and
    // the values to the shapes those facts take rejects an unexpected token whatever
    // it is spelled, which is what ARCH-15 actually asks for.
    const CAPABILITY_KEYS = ["reasoning", "tool_call", "reasoning_effort_tiers"];
    for (const [name, rule] of Object.entries(SHIPPED_POLICY.classes)) {
      expect(rule.satisfied_by, name).toBeTypeOf("object");
      expect(Object.keys(rule.satisfied_by).length, name).toBeGreaterThan(0);
      for (const [key, value] of Object.entries(rule.satisfied_by)) {
        expect(CAPABILITY_KEYS, `${name}.${key}`).toContain(key);
        if (typeof value === "string") expect(["optional", "required"], `${name}.${key}`).toContain(value);
        else expect(["boolean", "number"], `${name}.${key}`).toContain(typeof value);
      }
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
    for (const runtime of [undefined, "", 7, "claud", "../../etc/passwd"]) {
      // The runtime registry is authoritative (§5 `pin`): an unregistered id is
      // rejected here, not three modules later in an adapter. `assertLayer` is the
      // only ingest-time gate, because nothing applies the JSON schema at load time.
      expect(() => mergePolicy({ project: { pin: { mode: "pin", runtime, config: { a: 1 } } } })).toThrow(/project policy: pin\.runtime must be one of/);
    }
    for (const config of [undefined, {}, [], "x", null]) {
      expect(() => mergePolicy({ project: { pin: { mode: "pin", runtime: "claude", config } } })).toThrow(/project policy: pin\.config must be a non-empty object/);
    }
    // A null or non-object declaration names the layer instead of failing with a bare
    // "cannot read properties of null".
    expect(() => mergePolicy({ project: { floor: null } })).toThrow(/project policy: floor must be an object, got null/);
    expect(() => mergePolicy({ user: { pin: [] } })).toThrow(/user policy: pin must be an object, got array/);
    for (const layer of [[], "x", 7, true]) {
      expect(() => mergePolicy({ project: layer })).toThrow(/project policy: expected an object/);
    }
  });

  it("refuses a policy key that would set the prototype of the merged preferences", () => {
    // `JSON.parse` yields `__proto__` as an OWN enumerable key, so a plain
    // `target[key] = value` invokes the Object.prototype setter (CWE-1321). The
    // polluted value then reads back through the merged object while staying absent
    // from Object.keys and JSON.stringify, and carries no provenance — which defeats
    // the explanation guarantee this module exists to provide.
    const hostile = JSON.parse(String.raw`{"preferences":{"__proto__":{"future_pref":"attacker"}}}`);
    expect(() => mergePolicy({ shipped: SHIPPED_POLICY, project: hostile })).toThrow(/project policy: preferences must not contain the key "__proto__"/);
    for (const key of ["constructor", "prototype"]) {
      expect(() => mergePolicy({ user: { preferences: { [key]: 1 } } })).toThrow(new RegExp(`must not contain the key "${key}"`));
    }
    // Defence in depth: the container has no prototype to reach even if a future
    // caller writes a key by name.
    expect(Object.getPrototypeOf(mergePolicy({ shipped: SHIPPED_POLICY }).preferences)).toBeNull();
  });

  it("rejects a key that is not a policy layer, and points an invocation pin at the resolver", () => {
    // A misspelled layer would otherwise discard a safety floor in silence, which is
    // the inert-policy failure the strict `dotbabel.compute` parser exists to prevent.
    expect(() => mergePolicy({ artifacts: { floor: floor("frontier") } })).toThrow(/unknown policy layer "artifacts"; expected one of shipped, user, project, artifact/);
    // §5 orders pins `... < artifact pin < explicit invocation pin` and ARCH-66 makes
    // an invocation pin more specific again. Dropping it silently would let the
    // artifact pin win, the precedence inversion ARCH-66 forbids.
    expect(() => mergePolicy({ invocation: { pin: pin("claude", { a: 1 }) } })).toThrow(/"invocation" is not a policy layer; an invocation pin is supplied to the resolver/);
  });

  it("breaks an equal floor toward the more specific layer so the explanation names the real source", () => {
    const merged = mergePolicy({ shipped: { floor: floor("frontier") }, artifact: { floor: { ...floor("frontier"), rationale: "adversarial analysis" } } });
    expect(merged.floor.requirement).toBe("frontier");
    // The effective class is identical either way. Attributing it to shipped would
    // credit shipped policy for a floor the artifact author declared, and discard the
    // rationale that artifact carried.
    expect(merged.provenance.floor).toBe("artifact");
    expect(merged.floor.rationale).toBe("adversarial analysis");
  });

  it("carries the class table through the merge so the resolver needs no back door", () => {
    // `classes` is the substance of Dotbabel's judgement. If the merge dropped it,
    // `resolver/` would have to import SHIPPED_POLICY directly and reach around this
    // layering, losing provenance for the most important policy fact.
    const merged = mergePolicy({ shipped: SHIPPED_POLICY });
    expect(Object.keys(merged.classes)).toEqual([...WORKLOAD_CLASSES]);
    expect(merged.provenance.classes).toBe("shipped");
    expect(() => mergePolicy({ project: { classes: "nope" } })).toThrow(/project policy: classes must be an object/);
  });

  it("records a shadowed pin without copying its opaque config values", () => {
    // `pin.config` may legitimately hold an endpoint or a credential, and `shadowed`
    // exists to be rendered as a diagnostic (OPS-4). The shadowed pin is usually the
    // USER's, surfaced because a repository shadowed it, so the value at risk belongs
    // to the person the repository does not control.
    const merged = mergePolicy({
      user: { pin: pin("claude", { apiKey: "s3cret-value", model: "x" }) },
      artifact: { pin: pin("codex", { model: "y" }) },
    });
    expect(merged.shadowed).toHaveLength(1);
    expect(JSON.stringify(merged.shadowed)).not.toMatch(/s3cret-value/);
    expect(merged.shadowed[0].declaration).toEqual({ runtime: "claude", configKeys: ["apiKey", "model"] });
    expect(merged.pin.runtime).toBe("codex");
  });

  it("reports a pin beside an artifact floor and leaves ARCH-67 to the resolver", () => {
    // ARCH-67 says a user or project pin cannot override an artifact floor. Judging
    // whether a runtime-native config satisfies a semantic floor needs catalog
    // evidence, which P-4 excludes, so the merge reports both declarations with their
    // layers and `resolver/` (P-10, P-11) owns the conflict. This test pins that
    // contract so the absence stays deliberate rather than becoming an oversight.
    const merged = mergePolicy({
      artifact: { floor: floor("frontier") },
      project: { pin: pin("claude", { model: "x" }) },
    });
    expect(merged.floor.requirement).toBe("frontier");
    expect(merged.provenance.floor).toBe("artifact");
    expect(merged.pin.runtime).toBe("claude");
    expect(merged.provenance.pin).toBe("project");
    // The merge does not resolve it, and does not pretend to.
    expect(merged).not.toHaveProperty("conflict");
  });

  it("deep-freezes the shipped policy and the merged result", () => {
    // Object.freeze is shallow and `createRequire` caches the document, so a shallow
    // freeze would leave a process-wide singleton mutable. A single assignment would
    // weaken every later merge while provenance still reported `shipped`.
    expect(Object.isFrozen(SHIPPED_POLICY)).toBe(true);
    expect(Object.isFrozen(SHIPPED_POLICY.classes)).toBe(true);
    expect(Object.isFrozen(SHIPPED_POLICY.preferences)).toBe(true);
    expect(Object.isFrozen(SHIPPED_POLICY.classes.frontier.satisfied_by)).toBe(true);
    expect(Object.isFrozen(mergePolicy({ shipped: SHIPPED_POLICY }))).toBe(true);
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

  it("merges over supplied layers only: the result does not depend on the environment", () => {
    // Asserted as BEHAVIOR, not as source text. The previous version of this test
    // sliced the source from `export function mergePolicy` to the end of the file,
    // which contains none of the helpers the merge actually calls — `assertLayer`,
    // `strongerFloor` and `readJsonOrNull` are all defined above that point — so it
    // could not fail for the call graph it claimed to guard. A rename made it worse:
    // `indexOf` would return -1 and `slice(-1)` would scan a single character.
    const layers = { shipped: SHIPPED_POLICY, project: { floor: floor("deep") } };
    const first = mergePolicy(layers);
    const saved = { env: process.env, cwd: process.cwd };
    try {
      process.env = { ...saved.env, XDG_CONFIG_HOME: "/nonexistent", HOME: "/nonexistent" };
      process.cwd = () => "/nonexistent";
      expect(mergePolicy(layers)).toEqual(first);
    } finally {
      process.env = saved.env;
      process.cwd = saved.cwd;
    }
    // The import boundary is a whole-module property, so it is still checked over the
    // whole source (ARCH-57 rule 8).
    const source = readFileSync(POLICY_SOURCE, "utf8");
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

    const ns = schema.properties.model_intelligence.properties;
    // Pin the enums to their single authority rather than to two sample points. The
    // repository already learned this: three hand-written CLI lists in this same file
    // drifted because only one was pinned. Adding a sixth workload class or a seventh
    // runtime must fail here, not silently leave the schema rejecting what the code
    // accepts.
    expect(ns.floor.properties.requirement.enum).toEqual([...WORKLOAD_CLASSES]);
    expect(ns.pin.properties.runtime.enum).toEqual([...RUNTIME_IDS]);

    // The pin subschema had no accept or reject case at all.
    expect(validate({ model_intelligence: { pin: { mode: "pin", runtime: RUNTIME_IDS[0], config: { model: "x" } } } })).toBe(true);
    expect(validate({ model_intelligence: { pin: { mode: "pin", runtime: "claud", config: { model: "x" } } } })).toBe(false);
    expect(validate({ model_intelligence: { pin: { mode: "pin", runtime: RUNTIME_IDS[0] } } })).toBe(false);
    expect(validate({ model_intelligence: { pin: { mode: "pin", runtime: RUNTIME_IDS[0], config: {} } } })).toBe(false);

    // A misspelled preference must fail here instead of becoming inert policy.
    expect(validate({ model_intelligence: { preferences: { prefer_locally_verified: true } } })).toBe(true);
    expect(validate({ model_intelligence: { preferences: { prefer_locally_verifed: true } } })).toBe(false);

    // A floor or pin may record why it exists (§5: rationale is permitted in every mode).
    expect(validate({ model_intelligence: { floor: { mode: "floor", requirement: "deep", rationale: "cross-cutting design work" } } })).toBe(true);
  });
});
