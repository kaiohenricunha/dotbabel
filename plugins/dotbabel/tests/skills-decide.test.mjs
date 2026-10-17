import fs from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
it("each judgment step's skill runs dotbabel decide", () => {
  const root = path.resolve(import.meta.dirname, "../../..");
  for (const [skill, step] of [["review-pr", "review-triage"], ["pr-conductor", "retry"], ["post-pr-review", "dispatch"]]) {
    const text = fs.readFileSync(path.join(root, "skills", skill, "SKILL.md"), "utf8");
    expect(text).toContain(`dotbabel decide --step ${step}`);
    expect(text).toContain("--decisions");
    expect(text).toContain("shadow");
  }
});
