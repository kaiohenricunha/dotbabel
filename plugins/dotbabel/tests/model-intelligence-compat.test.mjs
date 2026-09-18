import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  LEGACY_DISPOSITIONS,
  MIGRATABLE_ARTIFACT_KINDS,
  MI_DECLARATION_INVALID,
  MI_DUAL_DECLARATION_CONFLICT,
  MI_LEGACY_EFFORT_UNKNOWN,
  MI_LEGACY_EFFORT_WITHOUT_MODEL,
  MI_LEGACY_MODEL_UNKNOWN,
  MI_PROPOSAL_DEFAULTED,
  analyzeMigration,
  canCarryComputeDeclaration,
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
      provenance: { sourceId: "x/agent.md", sourceKind: "artifact", derivation: "legacy-inferred" },
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

    // Each cause gets its own code, because `migrate --write` must treat them
    // differently: a typo, an owner decision, and a droppable value.
    for (const [fields, code] of [
      [{ model: "gpt-5" }, MI_LEGACY_MODEL_UNKNOWN],
      [{ model: "opus-ish" }, MI_LEGACY_MODEL_UNKNOWN],
      [{ effort: "max" }, MI_LEGACY_EFFORT_WITHOUT_MODEL],
      [{ model: "opus", effort: "ultra" }, MI_LEGACY_EFFORT_UNKNOWN],
    ]) {
      const result = legacy("agent", fields);
      expect(result.disposition, JSON.stringify(fields)).toBe("ambiguous");
      expect(result.requirement, JSON.stringify(fields)).toBeNull();
      expect(result.codes, JSON.stringify(fields)).toEqual([code]);
    }
  });

  it("reports no declaration at all when the artifact carries neither key", () => {
    const result = legacy("agent", {});
    expect(result.disposition).toBe("absent");
    expect(result.requirement).toBeNull();
    expect(result.codes).toEqual([]);
  });

  it("flags every mapped proposal as defaulted, because DOC-1 decides the class per artifact", () => {
    // DOC-1 maps `opus` to Deep on aws-engineer, Frontier on platform-engineer, and
    // Exceptional on workflow-orchestrator, and keeps the two security agents
    // pinned rather than floored. One alias table cannot answer that, so a proposal
    // derived from the alias alone is report-only until an owner decides (IMPL-7).
    const result = legacy("agent", { model: "opus" });
    expect(result.disposition).toBe("mapped");
    expect(result.codes).toContain(MI_PROPOSAL_DEFAULTED);
    expect(result.notes.join(" ")).toMatch(/owner decision is required/);
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
    expect(result.codes).toEqual([MI_LEGACY_EFFORT_UNKNOWN]);
    expect(result.notes.join(" ")).toContain("ultra");
  });

  it("preserves a legal effort as authoring intent alongside the mapped class", () => {
    const result = legacy("agent", { model: "opus", effort: "max" });
    expect(result.disposition).toBe("mapped");
    expect(result.codes).toEqual([MI_PROPOSAL_DEFAULTED]);
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
      // `sourceKind` is `artifact` for an authored declaration too, so the
      // discriminator is its own field rather than a sentinel in a version string.
      expect(result.requirement.provenance.derivation).toBe("legacy-inferred");
      expect(result.requirement.provenance.sourceKind).toBe("artifact");
      expect(result.requirement.provenance.adapterVersion).toBeUndefined();
    }
  });
});

describe("legacy interpretation is not fooled by inherited object keys", () => {
  // A lookup table written as an object literal answers `Object.prototype` for
  // `__proto__` and a function for `toString`, which is not `undefined`, so an
  // `=== undefined` guard lets the value through. That reported an alias that was
  // never valid as `mapped`, produced a requirement whose class was an object or a
  // function, and — worst — suppressed the KD-1 rule-3 conflict gate, because the
  // bogus class is not in WORKLOAD_CLASSES and the comparison bailed out.
  const INHERITED_KEYS = ["__proto__", "constructor", "toString", "valueOf", "hasOwnProperty", "isPrototypeOf"];

  it("treats every inherited object key as an ambiguous model, not a mapped one", () => {
    for (const key of INHERITED_KEYS) {
      const result = legacy("agent", { model: key });
      expect(result.disposition, key).toBe("ambiguous");
      expect(result.requirement, key).toBeNull();
      expect(result.codes, key).toEqual([MI_LEGACY_MODEL_UNKNOWN]);
    }
  });

  it("does not let an inherited artifact kind become a non-string binding", () => {
    for (const key of INHERITED_KEYS) {
      const result = interpretLegacy(artifact("agent", { model: "opus" }), { sourcePath: "x.md", artifactKind: key });
      expect(typeof result.requirement.binding, key).toBe("string");
      expect(result.requirement.binding, key).toBe("consumer");
    }
  });

  it("still counts an inherited-key artifact as ambiguous in the migration report", () => {
    // The report is what a human reads to decide a migration, and what `--write`
    // will consume in P-18. An inherited key must not arrive there as "mapped".
    const report = analyzeMigration([
      { sourcePath: "agents/proto.md", artifactKind: "agent", frontmatter: artifact("agent", { model: "__proto__" }) },
    ]);
    expect(report.totals.mapped).toBe(0);
    expect(report.totals.ambiguous).toBe(1);
    expect(report.artifacts[0].proposed).toBeUndefined();
  });
});

