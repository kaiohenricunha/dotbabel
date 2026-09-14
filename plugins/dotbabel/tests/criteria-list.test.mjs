import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHarnessContext } from "../src/spec-harness-lib.mjs";
import { listCriteria } from "../src/criteria/list.mjs";
import { ERROR_CODES } from "../src/lib/errors.mjs";

const dirs = [];
afterEach(() => dirs.splice(0).forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));

function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "criteria-list-"));
  dirs.push(dir);
  fs.mkdirSync(path.join(dir, "docs", "specs"), { recursive: true });
  return dir;
}

/** Write docs/specs/<id>/spec.json. Omit `criteria` to leave the acceptance_criteria key out. */
function writeSpec(dir, id, criteria) {
  const specDir = path.join(dir, "docs", "specs", id);
  fs.mkdirSync(specDir, { recursive: true });
  const spec = { id, status: "approved" };
  if (criteria !== undefined) spec.acceptance_criteria = criteria;
  fs.writeFileSync(path.join(specDir, "spec.json"), JSON.stringify(spec));
}

describe("listCriteria", () => {
  it("lists one spec's criteria sorted by number, with tests sorted by file then name and a missing status reported as active", () => {
    const dir = makeRepo();
    writeSpec(dir, "example", [
      {
        id: "AC-10",
        given: "g10",
        when: "w10",
        then: "t10",
        tests: [
          { file: "b.mjs", name: "z" },
          { file: "a.mjs", name: "y" },
          { file: "a.mjs", name: "x" },
        ],
        argv: ["node", "ten.mjs"],
      },
      { id: "AC-2", status: "planned", given: "g2", when: "w2", then: "t2", argv: ["node", "two.mjs"] },
    ]);
    const result = listCriteria(createHarnessContext({ repoRoot: dir }), { specId: "example" });
    expect(result).toEqual({
      schema_version: 1,
      specs: [
        {
          id: "example",
          criteria: [
            { id: "AC-2", status: "planned", given: "g2", when: "w2", then: "t2", tests: [], argv: ["node", "two.mjs"] },
            {
              id: "AC-10",
              status: "active",
              given: "g10",
              when: "w10",
              then: "t10",
              tests: [
                { file: "a.mjs", name: "x" },
                { file: "a.mjs", name: "y" },
                { file: "b.mjs", name: "z" },
              ],
              argv: ["node", "ten.mjs"],
            },
          ],
        },
      ],
    });
  });

  it("lists every spec that declares criteria, sorted by id, and skips specs without any", () => {
    const dir = makeRepo();
    const criterion = { id: "AC-1", given: "g", when: "w", then: "t", tests: [], argv: ["node"] };
    writeSpec(dir, "zeta", [criterion]);
    writeSpec(dir, "alpha", [criterion]);
    writeSpec(dir, "no-key");
    writeSpec(dir, "empty", []);
    const result = listCriteria(createHarnessContext({ repoRoot: dir }));
    expect(result.specs.map((spec) => spec.id)).toEqual(["alpha", "zeta"]);
  });

  it("throws CRITERIA_UNKNOWN_SPEC for a spec id that has no spec.json", () => {
    const dir = makeRepo();
    writeSpec(dir, "example", []);
    let error;
    try {
      listCriteria(createHarnessContext({ repoRoot: dir }), { specId: "missing" });
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({ code: ERROR_CODES.CRITERIA_UNKNOWN_SPEC });
  });
});
