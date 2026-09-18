import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  COMPUTE_SCHEMA_ID,
  MI_COMPUTE_INVALID,
  MODE_RULES,
  buildComputeSchema,
  parseComputeDeclaration,
} from "../src/model-intelligence/requirement/index.mjs";
import {
  BINDINGS,
  RESOLUTION_MODES,
  RUNTIME_IDS,
  WORKLOAD_CLASSES,
} from "../src/model-intelligence/domain/index.mjs";
import { SCHEMAS_DIR, SCHEMA_FILES, parseFrontmatter } from "../src/build-index.mjs";

const REQUIREMENT_SOURCE = fileURLToPath(new URL("../src/model-intelligence/requirement/index.mjs", import.meta.url));
const SCHEMA_PATH = join(SCHEMAS_DIR, "dotbabel.compute.schema.json");

/** Frontmatter with one `dotbabel.compute` object. */
const fm = (compute) => ({ id: "probe", type: "skill", name: "probe", dotbabel: { compute } });
const parse = (compute) => parseComputeDeclaration(fm(compute), { sourcePath: "skills/probe/SKILL.md" });
const pointers = (result) => result.errors.map((error) => error.pointer);
const reasons = (result) => result.errors.map((error) => error.reason);

/** A skill object the skill schema accepts, carrying the compute block under test. */
const skillWith = (compute) => ({
  id: "ok-skill",
  type: "skill",
  name: "ok",
  description: "ok",
  version: "1.0.0",
  domain: ["infra"],
  platform: ["none"],
  task: ["review"],
  maturity: "production",
  owner: "@test",
  created: "2025-01-01",
  updated: "2026-04-17",
  dotbabel: { compute },
});

/**
 * One case table, asserted against both enforcement paths. §5's rules live in
 * `MODE_RULES`; the JSON Schema and the parser each read that table, so every
 * row must get the same verdict from ajv and from `parseComputeDeclaration`.
 * A row that only one layer rejects is exactly the drift these cases exist to
 * catch.
 */
const CASES = Object.freeze([
  { name: "dynamic with a requirement", compute: { requirement: "deep", binding: "self", mode: "dynamic" }, valid: true },
  { name: "dynamic with a rationale", compute: { requirement: "deep", binding: "self", mode: "dynamic", rationale: "why" }, valid: true },
  { name: "floor with a requirement", compute: { requirement: "frontier", binding: "self", mode: "floor" }, valid: true },
  { name: "pin with a requirement and a pin", compute: { requirement: "exceptional", binding: "self", mode: "pin", pin: { runtime: "codex", config: { model: "gpt-5.5", reasoningEffort: "xhigh" } } }, valid: true },
  { name: "inherit with neither", compute: { binding: "consumer", mode: "inherit" }, valid: true },
  { name: "session binding", compute: { requirement: "deep", binding: "session", mode: "dynamic" }, valid: true },

  { name: "an unknown key", compute: { requirement: "deep", binding: "self", mode: "dynamic", extra: 1 }, valid: false },
  { name: "a misspelled requirement key", compute: { requrement: "deep", binding: "self", mode: "dynamic" }, valid: false },
  { name: "dynamic without a requirement", compute: { binding: "self", mode: "dynamic" }, valid: false },
  { name: "floor without a requirement", compute: { binding: "self", mode: "floor" }, valid: false },
  { name: "pin without a requirement", compute: { binding: "self", mode: "pin", pin: { runtime: "claude", config: { model: "opus" } } }, valid: false },
  { name: "pin without a pin", compute: { requirement: "deep", binding: "self", mode: "pin" }, valid: false },
  { name: "dynamic with a stray pin", compute: { requirement: "deep", binding: "self", mode: "dynamic", pin: { runtime: "claude", config: { model: "opus" } } }, valid: false },
  { name: "floor with a stray pin", compute: { requirement: "deep", binding: "self", mode: "floor", pin: { runtime: "claude", config: { model: "opus" } } }, valid: false },
  { name: "inherit with a requirement", compute: { requirement: "deep", binding: "consumer", mode: "inherit" }, valid: false },
  { name: "inherit with a pin", compute: { binding: "consumer", mode: "inherit", pin: { runtime: "claude", config: { model: "opus" } } }, valid: false },
  { name: "no binding", compute: { requirement: "deep", mode: "dynamic" }, valid: false },
  { name: "no mode", compute: { requirement: "deep", binding: "self" }, valid: false },
  { name: "an artifact kind as the binding", compute: { requirement: "deep", binding: "agent", mode: "dynamic" }, valid: false },
  { name: "an unknown mode", compute: { requirement: "deep", binding: "self", mode: "auto" }, valid: false },
  { name: "an unknown workload class", compute: { requirement: "genius", binding: "self", mode: "dynamic" }, valid: false },
  { name: "a runtime outside the registry", compute: { requirement: "deep", binding: "self", mode: "pin", pin: { runtime: "anthropic", config: { model: "opus" } } }, valid: false },
  { name: "an empty pin config", compute: { requirement: "deep", binding: "self", mode: "pin", pin: { runtime: "claude", config: {} } }, valid: false },
  { name: "an unknown pin key", compute: { requirement: "deep", binding: "self", mode: "pin", pin: { runtime: "claude", config: { model: "opus" }, effort: "max" } }, valid: false },
  { name: "a non-string rationale", compute: { requirement: "deep", binding: "self", mode: "dynamic", rationale: 7 }, valid: false },
]);

