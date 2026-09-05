import { describe, expect, it } from "vitest";

import {
  QUALITY_PROFILES,
  QUALITY_RULES,
  compareThreshold,
  hashQualityPolicy,
  selectProfileRules,
} from "../src/quality/policy.mjs";

describe("quality policy", () => {
  it("defines stable profiles and rule contracts", () => {
    expect(QUALITY_PROFILES).toEqual(["fast", "pr", "deep"]);
    expect(QUALITY_RULES["correctness.compile"]).toMatchObject({
      class: "hard",
      scope: "component",
      default_level: "error",
    });
    expect(QUALITY_RULES["size.file_loc"]).toMatchObject({
      class: "advisory",
      threshold: 500,
      unit: "loc",
    });
    expect(QUALITY_RULES["semantic.dynamic_types"].class).toBe("semantic");
    expect(QUALITY_RULES["correctness.format"].on_unavailable).toBe("error");
    expect(QUALITY_RULES["correctness.types"].on_unavailable).toBe("error");
  });

  it.each([
    ["complexity.cognitive", 15, true],
    ["complexity.cognitive", 16, false],
    ["size.function_loc", 75, true],
    ["size.function_loc", 76, false],
    ["size.file_loc", 500, true],
    ["size.file_loc", 501, false],
    ["coverage.changed_lines", 90, true],
    ["coverage.changed_lines", 89.99, false],
    ["mutation.changed_score", 85, true],
    ["mutation.changed_score", 84.99, false],
    ["duplication.percent", 5, true],
    ["duplication.percent", 5.01, false],
  ])("uses inclusive threshold for %s at %s", (ruleId, actual, pass) => {
    expect(compareThreshold(QUALITY_RULES[ruleId], actual)).toBe(pass);
  });

  it("selects profile membership without changing rule definitions", () => {
    expect(selectProfileRules("fast").some((rule) => rule.id === "correctness.tests")).toBe(false);
    expect(selectProfileRules("pr").some((rule) => rule.id === "correctness.tests")).toBe(true);
    expect(selectProfileRules("pr").some((rule) => rule.id === "mutation.changed_score")).toBe(false);
    expect(selectProfileRules("deep").some((rule) => rule.id === "mutation.changed_score")).toBe(true);
  });

  it("hashes equivalent policies deterministically", () => {
    const first = { enabled: true, rules: { "size.file_loc": { threshold: 400 } } };
    const second = { rules: { "size.file_loc": { threshold: 400 } }, enabled: true };
    expect(hashQualityPolicy(first)).toBe(hashQualityPolicy(second));
  });
});