describe("author-controlled values are bounded before they reach a report", () => {
  it("truncates a long value in both the note and the echoed legacy object", () => {
    const long = "z".repeat(5000);
    const result = legacy("agent", { model: long });
    expect(result.legacy.model.length).toBeLessThanOrEqual(80);
    for (const note of result.notes) expect(note.length).toBeLessThan(400);
  });

  it("neutralises control characters so a value cannot rewrite terminal output", () => {
    // The note reaches a TTY through the CLI with ANSI enabled, and the JSON report
    // verbatim, so an escape sequence here could hide or forge surrounding lines.
    const nasty = "opus\u001b[2K\u001b[1Ginjected\nsecond line";
    const result = legacy("agent", { model: nasty });
    const rendered = JSON.stringify({ notes: result.notes, legacy: result.legacy });
    expect(rendered).not.toContain("\u001b");
    expect(result.legacy.model).not.toContain("\n");
    expect(result.disposition).toBe("ambiguous");
  });

  it("quotes an echoed value so it cannot break out of the surrounding message", () => {
    const result = legacy("agent", { model: 'opus" and then some' });
    expect(result.disposition).toBe("ambiguous");
    // JSON.stringify escapes the embedded quote rather than ending the quoted span.
    expect(result.notes.join(" ")).toContain('\\"');
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
    expect(report.totals).toEqual({ mapped: 2, inherit: 1, ambiguous: 1, conflict: 1, "invalid-declaration": 0, absent: 1 });
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

  it("reports a canonical declaration that does not parse, and never proposes beside it", () => {
    // This used to read as `mapped` with a proposal and exit 0: the parse failure left
    // `requirement` null, so the conflict check had nothing to compare (KD-1 rule 4).
    const report = analyzeMigration([
      {
        sourcePath: "agents/broken.md",
        artifactKind: "agent",
        frontmatter: artifact("agent", { model: "opus", dotbabel: { compute: { requrement: "deep", binding: "self", mode: "dynamic" } } }),
      },
    ]);
    const entry = report.artifacts[0];
    expect(entry.disposition).toBe("invalid-declaration");
    expect(entry.codes).toContain(MI_DECLARATION_INVALID);
    expect(entry.declarationErrors.length).toBeGreaterThan(0);
    expect(entry.declarationErrors[0].pointer).toMatch(/^\/dotbabel/);
    expect(entry.proposed).toBeUndefined();
    expect(report.totals["invalid-declaration"]).toBe(1);
  });

  it("returns a named, versioned envelope so P-18 can add modes without drift", () => {
    const report = analyzeMigration([]);
    expect(report.envelope).toBe("MigrationReport");
    expect(report.version).toBe(1);
    expect(report.mode).toBe("analysis");
    expect(report.artifacts).toEqual([]);
    // Every disposition is present at zero, so a consumer never has to guess.
    expect(Object.keys(report.totals).sort()).toEqual([...LEGACY_DISPOSITIONS].sort());
  });

  it("states declared as a boolean on every entry", () => {
    const report = analyzeMigration(tree);
    for (const entry of report.artifacts) expect(typeof entry.declared, entry.sourcePath).toBe("boolean");
    expect(report.artifacts.find((e) => e.sourcePath === "agents/f.md").declared).toBe(true);
    expect(report.artifacts.find((e) => e.sourcePath === "agents/a.md").declared).toBe(false);
  });

  it("is deterministic and preserves input order", () => {
    const first = analyzeMigration(tree);
    expect(analyzeMigration(tree)).toEqual(first);
    expect(first.artifacts.map((entry) => entry.sourcePath)).toEqual(tree.map((entry) => entry.sourcePath));
  });
});

describe("compat module boundaries", () => {
  it("owns which artifact kinds can carry a compute declaration", () => {
    // The CLI used to hold a second, narrower table that disagreed about `workflow`
    // (IMPL-4). One answer now lives here.
    for (const kind of ["agent", "command", "skill", "workflow"]) {
      expect(canCarryComputeDeclaration(kind), kind).toBe(true);
    }
    for (const kind of ["hook", "template", "nonsense", "__proto__"]) {
      expect(canCarryComputeDeclaration(kind), kind).toBe(false);
    }
    expect(MIGRATABLE_ARTIFACT_KINDS).toEqual(["agent", "command", "skill", "workflow"]);
  });

  it("imports only the domain and requirement modules, and performs no I/O", () => {
    // ARCH-56 and ARCH-57 rules 7 and 8. The two neighbouring units guard this the
    // same way; compat/ was the one Phase 1 module where a future edit could add
    // filesystem access or a quality/ import and stay green, and IMPL-9 keeps this
    // module alive for the whole migration window.
    const source = readFileSync(fileURLToPath(new URL("../src/model-intelligence/compat/index.mjs", import.meta.url)), "utf8");
    const imports = [...source.matchAll(/^\s*import\s[^;]*?from\s+["']([^"']+)["']/gm)].map((m) => m[1]);
    expect(imports.every((specifier) => specifier.startsWith("../domain/") || specifier.startsWith("../requirement/"))).toBe(true);
    expect(imports.filter((s) => /^(node:)?(fs|fs\/promises|child_process|http|https|os)$/.test(s))).toEqual([]);
    expect(imports.filter((s) => /quality|sources/.test(s))).toEqual([]);
    // Skipped under Stryker, which injects a process.env read of its own.
    if (globalThis.__stryker__ === undefined) {
      expect(source).not.toMatch(/\bDate\.now\(|\bprocess\.env\b/);
    }
  });
});
