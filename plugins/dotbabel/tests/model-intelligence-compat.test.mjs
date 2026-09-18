import { describe, it, expect } from "vitest";
import {
  MI_LEGACY_AMBIGUOUS,
  MI_DUAL_DECLARATION_CONFLICT,
  LEGACY_DISPOSITIONS,
  analyzeMigration,
  detectDualDeclarationConflict,
  interpretLegacy,
} from "../src/model-intelligence/compat/index.mjs";
import { parseComputeDeclaration } from "../src/model-intelligence/requirement/index.mjs";

/** Frontmatter for one artifact of a given kind. */
const artifact = (kind, fields) => ({ id: "probe", type: kind, name: "probe", ...fields });
const legacy = (kind, fields) => interpretLegacy(artifact(kind, fields), { sourcePath: `x/${kind}.md`, artifactKind: kind });

describe("legacy interpretation", () => {
  it("maps a legacy agent model alias to a legacy-derived requirement with provenance kind legacy", () => {
    const result = legacy("agent", { model: "opus" });
    expect(result.disposition).toBe("mapped");
    expect(result.requirement).toMatchObject({
      binding: "self",
      mode: "floor",
      provenance: { sourceId: "x/agent.md", sourceKind: "artifact", adapterVersion: "legacy" },
    });
    // The alias is an ordering, not a model name that survives into the requirement.
    expect(JSON.stringify(result.requirement)).not.toContain("opus");
    expect(result.legacy).toEqual({ model: "opus" });
  });

  it("interprets legacy model and effort on a skill as a consumer-binding requirement and never as a native binding", () => {
    // ARCH-37: a skill requirement influences the enclosing compute context; it never
    // binds compute itself, and DOC-2 measured Claude ignoring both keys on a skill.
    const result = legacy("skill", { model: "opus", effort: "max" });
    expect(result.requirement.binding).toBe("consumer");
    expect(result.requirement.mode).not.toBe("pin");
    expect(result.requirement.pin).toBeUndefined();
    expect(result.notes.some((note) => /inert|not a native binding/i.test(note))).toBe(true);
  });

  it("binds a command requirement to the session, because a command model changes the whole session", () => {
    expect(legacy("command", { model: "sonnet" }).requirement.binding).toBe("session");
  });

  it("leaves an ambiguous legacy declaration explicit with an ambiguity code", () => {
    // `inherit` is not a workload class: it declares the absence of a requirement,
    // which the compat layer records rather than inventing a class for.
    const inherited = legacy("agent", { model: "inherit" });
    expect(inherited.disposition).toBe("inherit");
    expect(inherited.requirement.mode).toBe("inherit");
    expect(inherited.requirement.requirement).toBeUndefined();

    for (const fields of [{ model: "gpt-5" }, { model: "opus-ish" }, { effort: "max" }]) {
      const result = legacy("agent", fields);
      expect(result.disposition, JSON.stringify(fields)).toBe("ambiguous");
      expect(result.requirement, JSON.stringify(fields)).toBeNull();
      expect(result.codes, JSON.stringify(fields)).toContain(MI_LEGACY_AMBIGUOUS);
    }
  });

  it("reports no declaration at all when the artifact carries neither key", () => {
    const result = legacy("agent", {});
    expect(result.disposition).toBe("absent");
    expect(result.requirement).toBeNull();
    expect(result.codes).toEqual([]);
  });

  it("never invents a requirement from an effort value alone", () => {
    // Effort has no observable effect on a skill (DOC-2) and no workload class maps
    // to it on its own, so a lone effort is ambiguous rather than "max means frontier".
    expect(legacy("skill", { effort: "max" }).disposition).toBe("ambiguous");
  });
});

