import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Ajv from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
function schema(name) { return JSON.parse(fs.readFileSync(path.join(root, "schemas", name), "utf8")); }

describe("quality exchange schemas", () => {
  it("validates a dotbabel-v1 report", () => {
    const validate = new Ajv({ strict: false }).compile(schema("dotbabel.quality-report.schema.json"));
    expect(validate({ schema_version: 1, metrics: [{ rule: "duplication.percent", actual: 4 }], findings: [] })).toBe(true);
    expect(validate({ schema_version: 2, metrics: [], findings: [] })).toBe(false);
  });

  it("validates a committed baseline", () => {
    const validate = new Ajv({ strict: false }).compile(schema("dotbabel.quality-baseline.schema.json"));
    expect(validate({ schema_version: 1, source_revision: "abc", policy_hash: "sha256:abc", components: {}, tool_versions: {}, metrics: [], findings: [] })).toBe(true);
    expect(validate({ schema_version: 1, metrics: [], findings: [] })).toBe(false);
  });
});
