import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseComputeDeclaration,
  COMPUTE_SCHEMA_ID,
} from "../src/model-intelligence/requirement/index.mjs";
import { SCHEMAS_DIR } from "../src/build-index.mjs";

const REQUIREMENT_SOURCE = fileURLToPath(
  new URL("../src/model-intelligence/requirement/index.mjs", import.meta.url),
);

/** Frontmatter with one `dotbabel.compute` object. */
const fm = (compute) => ({ id: "probe", type: "skill", name: "probe", dotbabel: { compute } });
const codes = (result) => result.errors.map((error) => error.code);
const pointers = (result) => result.errors.map((error) => error.pointer);

describe("dotbabel.compute parsing", () => {
  it("parses a dynamic declaration into a NormalizedComputeRequirement with provenance", () => {
    const result = parseComputeDeclaration(
      fm({ requirement: "deep", binding: "self", mode: "dynamic", rationale: "why" }),
      {
        sourcePath: "skills/probe/SKILL.md",
      },
    );
    expect(result.errors).toEqual([]);
    expect(result.requirement).toEqual({
      requirement: "deep",
      binding: "self",
      mode: "dynamic",
      rationale: "why",
      provenance: {
        sourceId: "skills/probe/SKILL.md",
        sourceKind: "runtime",
        adapterVersion: "canonical",
      },
    });
    expect(Object.isFrozen(result.requirement)).toBe(true);
  });

  it("rejects an unknown key inside dotbabel.compute (additionalProperties false)", () => {
    const result = parseComputeDeclaration(
      fm({ requrement: "deep", binding: "self", mode: "dynamic" }),
      { sourcePath: "a.md" },
    );
    expect(result.requirement).toBeNull();
    expect(codes(result)).toContain("MI_COMPUTE_INVALID");
    expect(result.errors.some((error) => /requrement/.test(error.message))).toBe(true);
  });

  it("requires requirement for dynamic, floor, and pin and forbids it for inherit", () => {
    for (const mode of ["dynamic", "floor"]) {
      const missing = parseComputeDeclaration(fm({ binding: "self", mode }), {
        sourcePath: "a.md",
      });
      expect(missing.requirement, mode).toBeNull();
      expect(pointers(missing).join(" "), mode).toMatch(/requirement/);
    }
    const pinMissing = parseComputeDeclaration(
      fm({ binding: "self", mode: "pin", pin: { runtime: "claude", config: { model: "opus" } } }),
      { sourcePath: "a.md" },
    );
    expect(pinMissing.requirement).toBeNull();
    expect(pointers(pinMissing).join(" ")).toMatch(/requirement/);

    const inheritOk = parseComputeDeclaration(fm({ binding: "consumer", mode: "inherit" }), {
      sourcePath: "a.md",
    });
    expect(inheritOk.errors).toEqual([]);
    expect(inheritOk.requirement.requirement).toBeUndefined();

    const inheritBad = parseComputeDeclaration(
      fm({ requirement: "deep", binding: "consumer", mode: "inherit" }),
      { sourcePath: "a.md" },
    );
    expect(inheritBad.requirement).toBeNull();
    expect(pointers(inheritBad).join(" ")).toMatch(/requirement/);
  });

  it("requires pin only for mode pin and validates pin.runtime against RUNTIMES ids", () => {
    const ok = parseComputeDeclaration(
      fm({
        requirement: "exceptional",
        binding: "self",
        mode: "pin",
        pin: { runtime: "codex", config: { model: "gpt-5.5", reasoningEffort: "xhigh" } },
      }),
      { sourcePath: "a.md" },
    );
    expect(ok.errors).toEqual([]);
    expect(ok.requirement.pin).toEqual({
      runtime: "codex",
      config: { model: "gpt-5.5", reasoningEffort: "xhigh" },
    });
    expect(Object.isFrozen(ok.requirement.pin.config)).toBe(true);

    const noPin = parseComputeDeclaration(
      fm({ requirement: "deep", binding: "self", mode: "pin" }),
      { sourcePath: "a.md" },
    );
    expect(noPin.requirement).toBeNull();
    expect(pointers(noPin).join(" ")).toMatch(/pin/);

    const strayPin = parseComputeDeclaration(
      fm({
        requirement: "deep",
        binding: "self",
        mode: "dynamic",
        pin: { runtime: "claude", config: { model: "opus" } },
      }),
      { sourcePath: "a.md" },
    );
    expect(strayPin.requirement).toBeNull();
    expect(pointers(strayPin).join(" ")).toMatch(/pin/);

    const badRuntime = parseComputeDeclaration(
      fm({
        requirement: "deep",
        binding: "self",
        mode: "pin",
        pin: { runtime: "anthropic", config: { model: "opus" } },
      }),
      { sourcePath: "a.md" },
    );
    expect(badRuntime.requirement).toBeNull();
    expect(pointers(badRuntime).join(" ")).toMatch(/pin\/runtime/);
    expect(badRuntime.errors.some((error) => /opencode/.test(error.expected ?? ""))).toBe(true);
  });

  it("rejects an empty pin.config object", () => {
    const result = parseComputeDeclaration(
      fm({
        requirement: "deep",
        binding: "self",
        mode: "pin",
        pin: { runtime: "claude", config: {} },
      }),
      { sourcePath: "a.md" },
    );
    expect(result.requirement).toBeNull();
    expect(pointers(result).join(" ")).toMatch(/pin\/config/);
  });

  it("treats an artifact with no dotbabel key as having no canonical declaration", () => {
    for (const frontmatter of [{ id: "a" }, { id: "a", dotbabel: {} }]) {
      const result = parseComputeDeclaration(frontmatter, { sourcePath: "a.md" });
      expect(result.requirement).toBeNull();
      expect(result.errors).toEqual([]);
      expect(result.declared).toBe(false);
    }
    const declared = parseComputeDeclaration(fm({ binding: "self", mode: "inherit" }), {
      sourcePath: "a.md",
    });
    expect(declared.declared).toBe(true);
  });

  it("reads a nested dotbabel mapping through js-yaml where the line parser would flatten it", async () => {
    const markdown = [
      "---",
      "name: probe",
      "description: probe",
      "dotbabel:",
      "  compute:",
      "    requirement: frontier",
      "    binding: self",
      "    mode: floor",
      "---",
      "",
      "body",
      "",
    ].join("\n");
    const { parseFrontmatter } = await import("../src/build-index.mjs");
    const { frontmatter } = parseFrontmatter(markdown);
    const result = parseComputeDeclaration(frontmatter, { sourcePath: "a.md" });
    expect(result.errors).toEqual([]);
    expect(result.requirement.mode).toBe("floor");
    expect(result.requirement.requirement).toBe("frontier");

    // The hard gate's own parser flattens the nested block into one string, which is
    // why §5 moves canonical parsing to the shared YAML path.
    const gate = readFileSync(
      fileURLToPath(new URL("../src/validate-skills-inventory.mjs", import.meta.url)),
      "utf8",
    );
    expect(gate).toMatch(/const kvMatch = line\.match/);
  });

  it("ships a strict schema that the artifact schemas reference and ajv compiles", async () => {
    const { default: Ajv } = await import("ajv/dist/2020.js");
    const { default: addFormats } = await import("ajv-formats");
    const ajv = new Ajv({ strict: false, allErrors: true });
    addFormats(ajv);
    for (const name of [
      "facets",
      "common",
      "dotbabel.compute",
      "agent",
      "skill",
      "command",
      "hook",
      "template",
      "index-entry",
    ]) {
      ajv.addSchema(JSON.parse(readFileSync(join(SCHEMAS_DIR, `${name}.schema.json`), "utf8")));
    }
    const compute = JSON.parse(
      readFileSync(join(SCHEMAS_DIR, "dotbabel.compute.schema.json"), "utf8"),
    );
    expect(compute.$id).toBe(COMPUTE_SCHEMA_ID);
    expect(compute.properties.compute.additionalProperties).toBe(false);
    for (const type of ["agent", "skill", "command"]) {
      const artifact = JSON.parse(readFileSync(join(SCHEMAS_DIR, `${type}.schema.json`), "utf8"));
      expect(JSON.stringify(artifact.properties.dotbabel), type).toContain(
        "dotbabel.compute.schema.json",
      );
    }
    const validate = ajv.getSchema("https://dotbabel.dev/schemas/skill.schema.json");
    // The skill schema requires the taxonomy fields, so the fixture carries them.
    const skill = (compute) => ({
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
    expect(validate(skill({ requirement: "deep", binding: "self", mode: "dynamic" }))).toBe(true);
    expect(
      validate(skill({ requirement: "deep", binding: "self", mode: "dynamic", extra: 1 })),
    ).toBe(false);
    expect(validate(skill({ binding: "consumer", mode: "inherit" }))).toBe(true);
    expect(validate(skill({ requirement: "deep", binding: "consumer", mode: "inherit" }))).toBe(
      false,
    );
    expect(validate(skill({ requirement: "deep", binding: "self", mode: "pin" }))).toBe(false);
    expect(
      validate(
        skill({
          requirement: "deep",
          binding: "self",
          mode: "pin",
          pin: { runtime: "claude", config: { model: "opus" } },
        }),
      ),
    ).toBe(true);
    expect(
      validate(
        skill({
          requirement: "deep",
          binding: "self",
          mode: "pin",
          pin: { runtime: "anthropic", config: { model: "opus" } },
        }),
      ),
    ).toBe(false);
  });

  it("rejects a malformed declaration shape rather than reading it as policy", () => {
    // The namespace, the compute block, and pin must each be a mapping. A scalar or a
    // list is a structural error, never a silently ignored declaration.
    const namespaceScalar = parseComputeDeclaration({ dotbabel: "deep" }, { sourcePath: "a.md" });
    expect(namespaceScalar.declared).toBe(true);
    expect(pointers(namespaceScalar)).toEqual(["/dotbabel"]);

    const computeScalar = parseComputeDeclaration({ dotbabel: { compute: "deep" } }, { sourcePath: "a.md" });
    expect(pointers(computeScalar)).toEqual(["/dotbabel/compute"]);

    const computeList = parseComputeDeclaration({ dotbabel: { compute: [] } }, { sourcePath: "a.md" });
    expect(pointers(computeList)).toEqual(["/dotbabel/compute"]);

    const pinScalar = parseComputeDeclaration(fm({ requirement: "deep", binding: "self", mode: "pin", pin: "claude" }), { sourcePath: "a.md" });
    expect(pointers(pinScalar)).toEqual(["/dotbabel/compute/pin"]);

    const pinExtraKey = parseComputeDeclaration(fm({ requirement: "deep", binding: "self", mode: "pin", pin: { runtime: "claude", config: { model: "opus" }, effort: "max" } }), { sourcePath: "a.md" });
    expect(pointers(pinExtraKey)).toEqual(["/dotbabel/compute/pin/effort"]);
  });

  it("reports every invalid field of a declaration, each with its own pointer", () => {
    const result = parseComputeDeclaration(fm({ requirement: "genius", binding: "agent", mode: "auto", rationale: 7 }), { sourcePath: "a.md" });
    expect(result.requirement).toBeNull();
    expect(codes(result)).toEqual(Array(4).fill("MI_COMPUTE_INVALID"));
    expect(pointers(result)).toEqual([
      "/dotbabel/compute/binding",
      "/dotbabel/compute/mode",
      "/dotbabel/compute/requirement",
      "/dotbabel/compute/rationale",
    ]);
    const requirementError = result.errors.find((error) => error.pointer.endsWith("/requirement"));
    expect(requirementError.expected).toBe("mechanical, routine, deep, frontier, exceptional");
    expect(requirementError.got).toBe("genius");
    // An unusable mode skips the conditional rules rather than adding noise about them.
    expect(pointers(result)).not.toContain("/dotbabel/compute/pin");
  });

  it("requires options.sourcePath, because provenance cannot be invented", () => {
    for (const options of [undefined, {}, { sourcePath: "" }, { sourcePath: "   " }]) {
      expect(() => parseComputeDeclaration(fm({ binding: "self", mode: "inherit" }), options)).toThrow(/sourcePath/);
    }
  });

  it("parses over supplied data only: no filesystem, process, or clock use", () => {
    const source = readFileSync(REQUIREMENT_SOURCE, "utf8");
    const imports = [...source.matchAll(/^\s*import\s[^;]*?from\s+["']([^"']+)["']/gm)].map(
      (match) => match[1],
    );
    expect(
      imports.filter((specifier) =>
        /^(node:)?(fs|fs\/promises|child_process|http|https|os)$/.test(specifier),
      ),
    ).toEqual([]);
    expect(source).not.toMatch(/\bDate\.now\(|\bprocess\.env\b/);
  });
});
