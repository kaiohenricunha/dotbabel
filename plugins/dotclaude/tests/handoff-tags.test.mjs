// Unit tests for handoff tags first-class promotion (#91 Gap 7).
// Covers the migration helper `tagsFromMeta` and the description-side
// `parseTagsFromDescription` helper. End-to-end behavior (push, pull,
// list filter, histogram) is exercised by handoff-tags.bats.

import { describe, it, expect } from "vitest";
import { tagsFromMeta, parseTagsFromDescription } from "../src/lib/handoff-remote.mjs";

describe("tagsFromMeta", () => {
  it("returns the array as-is when metadata.tags is set", () => {
    expect(tagsFromMeta({ tags: ["shipping", "perf"] })).toEqual(["shipping", "perf"]);
  });

  it("falls back to [metadata.tag] when only the legacy field is set", () => {
    expect(tagsFromMeta({ tag: "shipping" })).toEqual(["shipping"]);
  });

  it("returns [] for null/empty/missing tag fields", () => {
    expect(tagsFromMeta({ tag: null })).toEqual([]);
    expect(tagsFromMeta({ tag: "" })).toEqual([]);
    expect(tagsFromMeta({})).toEqual([]);
    expect(tagsFromMeta(null)).toEqual([]);
    expect(tagsFromMeta(undefined)).toEqual([]);
  });

  it("prefers tags over the legacy tag field when both are present", () => {
    expect(tagsFromMeta({ tags: ["a", "b"], tag: "ignored" })).toEqual(["a", "b"]);
  });

  it("treats an empty tags array as no tags (not legacy fallback)", () => {
    // Explicit empty array means "no tags"; we should NOT fall back to .tag.
    expect(tagsFromMeta({ tags: [], tag: "ignored" })).toEqual([]);
  });
});

describe("parseTagsFromDescription", () => {
  it("returns [] for null/empty/non-handoff descriptions", () => {
    expect(parseTagsFromDescription(null)).toEqual([]);
    expect(parseTagsFromDescription("")).toEqual([]);
    expect(parseTagsFromDescription("not a handoff string")).toEqual([]);
  });

  it("returns [] for v2 descriptions without a tag segment", () => {
    expect(parseTagsFromDescription("handoff:v2:proj:claude:2026-04:abc12345:host")).toEqual([]);
  });

  it("returns [tag] for v2 descriptions with a single-tag segment (legacy)", () => {
    expect(
      parseTagsFromDescription("handoff:v2:proj:claude:2026-04:abc12345:host:shipping"),
    ).toEqual(["shipping"]);
  });

  it("splits comma-joined tag segment into an array (multi-tag)", () => {
    expect(
      parseTagsFromDescription("handoff:v2:proj:claude:2026-04:abc12345:host:shipping,perf"),
    ).toEqual(["shipping", "perf"]);
  });

  it("handles v1 descriptions (legacy) — single-tag only", () => {
    expect(parseTagsFromDescription("handoff:v1:claude:abc12345:proj:host:legacy")).toEqual([
      "legacy",
    ]);
    expect(parseTagsFromDescription("handoff:v1:claude:abc12345:proj:host")).toEqual([]);
  });
});
