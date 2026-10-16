import fs from "node:fs";
import { expect, it } from "vitest";
it("the package has four runtime dependencies", () => {
  const pkg = JSON.parse(fs.readFileSync(new URL("../../../package.json", import.meta.url), "utf8"));
  expect(Object.keys(pkg.dependencies).sort()).toEqual(["ajv", "ajv-formats", "js-yaml", "prettier"]);
});
