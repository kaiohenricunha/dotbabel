import { describe, expect, it } from "vitest";

import { qualityEnvelope, renderQualityHuman } from "../src/quality/reporters.mjs";

describe("quality reporters", () => {
  it("creates a versioned envelope and renders disabled checks", () => {
    expect(qualityEnvelope("check", { state: "disabled" })).toEqual({ schema_version: 1, command: "check", state: "disabled" });
    expect(renderQualityHuman({ state: "disabled" })).toContain("disabled by project policy");
  });

  it("renders detection evidence, plans, exclusions, and rejected candidates", () => {
    const text = renderQualityHuman({
      command: "detect",
      trust: { trusted: true },
      components: [
        { id: "api:go", state: "checked", markers: ["api/go.mod"] },
        { id: "src:rust", state: "unsupported", markers: [] },
      ],
      plans: [
        { componentId: "api:go", capability: "lint", availability: "available", source: "built-in", executable: "go", argv: ["vet", "./..."] },
        { componentId: "src:rust", capability: "lint", availability: "not_configured", candidates: ["cargo clippy", "make lint"] },
      ],
      exclusions: [{ count: 2, reason: "generated marker" }],
      rejected_candidates: ["CI workflow command is suggestion-only"],
    });
    expect(text).toContain("Project command trust: trusted");
    expect(text).toContain("go vet ./...");
    expect(text).toContain("cargo clippy, make lint");
    expect(text).toContain("excluded: 2 file(s)");
    expect(text).toContain("rejected: CI workflow");
  });

  it("renders resolved policy rules and grouped check results", () => {
    const explained = renderQualityHuman({ command: "explain", profile: "fast", policy: { rules: {
      lint: { id: "lint", class: "hard", scope: "component", level: "error", on_unavailable: "error", provenance: { level: "project" } },
      size: { id: "size", class: "advisory", scope: "changed", level: "warning", threshold: 75, on_unavailable: "info", provenance: { threshold: "user" } },
    } } });
    expect(explained).toContain("lint: class=hard");
    expect(explained).toContain("threshold=75");
    expect(explained).toContain("provenance=user");

    const checked = renderQualityHuman({ command: "check", verdict: "warn", results: [
      { component: "api:go", class: "hard", verdict: "pass", rule: "correctness.compile", state: "checked" },
      { class: "advisory", verdict: "warn", rule: "size.file_loc", state: "checked", message: "large file" },
    ] });
    expect(checked).toContain("api:go / hard");
    expect(checked).toContain("repository / advisory");
    expect(checked).toContain("large file");
  });

  it("prints a candidate baseline in human output", () => {
    const text = renderQualityHuman({ command: "baseline", verdict: "pass", results: [], baseline: { schema_version: 1, metrics: [], findings: [] } });
    expect(text).toContain("Candidate baseline:");
    expect(text).toContain('"schema_version": 1');
  });
});
