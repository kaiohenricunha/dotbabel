/**
 * ARCH-6 — one Spec ID parser for the command and the merge gate.
 *
 * Two parsers is not a style problem, it is a correctness one: before this
 * module, `"dotbabel-core"` passed the coverage gate and then exited 2 in the
 * command, and `dotbabel-core.` did the reverse. These tests pin the shared
 * behaviour, including the fence-awareness the command's old parser lacked.
 */
import { describe, it, expect } from "vitest";
import { parseSpecIds, parseSpecIdSection, normalizeSpecId, stripFences } from "../src/lib/spec-ids.mjs";

describe("parseSpecIds", () => {
  it("parses the same Spec IDs for the command and the gate and ignores fenced code", () => {
    const body = [
      "## Summary",
      "",
      "Docs showing the convention must not declare a spec:",
      "",
      "```markdown",
      "## Spec ID",
      "",
      "example-from-the-docs",
      "```",
      "",
      "## Spec ID",
      "",
      "real-spec",
      "",
    ].join("\n");

    expect(parseSpecIds(body)).toEqual(["real-spec"]);
  });

  it("returns no ids when the section is absent or fenced away entirely", () => {
    expect(parseSpecIds("## Summary\n\nnothing here\n")).toEqual([]);
    expect(parseSpecIds("```\n## Spec ID\n\nonly-an-example\n```\n")).toEqual([]);
  });

  it("stops at the next h2, so a trailing footer is not parsed as ids", () => {
    const body = "## Spec ID\n\nalpha\n\n## Notes\n\nnot-an-id\n";
    expect(parseSpecIds(body)).toEqual(["alpha"]);
  });

  it("drops html comments so a commented-out id is not a declaration", () => {
    expect(parseSpecIds("## Spec ID\n\n<!-- retired-spec -->\nalpha\n")).toEqual(["alpha"]);
  });

  it("splits on whitespace and commas, normalizes, and dedupes in first-seen order", () => {
    expect(parseSpecIdSection('beta, "alpha"  `beta`\nalpha')).toEqual(["beta", "alpha"]);
  });

  it("leaves a path-shaped token intact so the caller can reject it", () => {
    // Containment is the caller's job (preconditions checks listSpecDirs);
    // silently rewriting the token here would hide the attack rather than
    // surface it.
    expect(parseSpecIdSection("../../evil")).toEqual(["../../evil"]);
  });
});

describe("normalizeSpecId", () => {
  it.each([
    ['"dotbabel-core"', "dotbabel-core"],
    ["`example`", "example"],
    ["##example", "example"],
    ["'example'", "example"],
    ["plain", "plain"],
  ])("normalizes %s", (input, expected) => {
    expect(normalizeSpecId(input)).toBe(expected);
  });

  it("keeps a trailing period, which the coverage gate has always treated as part of the id", () => {
    expect(normalizeSpecId("dotbabel-core.")).toBe("dotbabel-core.");
  });
});

describe("stripFences", () => {
  it("removes backtick and tilde fences", () => {
    expect(stripFences("a\n```\nhidden\n```\nb")).toBe("a\nb");
    expect(stripFences("a\n~~~\nhidden\n~~~\nb")).toBe("a\nb");
  });

  it("does not let a different fence character close a block", () => {
    // Per CommonMark 4.5 only the same character, at least as long, closes it.
    expect(stripFences("a\n~~~\n```\nstill inside\n~~~\nb")).toBe("a\nb");
  });
});