describe("legacy interpretation edges", () => {
  it("requires both sourcePath and artifactKind, because neither can be inferred", () => {
    const fm = artifact("agent", { model: "opus" });
    for (const options of [undefined, {}, { artifactKind: "agent" }, { sourcePath: "  ", artifactKind: "agent" }]) {
      expect(() => interpretLegacy(fm, options)).toThrow(/sourcePath/);
    }
    for (const options of [{ sourcePath: "x.md" }, { sourcePath: "x.md", artifactKind: "   " }]) {
      expect(() => interpretLegacy(fm, options)).toThrow(/artifactKind/);
    }
  });

  it("falls back to a consumer binding for an artifact kind with no known compute context", () => {
    // A hook or a template declares no compute context of its own, so anything
    // outside the three known kinds is read as informing its consumer, never as
    // owning a binding it cannot have.
    const result = interpretLegacy(artifact("hook", { model: "opus" }), { sourcePath: "hooks/h.md", artifactKind: "hook" });
    expect(result.requirement.binding).toBe("consumer");
  });

  it("binds a workflow requirement to the session, matching the ai-review coordinator", () => {
    const result = interpretLegacy(artifact("workflow", { model: "opus" }), { sourcePath: "w.yml", artifactKind: "workflow" });
    expect(result.requirement.binding).toBe("session");
  });

  it("records an effort that accompanies model inherit without deriving a requirement from it", () => {
    const result = legacy("agent", { model: "inherit", effort: "max" });
    expect(result.disposition).toBe("inherit");
    expect(result.requirement.requirement).toBeUndefined();
    expect(result.notes.join(" ")).toContain("max");
  });

  it("treats a known alias with an out-of-enum effort as ambiguous rather than reading it in halves", () => {
    const result = legacy("agent", { model: "opus", effort: "ultra" });
    expect(result.disposition).toBe("ambiguous");
    expect(result.requirement).toBeNull();
    expect(result.codes).toContain(MI_LEGACY_AMBIGUOUS);
    expect(result.notes.join(" ")).toContain("ultra");
  });

  it("preserves a legal effort as authoring intent alongside the mapped class", () => {
    const result = legacy("agent", { model: "opus", effort: "max" });
    expect(result.disposition).toBe("mapped");
    expect(result.legacy).toEqual({ model: "opus", effort: "max" });
    expect(result.notes.join(" ")).toMatch(/authoring intent|no workload class follows/);
    // The effort is not smuggled into the requirement as a pin or a stronger class.
    expect(result.requirement.requirement).toBe("frontier");
    expect(result.requirement.pin).toBeUndefined();
  });

  it("maps each known alias to its own class, so the ordering is not collapsed", () => {
    expect(legacy("agent", { model: "haiku" }).requirement.requirement).toBe("mechanical");
    expect(legacy("agent", { model: "sonnet" }).requirement.requirement).toBe("routine");
    expect(legacy("agent", { model: "opus" }).requirement.requirement).toBe("frontier");
  });

  it("trims a padded value and ignores a non-string one", () => {
    expect(legacy("agent", { model: "  opus  " }).disposition).toBe("mapped");
    // A non-string value never reached the shipped gate, so it reads as absent
    // rather than being coerced into a class.
    expect(legacy("agent", { model: 5 }).disposition).toBe("absent");
    expect(legacy("agent", { model: "opus", effort: 3 }).legacy.effort).toBeUndefined();
  });

  it("tolerates frontmatter that is missing or not an object", () => {
    for (const frontmatter of [null, undefined, "model: opus", ["model"]]) {
      const result = interpretLegacy(frontmatter, { sourcePath: "x.md", artifactKind: "agent" });
      expect(result.disposition).toBe("absent");
      expect(result.requirement).toBeNull();
    }
  });

  it("marks every legacy-derived requirement so it is distinguishable from an authored one", () => {
    for (const fields of [{ model: "opus" }, { model: "inherit" }]) {
      const result = legacy("agent", fields);
      expect(result.requirement.provenance.adapterVersion).toBe("legacy");
      expect(result.requirement.provenance.sourceKind).toBe("artifact");
    }
  });
});