/** Compile the shipped schemas exactly as the index builder does. */
async function compileSkillValidator() {
  const { default: Ajv } = await import("ajv/dist/2020.js");
  const { default: addFormats } = await import("ajv-formats");
  const ajv = new Ajv({ strict: false, allErrors: true });
  addFormats(ajv);
  for (const name of SCHEMA_FILES) {
    ajv.addSchema(JSON.parse(readFileSync(join(SCHEMAS_DIR, `${name}.schema.json`), "utf8")));
  }
  return ajv.getSchema("https://dotbabel.dev/schemas/skill.schema.json");
}

describe("dotbabel.compute: one case table, both enforcement paths", () => {
  it("the parser agrees with the case table on every row", () => {
    for (const { name, compute, valid } of CASES) {
      const result = parse(compute);
      expect(result.errors.length === 0, `parser: ${name}`).toBe(valid);
      expect(result.requirement !== null, `parser requirement: ${name}`).toBe(valid);
      for (const error of result.errors) {
        expect(error.code, name).toBe(MI_COMPUTE_INVALID);
        expect(error.pointer, name).toMatch(/^\/dotbabel/);
      }
    }
  });

  it("the shipped JSON Schema agrees with the case table on every row", async () => {
    const validate = await compileSkillValidator();
    for (const { name, compute, valid } of CASES) {
      expect(validate(skillWith(compute)), `schema: ${name}`).toBe(valid);
    }
  });
});

