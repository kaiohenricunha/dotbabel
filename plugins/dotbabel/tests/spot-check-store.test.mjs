// spot-check-store — the merge-time spot-check log, kept beside the run receipt.
//
// The run receipt is strict, and every installed CLI version on a machine
// reads the same receipt directory. A spot-check key added to the receipt
// made an older CLI refuse the whole file, so the log lives in its own file
// with its own schema. These cases pin that split, the append-only shape, the
// sticky selection, and that the validator and the published schema agree.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import Ajv from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

import {
  CI_STATES,
  appendSpotCheck,
  createSpotCheckStore,
  firstSelection,
  spotCheckStorePath,
  spotCheckStoreProblem,
  summarizeSpotChecks,
} from "../src/spot-check-store.mjs";
import { SPOT_CHECK_REASONS } from "../src/merge-verification.mjs";
import { appendAttempt, createReceipt, receiptPath, receiptProblem, receiptVerdict, summarizePhases } from "../src/run-receipt.mjs";

const HEAD_A = "a".repeat(40);
const HEAD_B = "b".repeat(40);
const T0 = new Date("2026-10-12T10:00:00Z");
const T1 = new Date("2026-10-12T10:05:00Z");
const T2 = new Date("2026-10-12T10:10:00Z");

const decision = { kind: "spot-check", headSha: HEAD_A, selected: true, reason: "rate", rate: 0.2, roll: 0.05, ci: "available", workflow: "test.yml", trunk: "main" };

const schema = JSON.parse(readFileSync(path.resolve(import.meta.dirname, "../../../schemas/dotbabel.spot-checks.schema.json"), "utf8"));
const ajv = new Ajv({ allErrors: true });
addFormats(ajv);
const validate = ajv.compile(schema);

describe("spotCheckStorePath", () => {
  it("puts the log beside the run receipt, never inside it", () => {
    const file = spotCheckStorePath("/repo/.git", 42);
    expect(file).toBe(path.join("/repo/.git", "dotbabel", "receipts", "pr-42.spot-checks.json"));
    expect(path.dirname(file)).toBe(path.dirname(receiptPath("/repo/.git", 42)));
    expect(file).not.toBe(receiptPath("/repo/.git", 42));
    expect(() => spotCheckStorePath("/repo/.git", 0)).toThrow(/pr/);
  });
});

describe("appendSpotCheck", () => {
  it("records a spot-check decision as its own append-only entry", () => {
    const s = appendSpotCheck(createSpotCheckStore({ pr: 7, now: T0 }), { ...decision, toolVersion: "4.0.0", now: T1 });
    expect(s.schema_version).toBe(1);
    expect(s.updated_at).toBe(T1.toISOString());
    expect(s.entries).toEqual([
      {
        kind: "spot-check",
        at: T1.toISOString(),
        head_sha: HEAD_A,
        selected: true,
        reason: "rate",
        rate: 0.2,
        roll: 0.05,
        ci: "available",
        workflow: "test.yml",
        trunk: "main",
        sticky: false,
        tool_version: "4.0.0",
      },
    ]);
    expect(spotCheckStoreProblem(s, 7)).toBeNull();
    expect(validate(s), JSON.stringify(validate.errors)).toBe(true);
  });

  it("records an explicit verification run for a head", () => {
    const s = appendSpotCheck(createSpotCheckStore({ pr: 7, now: T0 }), { kind: "explicit-run", headSha: HEAD_A.toUpperCase(), outcome: "fail", now: T1 });
    expect(s.entries).toEqual([{ kind: "explicit-run", at: T1.toISOString(), head_sha: HEAD_A, outcome: "fail", tool_version: null }]);
    expect(spotCheckStoreProblem(s)).toBeNull();
  });

  it("never mutates the log it was given", () => {
    const before = createSpotCheckStore({ pr: 7, now: T0 });
    const snapshot = JSON.stringify(before);
    appendSpotCheck(before, { ...decision, now: T1 });
    expect(JSON.stringify(before)).toBe(snapshot);
  });

  it("refuses an entry of an unknown kind or with bad fields", () => {
    const s = createSpotCheckStore({ pr: 7, now: T0 });
    expect(() => appendSpotCheck(s, { ...decision, kind: "audit" })).toThrow(/kind/);
    expect(() => appendSpotCheck(s, { ...decision, headSha: "abc" })).toThrow(/head/);
    expect(() => appendSpotCheck(s, { ...decision, reason: "luck" })).toThrow(/reason/);
    expect(() => appendSpotCheck(s, { ...decision, rate: 1.5 })).toThrow(/rate/);
    expect(() => appendSpotCheck(s, { ...decision, roll: 1 })).toThrow(/roll/);
    expect(() => appendSpotCheck(s, { ...decision, ci: "maybe" })).toThrow(/ci/);
    expect(() => appendSpotCheck(s, { ...decision, workflow: "../x.yml" })).toThrow(/workflow/);
    expect(() => appendSpotCheck(s, { ...decision, trunk: "main;rm" })).toThrow(/trunk/);
    expect(() => appendSpotCheck(s, { ...decision, sticky: "yes" })).toThrow(/sticky/);
    expect(() => appendSpotCheck(s, { kind: "explicit-run", headSha: HEAD_A, outcome: "skipped" })).toThrow(/outcome/);
  });
});

