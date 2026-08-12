// The published schema is what gives `.dotbabel.json` editor autocomplete and
// validation in consumer repos, so it has to stay in step with both the
// scaffolded default and this repo's own config (#219, finding E).

import { describe, it, expect } from "vitest";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import Ajv from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { DEFAULT_DOTBABEL_JSON } from "../src/project-init-scaffold.mjs";
import { KNOWN_FAN_OUT_CLIS } from "../src/project-sync.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const SCHEMA_PATH = path.join(REPO_ROOT, "schemas", "dotbabel.config.schema.json");
const SCHEMA_ID = "https://dotbabel.dev/schemas/dotbabel.config.schema.json";

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

function compile() {
  const ajv = new Ajv({ allErrors: true, strict: false });
  addFormats(ajv);
  return ajv.compile(readJson(SCHEMA_PATH));
}

describe("dotbabel.config.schema.json", () => {
  it("declares the conventional $id and draft", () => {
    const schema = readJson(SCHEMA_PATH);
    expect(schema.$id).toBe(SCHEMA_ID);
    expect(schema.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
  });

  it("accepts this repo's own .dotbabel.json", () => {
    const validate = compile();
    const ok = validate(readJson(path.join(REPO_ROOT, ".dotbabel.json")));
    expect(validate.errors ?? []).toEqual([]);
    expect(ok).toBe(true);
  });

  it("accepts the scaffolded default", () => {
    const validate = compile();
    const ok = validate(JSON.parse(JSON.stringify(DEFAULT_DOTBABEL_JSON)));
    expect(validate.errors ?? []).toEqual([]);
    expect(ok).toBe(true);
  });

  it("rejects an unknown fan_out CLI", () => {
    const validate = compile();
    expect(validate({ fan_out: ["co-pilot"] })).toBe(false);
  });

  it("enumerates exactly the CLIs the code knows about", () => {
    const schema = readJson(SCHEMA_PATH);
    expect(schema.properties.fan_out.items.enum).toEqual([...KNOWN_FAN_OUT_CLIS]);
  });

  it("is referenced by both the scaffolded default and this repo's config", () => {
    expect(DEFAULT_DOTBABEL_JSON.$schema).toBe(SCHEMA_ID);
    expect(readJson(path.join(REPO_ROOT, ".dotbabel.json")).$schema).toBe(SCHEMA_ID);
  });
});