describe("dotbabel.compute parsing", () => {
  it("parses a dynamic declaration into a NormalizedComputeRequirement with artifact provenance", () => {
    const result = parse({ requirement: "deep", binding: "self", mode: "dynamic", rationale: "why" });
    expect(result.errors).toEqual([]);
    expect(result.requirement).toEqual({
      requirement: "deep",
      binding: "self",
      mode: "dynamic",
      rationale: "why",
      // `sourceKind: "artifact"`, not `"runtime"`: no adapter observed this, and a
      // consumer that reads `runtime` to mean "observed from a harness" must not
      // match a declaration.
      provenance: { sourceId: "skills/probe/SKILL.md", sourceKind: "artifact" },
    });
    expect(Object.isFrozen(result.requirement)).toBe(true);
  });

  it("freezes a normalised pin and its opaque config", () => {
    const result = parse({ requirement: "exceptional", binding: "self", mode: "pin", pin: { runtime: "codex", config: { model: "gpt-5.5", reasoningEffort: "xhigh" } } });
    expect(result.requirement.pin).toEqual({ runtime: "codex", config: { model: "gpt-5.5", reasoningEffort: "xhigh" } });
    expect(Object.isFrozen(result.requirement.pin)).toBe(true);
    expect(Object.isFrozen(result.requirement.pin.config)).toBe(true);
  });

  it("treats an artifact with no dotbabel key as having no canonical declaration", () => {
    for (const frontmatter of [{ id: "a" }, { id: "a", dotbabel: {} }]) {
      const result = parseComputeDeclaration(frontmatter, { sourcePath: "a.md" });
      expect(result.requirement).toBeNull();
      expect(result.errors).toEqual([]);
      expect(result.declared).toBe(false);
    }
    expect(parse({ binding: "self", mode: "inherit" }).declared).toBe(true);
  });

  it("rejects a malformed declaration shape rather than reading it as policy", () => {
    expect(pointers(parseComputeDeclaration({ dotbabel: "deep" }, { sourcePath: "a.md" }))).toEqual(["/dotbabel"]);
    expect(pointers(parseComputeDeclaration({ dotbabel: { compute: "deep" } }, { sourcePath: "a.md" }))).toEqual(["/dotbabel/compute"]);
    expect(pointers(parseComputeDeclaration({ dotbabel: { compute: [] } }, { sourcePath: "a.md" }))).toEqual(["/dotbabel/compute"]);
    expect(pointers(parse({ requirement: "deep", binding: "self", mode: "pin", pin: "claude" }))).toEqual(["/dotbabel/compute/pin"]);
  });

  it("requires options.sourcePath, because provenance cannot be invented", () => {
    for (const options of [undefined, {}, { sourcePath: "" }, { sourcePath: "   " }]) {
      expect(() => parseComputeDeclaration(fm({ binding: "self", mode: "inherit" }), options)).toThrow(/sourcePath/);
    }
  });

  it("reads a nested dotbabel mapping through js-yaml where the line parser would flatten it", () => {
    const markdown = ["---", "name: probe", "dotbabel:", "  compute:", "    requirement: frontier", "    binding: self", "    mode: floor", "---", "", "body", ""].join("\n");
    const { frontmatter } = parseFrontmatter(markdown);
    const result = parseComputeDeclaration(frontmatter, { sourcePath: "a.md" });
    expect(result.errors).toEqual([]);
    expect(result.requirement.mode).toBe("floor");
    expect(result.requirement.requirement).toBe("frontier");

    // The hard gate's own parser flattens the nested block into one string, which is
    // why §5 moves canonical parsing to the shared YAML path.
    const gate = readFileSync(fileURLToPath(new URL("../src/validate-skills-inventory.mjs", import.meta.url)), "utf8");
    expect(gate).toMatch(/const kvMatch = line\.match/);
  });

  it("parses over supplied data only: no filesystem, process, or clock use", () => {
    const source = readFileSync(REQUIREMENT_SOURCE, "utf8");
    const imports = [...source.matchAll(/^\s*import\s[^;]*?from\s+["']([^"']+)["']/gm)].map((match) => match[1]);
    expect(imports.filter((specifier) => /^(node:)?(fs|fs\/promises|child_process|http|https|os)$/.test(specifier))).toEqual([]);
    expect(source).not.toMatch(/\bDate\.now\(|\bprocess\.env\b/);
  });
});

describe("dotbabel.compute diagnostics", () => {
  it("reports each invalid field once, with its own pointer and reason", () => {
    const result = parse({ requirement: "genius", binding: "agent", mode: "auto", rationale: 7 });
    expect(pointers(result)).toEqual([
      "/dotbabel/compute/binding",
      "/dotbabel/compute/mode",
      "/dotbabel/compute/requirement",
      "/dotbabel/compute/rationale",
    ]);
    expect(reasons(result)).toEqual(["enum", "enum", "enum", "type"]);
    // An unusable mode skips the conditional rules rather than adding noise about them.
    expect(pointers(result)).not.toContain("/dotbabel/compute/pin");
  });

  it("does not add a stray-pin error when the mode itself is unusable", () => {
    const result = parse({ requirement: "deep", binding: "self", mode: "auto", pin: { runtime: "claude", config: { model: "opus" } } });
    expect(pointers(result)).toEqual(["/dotbabel/compute/mode"]);
  });

  it("distinguishes an absent field from a present-but-invalid one", () => {
    const absent = parse({ requirement: "deep", mode: "dynamic" });
    expect(absent.errors[0]).toMatchObject({ reason: "required", message: "binding is required" });
    expect(absent.errors[0].got).toBeUndefined();

    const invalidValue = parse({ requirement: "deep", binding: "agent", mode: "dynamic" });
    expect(invalidValue.errors[0]).toMatchObject({
      reason: "enum",
      message: `binding must be one of ${BINDINGS.join(", ")}`,
      got: "agent",
    });
  });

  it("names the mode's own definition when a field is forbidden for it", () => {
    const result = parse({ requirement: "deep", binding: "consumer", mode: "inherit" });
    expect(result.errors[0].reason).toBe("forbidden");
    expect(result.errors[0].message).toContain(MODE_RULES.inherit.why);
  });

  it("reports a structural fault by type and never echoes the offending value", () => {
    // `pin.config` is opaque runtime-native configuration and may legitimately hold a
    // credential or an endpoint, so a diagnostic reports its type, not its contents (OPS-4).
    // A stand-in for the kind of value pin.config may legitimately hold. Deliberately
    // not shaped like any real credential prefix, so scanners do not flag the fixture.
    const secret = "CONFIDENTIAL-FIXTURE-VALUE-DO-NOT-ECHO";
    const result = parse({ requirement: "deep", binding: "self", mode: "pin", pin: { runtime: "claude", config: secret } });
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatchObject({ reason: "shape", pointer: "/dotbabel/compute/pin/config", gotType: "string" });
    expect(JSON.stringify(result.errors)).not.toContain(secret);

    const nested = parseComputeDeclaration({ dotbabel: { compute: { secretish: secret } } }, { sourcePath: "a.md" });
    expect(JSON.stringify(nested.errors)).not.toContain(secret);
  });

  it("bounds an echoed enum value so one artifact cannot flood a log", () => {
    const result = parse({ requirement: "x".repeat(500), binding: "self", mode: "dynamic" });
    expect(result.errors[0].got.length).toBeLessThanOrEqual(80);
  });
});

describe("dotbabel.compute schema is generated, not hand-maintained", () => {
  it("the committed schema matches buildComputeSchema() byte for byte after formatting", async () => {
    const { format, resolveConfig } = await import("prettier");
    const rendered = await format(JSON.stringify(buildComputeSchema()), {
      ...((await resolveConfig(SCHEMA_PATH)) ?? {}),
      parser: "json",
    });
    // The generator writes this file; `node scripts/build-compute-schema.mjs --check`
    // is the same assertion in CI. A stale schema means the domain vocabulary or
    // MODE_RULES moved and the file did not.
    expect(readFileSync(SCHEMA_PATH, "utf8")).toBe(rendered);
  });

  it("every enum in the schema comes from the domain vocabulary, never a literal copy", () => {
    const compute = JSON.parse(readFileSync(SCHEMA_PATH, "utf8")).properties.compute;
    expect(compute.properties.requirement.enum).toEqual([...WORKLOAD_CLASSES]);
    expect(compute.properties.binding.enum).toEqual([...BINDINGS]);
    expect(compute.properties.mode.enum).toEqual([...RESOLUTION_MODES]);
    // ARCH-58: the runtime registry is authoritative; this must not become a
    // second, independently maintained runtime enum.
    expect(compute.properties.pin.properties.runtime.enum).toEqual([...RUNTIME_IDS]);
  });

  it("declares one conditional clause per resolution mode, and no mode is missing", () => {
    const compute = JSON.parse(readFileSync(SCHEMA_PATH, "utf8")).properties.compute;
    expect(Object.keys(MODE_RULES)).toEqual([...RESOLUTION_MODES]);
    const clauseModes = compute.allOf.map((clause) => clause.if.properties.mode.const);
    expect(clauseModes).toEqual([...RESOLUTION_MODES]);
  });

  it("is strict on compute and on pin, and keeps the dotbabel namespace open", () => {
    const schema = JSON.parse(readFileSync(SCHEMA_PATH, "utf8"));
    expect(schema.$id).toBe(COMPUTE_SCHEMA_ID);
    // A misspelled key must be an error, not inert policy (§5, "Strictness").
    expect(schema.properties.compute.additionalProperties).toBe(false);
    expect(schema.properties.compute.properties.pin.additionalProperties).toBe(false);
    expect(schema.properties.compute.properties.pin.required).toEqual(["runtime", "config"]);
    expect(schema.properties.compute.properties.pin.properties.config.minProperties).toBe(1);
    expect(schema.properties.compute.required).toEqual(["binding", "mode"]);
    // The namespace itself stays open so a later unit can add a sibling of `compute`.
    expect(schema.additionalProperties).toBe(true);
  });

  it("the agent, skill, and command schemas reference the namespace schema", () => {
    for (const type of ["agent", "skill", "command"]) {
      const artifact = JSON.parse(readFileSync(join(SCHEMAS_DIR, `${type}.schema.json`), "utf8"));
      expect(artifact.properties.dotbabel, type).toEqual({ $ref: "dotbabel.compute.schema.json" });
    }
  });
});