describe("the run receipt keeps its v1 shape", () => {
  it("keeps spot-check entries out of the attempt count, the cap, and the ready verdict", () => {
    // The receipt module has no spot-check key at all: an older CLI reads it.
    let r = createReceipt({ pr: 7, now: T0 });
    for (const phase of ["review-pr", "local-attest", "stop"]) {
      r = appendAttempt(r, { phase, outcome: "pass", headSha: HEAD_A, now: T1 });
    }
    const before = JSON.stringify(r);
    const store = appendSpotCheck(appendSpotCheck(createSpotCheckStore({ pr: 7, now: T0 }), { ...decision, now: T2 }), {
      kind: "explicit-run",
      headSha: HEAD_A,
      outcome: "fail",
      now: T2,
    });
    expect(store.entries).toHaveLength(2);
    expect(JSON.stringify(r)).toBe(before);
    expect(Object.keys(r)).toEqual(["schema_version", "tool", "pr", "created_at", "updated_at", "attempts"]);
    expect(receiptVerdict(r)).toBe("ready");
    expect(summarizePhases(r)["review-pr"]).toEqual({ attempts: 1, last_outcome: "pass", consecutive_failures: 0 });
    // A receipt that carries a spot-check key is refused, so nothing may write one there.
    expect(receiptProblem({ ...r, spot_checks: [] }, 7)).toMatch(/unknown key/);
  });
});

describe("sticky selection", () => {
  it("reports the first selection of a head when the head is asked again", () => {
    let s = createSpotCheckStore({ pr: 7, now: T0 });
    s = appendSpotCheck(s, { ...decision, ci: "unavailable", reason: "ci_unavailable", rate: 1, now: T0 });
    s = appendSpotCheck(s, { ...decision, selected: true, reason: "ci_unavailable", rate: 1, sticky: true, now: T1 });
    expect(firstSelection(s, HEAD_A.toUpperCase())).toMatchObject({ reason: "ci_unavailable", at: T0.toISOString() });
    expect(summarizeSpotChecks(s)).toEqual([{ head_sha: HEAD_A, selected: true, reason: "ci_unavailable", rate: 1, sticky: true, explicit: null }]);
  });

  it("keeps a selection that a hand-written later entry says was not selected", () => {
    let s = createSpotCheckStore({ pr: 7, now: T0 });
    s = appendSpotCheck(s, { ...decision, now: T0 });
    s = appendSpotCheck(s, { ...decision, selected: false, reason: "not_selected", now: T1 });
    expect(summarizeSpotChecks(s)[0]).toMatchObject({ selected: true, reason: "rate", sticky: true });
  });

  it("lets a non-selection change, because only a selection is sticky", () => {
    let s = createSpotCheckStore({ pr: 7, now: T0 });
    s = appendSpotCheck(s, { ...decision, selected: false, reason: "not_selected", now: T0 });
    expect(firstSelection(s, HEAD_A)).toBeNull();
    s = appendSpotCheck(s, { ...decision, selected: true, reason: "ci_unavailable", rate: 1, now: T1 });
    expect(summarizeSpotChecks(s)[0]).toMatchObject({ selected: true, reason: "ci_unavailable", sticky: false });
  });

  it("finds no selection for another head or an empty log", () => {
    const s = appendSpotCheck(createSpotCheckStore({ pr: 7, now: T0 }), { ...decision, now: T0 });
    expect(firstSelection(s, HEAD_B)).toBeNull();
    expect(firstSelection(null, HEAD_A)).toBeNull();
  });
});