describe("dual declarations", () => {
  const canonical = (compute) => parseComputeDeclaration({ dotbabel: { compute } }, { sourcePath: "x.md" }).requirement;

  it("reports a conflict when dotbabel.compute and legacy model disagree in known meaning", () => {
    const declared = canonical({ requirement: "routine", binding: "self", mode: "dynamic" });
    const conflict = detectDualDeclarationConflict(declared, legacy("agent", { model: "opus" }));
    expect(conflict).not.toBeNull();
    expect(conflict.code).toBe(MI_DUAL_DECLARATION_CONFLICT);
    // Rule 3 of KD-1: neither side is chosen silently.
    expect(conflict.message).toMatch(/routine/);
    expect(conflict.message).toMatch(/frontier|deep/);
  });

  it("does not report a conflict when the legacy value is a synchronized projection of the declaration", () => {
    const declared = canonical({ requirement: "frontier", binding: "self", mode: "floor" });
    expect(detectDualDeclarationConflict(declared, legacy("agent", { model: "opus" }))).toBeNull();
  });

  it("does not report a conflict against an ambiguous or absent legacy value", () => {
    const declared = canonical({ requirement: "deep", binding: "self", mode: "dynamic" });
    expect(detectDualDeclarationConflict(declared, legacy("agent", { model: "gpt-5" }))).toBeNull();
    expect(detectDualDeclarationConflict(declared, legacy("agent", {}))).toBeNull();
  });

  it("does not report a conflict when there is no canonical declaration", () => {
    expect(detectDualDeclarationConflict(null, legacy("agent", { model: "opus" }))).toBeNull();
  });
});

describe("migration analysis", () => {
  const tree = [
    { sourcePath: "agents/a.md", artifactKind: "agent", frontmatter: artifact("agent", { model: "opus" }) },
    { sourcePath: "agents/b.md", artifactKind: "agent", frontmatter: artifact("agent", { model: "inherit" }) },
    { sourcePath: "agents/c.md", artifactKind: "agent", frontmatter: artifact("agent", { model: "gpt-5" }) },
    { sourcePath: "skills/d/SKILL.md", artifactKind: "skill", frontmatter: artifact("skill", { model: "sonnet", effort: "medium" }) },
    { sourcePath: "skills/e/SKILL.md", artifactKind: "skill", frontmatter: artifact("skill", {}) },
    {
      sourcePath: "agents/f.md",
      artifactKind: "agent",
      frontmatter: artifact("agent", { model: "sonnet", dotbabel: { compute: { requirement: "frontier", binding: "self", mode: "floor" } } }),
    },
  ];

  it("reports each fixture artifact as mapped, inherit, ambiguous, or conflict, proposes a declaration for the mapped ones, and writes nothing", () => {
    const report = analyzeMigration(tree);
    const byPath = Object.fromEntries(report.artifacts.map((entry) => [entry.sourcePath, entry]));
    expect(byPath["agents/a.md"].disposition).toBe("mapped");
    expect(byPath["agents/b.md"].disposition).toBe("inherit");
    expect(byPath["agents/c.md"].disposition).toBe("ambiguous");
    expect(byPath["skills/d/SKILL.md"].disposition).toBe("mapped");
    expect(byPath["skills/e/SKILL.md"].disposition).toBe("absent");
    expect(byPath["agents/f.md"].disposition).toBe("conflict");

    for (const entry of report.artifacts) {
      const shouldPropose = entry.disposition === "mapped" || entry.disposition === "inherit";
      expect(Boolean(entry.proposed), entry.sourcePath).toBe(shouldPropose);
    }
    expect(report.totals).toEqual({ mapped: 2, inherit: 1, ambiguous: 1, conflict: 1, absent: 1 });
    expect(new Set(Object.keys(report.totals))).toEqual(new Set(LEGACY_DISPOSITIONS));
    // Analysis is pure: it is handed frontmatter and returns a report.
    expect(report).not.toHaveProperty("written");
  });

  it("proposes a declaration that the canonical parser accepts", () => {
    for (const entry of analyzeMigration(tree).artifacts) {
      if (!entry.proposed) continue;
      const round = parseComputeDeclaration({ dotbabel: { compute: entry.proposed } }, { sourcePath: entry.sourcePath });
      expect(round.errors, entry.sourcePath).toEqual([]);
      expect(round.requirement, entry.sourcePath).not.toBeNull();
    }
  });

  it("is deterministic and preserves input order", () => {
    const first = analyzeMigration(tree);
    expect(analyzeMigration(tree)).toEqual(first);
    expect(first.artifacts.map((entry) => entry.sourcePath)).toEqual(tree.map((entry) => entry.sourcePath));
  });
});