describe("summarizeSpotChecks", () => {
  it("reports, per head, the decision that stands and whether an explicit run was recorded", () => {
    let s = createSpotCheckStore({ pr: 7, now: T0 });
    s = appendSpotCheck(s, { ...decision, selected: false, reason: "not_selected", roll: 0.7, now: T0 });
    s = appendSpotCheck(s, { ...decision, headSha: HEAD_B, roll: 0.1, now: T1 });
    s = appendSpotCheck(s, { kind: "explicit-run", headSha: HEAD_B, outcome: "pass", now: T2 });
    expect(summarizeSpotChecks(s)).toEqual([
      { head_sha: HEAD_A, selected: false, reason: "not_selected", rate: 0.2, sticky: false, explicit: null },
      { head_sha: HEAD_B, selected: true, reason: "rate", rate: 0.2, sticky: false, explicit: "pass" },
    ]);
  });

  it("is empty for a log with no entries", () => {
    expect(summarizeSpotChecks(createSpotCheckStore({ pr: 7, now: T0 }))).toEqual([]);
  });
});

describe("spotCheckStoreProblem agrees with the published schema", () => {
  const good = () =>
    appendSpotCheck(appendSpotCheck(createSpotCheckStore({ pr: 7, now: T0 }), { ...decision, toolVersion: "4.0.0", now: T1 }), {
      kind: "explicit-run",
      headSha: HEAD_A,
      outcome: "pass",
      now: T2,
    });
  const mutations = {
    "valid log": () => {},
    "extra top-level key": (s) => (s.attempts = []),
    "schema_version 2": (s) => (s.schema_version = 2),
    "wrong tool": (s) => (s.tool = "other"),
    "pr zero": (s) => (s.pr = 0),
    "created_at not a date": (s) => (s.created_at = "yesterday"),
    "entries not an array": (s) => (s.entries = {}),
    "unknown entry kind": (s) => (s.entries[0].kind = "audit"),
    "spot-check extra key": (s) => (s.entries[0].note = "x"),
    "spot-check missing reason": (s) => delete s.entries[0].reason,
    "spot-check missing workflow": (s) => delete s.entries[0].workflow,
    "spot-check missing sticky": (s) => delete s.entries[0].sticky,
    "spot-check unknown reason": (s) => (s.entries[0].reason = "luck"),
    "spot-check rate above 1": (s) => (s.entries[0].rate = 2),
    "spot-check roll of 1": (s) => (s.entries[0].roll = 1),
    "spot-check selected not boolean": (s) => (s.entries[0].selected = "yes"),
    "spot-check unknown ci": (s) => (s.entries[0].ci = "maybe"),
    "spot-check workflow path": (s) => (s.entries[0].workflow = "a/b.yml"),
    "spot-check trunk with space": (s) => (s.entries[0].trunk = "ma in"),
    "spot-check sticky not boolean": (s) => (s.entries[0].sticky = 1),
    "spot-check uppercase head": (s) => (s.entries[0].head_sha = "A".repeat(40)),
    "explicit-run unknown outcome": (s) => (s.entries[1].outcome = "blocked"),
    "explicit-run with a reason": (s) => (s.entries[1].reason = "rate"),
    "numeric tool_version": (s) => (s.entries[0].tool_version = 4),
  };
  for (const [name, mutate] of Object.entries(mutations)) {
    it(`agrees on: ${name}`, () => {
      const s = good();
      mutate(s);
      expect(spotCheckStoreProblem(s) === null).toBe(validate(s));
    });
  }

  it("refuses a log that belongs to another pull request", () => {
    expect(spotCheckStoreProblem(good(), 8)).toMatch(/expected 8/);
    expect(spotCheckStoreProblem(null)).toMatch(/object/);
  });

  it("lists exactly the spot-check reasons and CI states the code uses", () => {
    expect(schema.properties.entries.items.oneOf[0].properties.reason.enum).toEqual([...SPOT_CHECK_REASONS]);
    expect(schema.properties.entries.items.oneOf[0].properties.ci.enum).toEqual([...CI_STATES]);
  });
});
