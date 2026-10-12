import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import Ajv from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

import {
  RECEIPT_OUTCOMES,
  appendAttempt,
  createReceipt,
  frontmatterModel,
  receiptPath,
  receiptProblem,
  receiptVerdict,
  rollbackPoint,
  summarizePhases,
} from "../src/run-receipt.mjs";
import { CONDUCTOR_PHASES } from "../src/pr-gates.mjs";

const HEAD_A = "a".repeat(40);
const HEAD_B = "b".repeat(40);
const BASE = "c".repeat(40);
const T0 = new Date("2026-10-12T10:00:00Z");
const T1 = new Date("2026-10-12T10:05:00Z");
const T2 = new Date("2026-10-12T10:10:00Z");

/** A receipt with the given attempts appended in order. */
function receiptWith(...attempts) {
  return attempts.reduce(
    (r, a, i) =>
      appendAttempt(r, { headSha: HEAD_A, mergeBase: BASE, baseRef: "main", ...a, now: new Date(T0.getTime() + i * 1000) }),
    createReceipt({ pr: 7, now: T0 }),
  );
}

describe("createReceipt", () => {
  it("starts an empty, valid receipt for one pull request", () => {
    const r = createReceipt({ pr: 7, now: T0 });
    expect(r).toEqual({
      schema_version: 1,
      tool: "dotbabel-pr-stack",
      pr: 7,
      created_at: T0.toISOString(),
      updated_at: T0.toISOString(),
      attempts: [],
    });
    expect(receiptProblem(r)).toBeNull();
  });

  it("refuses a pull request number that is not a positive integer", () => {
    expect(() => createReceipt({ pr: 0 })).toThrow(/pr/);
    expect(() => createReceipt({ pr: 1.5 })).toThrow(/pr/);
  });
});

describe("appendAttempt", () => {
  it("appends one attempt and numbers it within its phase", () => {
    const r = receiptWith(
      { phase: "pre-pr", outcome: "pass" },
      { phase: "review-pr", outcome: "fail", reasonCode: "CRITERIA_FAILED" },
      { phase: "review-pr", outcome: "pass", headSha: HEAD_B },
    );
    expect(r.attempts.map((a) => [a.phase, a.n, a.outcome])).toEqual([
      ["pre-pr", 1, "pass"],
      ["review-pr", 1, "fail"],
      ["review-pr", 2, "pass"],
    ]);
    expect(r.attempts[1].reason_code).toBe("CRITERIA_FAILED");
    expect(r.attempts[2].head_sha).toBe(HEAD_B);
  });

  it("never mutates the receipt it was given, so the log is append-only", () => {
    const before = createReceipt({ pr: 7, now: T0 });
    const snapshot = JSON.stringify(before);
    appendAttempt(before, { phase: "pre-pr", outcome: "pass", headSha: HEAD_A, now: T1 });
    expect(JSON.stringify(before)).toBe(snapshot);
  });

  it("moves updated_at and keeps created_at", () => {
    const r = appendAttempt(createReceipt({ pr: 7, now: T0 }), { phase: "pre-pr", outcome: "pass", headSha: HEAD_A, now: T2 });
    expect(r.created_at).toBe(T0.toISOString());
    expect(r.updated_at).toBe(T2.toISOString());
    expect(r.attempts[0].at).toBe(T2.toISOString());
  });

  it("records only what is known: unknown fields stay null, never invented", () => {
    const r = appendAttempt(createReceipt({ pr: 7, now: T0 }), { phase: "pre-pr", outcome: "pass", headSha: HEAD_A, now: T1 });
    const a = r.attempts[0];
    expect(a.merge_base).toBeNull();
    expect(a.base_ref).toBeNull();
    expect(a.reason_code).toBeNull();
    expect(a.requested_model).toBeNull();
    expect(a.tool_version).toBeNull();
    expect(a.evidence).toEqual([]);
  });

  it("keeps the evidence links it is given", () => {
    const url = "https://github.com/o/r/pull/7#issuecomment-1";
    const r = appendAttempt(createReceipt({ pr: 7, now: T0 }), {
      phase: "local-attest",
      outcome: "pass",
      headSha: HEAD_A,
      evidence: [url],
      requestedModel: "sonnet",
      toolVersion: "4.0.0",
      now: T1,
    });
    expect(r.attempts[0].evidence).toEqual([url]);
    expect(r.attempts[0].requested_model).toBe("sonnet");
    expect(r.attempts[0].tool_version).toBe("4.0.0");
  });

  it("refuses a phase the conductor does not declare", () => {
    expect(() => appendAttempt(createReceipt({ pr: 7 }), { phase: "deploy", outcome: "pass", headSha: HEAD_A })).toThrow(/phase/);
  });

  it("refuses an outcome outside the declared set", () => {
    expect(RECEIPT_OUTCOMES).toEqual(["pass", "fail", "blocked", "skipped"]);
    expect(() => appendAttempt(createReceipt({ pr: 7 }), { phase: "pre-pr", outcome: "ok", headSha: HEAD_A })).toThrow(/outcome/);
  });

  it("refuses a head that is not a full SHA", () => {
    expect(() => appendAttempt(createReceipt({ pr: 7 }), { phase: "pre-pr", outcome: "pass", headSha: "abc1234" })).toThrow(/head/);
  });

  it("refuses a reason code that is not an UPPER_SNAKE identifier", () => {
    expect(() =>
      appendAttempt(createReceipt({ pr: 7 }), { phase: "pre-pr", outcome: "fail", headSha: HEAD_A, reasonCode: "rm -rf" }),
    ).toThrow(/reason/);
  });
});

describe("summarizePhases", () => {
  it("counts attempts and consecutive failures since the last pass, per phase", () => {
    const r = receiptWith(
      { phase: "review-pr", outcome: "fail" },
      { phase: "review-pr", outcome: "pass" },
      { phase: "review-pr", outcome: "fail" },
      { phase: "review-pr", outcome: "blocked" },
      { phase: "pre-pr", outcome: "pass" },
    );
    const s = summarizePhases(r);
    expect(s["review-pr"]).toEqual({ attempts: 4, last_outcome: "blocked", consecutive_failures: 2 });
    expect(s["pre-pr"]).toEqual({ attempts: 1, last_outcome: "pass", consecutive_failures: 0 });
  });

  it("does not count a skipped attempt as a failure, and does not let it reset the count", () => {
    const r = receiptWith(
      { phase: "local-attest", outcome: "fail" },
      { phase: "local-attest", outcome: "skipped" },
      { phase: "local-attest", outcome: "fail" },
    );
    expect(summarizePhases(r)["local-attest"].consecutive_failures).toBe(2);
  });

  it("lists phases in conductor order and omits phases never attempted", () => {
    const r = receiptWith({ phase: "local-attest", outcome: "pass" }, { phase: "pre-pr", outcome: "pass" });
    expect(Object.keys(summarizePhases(r))).toEqual(["pre-pr", "local-attest"]);
  });
});

describe("receiptVerdict", () => {
  it("is in-progress for an empty receipt", () => {
    expect(receiptVerdict(createReceipt({ pr: 7 }))).toBe("in-progress");
  });

  it("is blocked while the latest attempt failed or was blocked", () => {
    expect(receiptVerdict(receiptWith({ phase: "pre-pr", outcome: "fail" }))).toBe("blocked");
    expect(receiptVerdict(receiptWith({ phase: "review-pr", outcome: "blocked" }))).toBe("blocked");
  });

  it("is ready only once the stop hand-off passed as the latest attempt", () => {
    expect(receiptVerdict(receiptWith({ phase: "local-attest", outcome: "pass" }))).toBe("in-progress");
    expect(receiptVerdict(receiptWith({ phase: "local-attest", outcome: "pass" }, { phase: "stop", outcome: "pass" }))).toBe(
      "ready",
    );
  });
});

describe("rollbackPoint", () => {
  it("names the base ref and merge base of the latest attempt that knew them", () => {
    const r = receiptWith(
      { phase: "pre-pr", outcome: "pass", mergeBase: BASE, baseRef: "main" },
      { phase: "review-pr", outcome: "pass", mergeBase: null, baseRef: null },
    );
    expect(rollbackPoint(r)).toEqual({ base_ref: "main", merge_base: BASE });
  });

  it("is null when no attempt recorded one", () => {
    expect(rollbackPoint(createReceipt({ pr: 7 }))).toBeNull();
  });
});

describe("receiptProblem", () => {
  it("accepts every receipt appendAttempt produces", () => {
    const r = receiptWith({ phase: "pre-pr", outcome: "pass" }, { phase: "review-pr", outcome: "fail", reasonCode: "X_Y" });
    expect(receiptProblem(r)).toBeNull();
  });

  it("names what is wrong with a hand-edited or foreign file", () => {
    expect(receiptProblem(null)).toMatch(/object/);
    expect(receiptProblem({ ...createReceipt({ pr: 7 }), schema_version: 2 })).toMatch(/schema_version/);
    expect(receiptProblem({ ...createReceipt({ pr: 7 }), attempts: "x" })).toMatch(/attempts/);
    const bad = receiptWith({ phase: "pre-pr", outcome: "pass" });
    bad.attempts[0].outcome = "maybe";
    expect(receiptProblem(bad)).toMatch(/outcome/);
  });
});

describe("receiptPath", () => {
  it("keeps receipts under the git common directory, shared by every worktree", () => {
    expect(receiptPath("/repo/.git", 42)).toBe(path.join("/repo/.git", "dotbabel", "receipts", "pr-42.json"));
  });

  it("refuses a pull request number that could escape the directory", () => {
    expect(() => receiptPath("/repo/.git", "../x")).toThrow(/pr/);
  });
});

describe("frontmatterModel", () => {
  it("reads model from the leading frontmatter block", () => {
    expect(frontmatterModel("---\nid: x\nmodel: sonnet\n---\nbody\n")).toBe("sonnet");
    expect(frontmatterModel('---\nmodel: "opus"\n---\n')).toBe("opus");
  });

  it("is null without a block, without a model line, or for a model line in the body", () => {
    expect(frontmatterModel("no frontmatter\nmodel: opus\n")).toBeNull();
    expect(frontmatterModel("---\nid: x\n---\nmodel: opus\n")).toBeNull();
  });
});

describe("dotbabel.run-receipt.schema.json", () => {
  const schema = JSON.parse(
    readFileSync(path.resolve(import.meta.dirname, "../../../schemas/dotbabel.run-receipt.schema.json"), "utf8"),
  );
  const ajv = new Ajv({ allErrors: true });
  addFormats(ajv);
  const validate = ajv.compile(schema);

  it("validates what appendAttempt emits, so the producer and the schema cannot drift", () => {
    const r = receiptWith(
      { phase: "pre-pr", outcome: "pass" },
      { phase: "review-pr", outcome: "fail", reasonCode: "CRITERIA_FAILED", evidence: ["https://x/1"], requestedModel: "sonnet" },
    );
    expect(validate(r), JSON.stringify(validate.errors)).toBe(true);
  });

  it("lists exactly the conductor phases, so a new phase cannot drift past the schema", () => {
    expect(schema.properties.attempts.items.properties.phase.enum).toEqual(CONDUCTOR_PHASES.map((p) => p.id));
    expect(schema.properties.attempts.items.properties.outcome.enum).toEqual([...RECEIPT_OUTCOMES]);
  });

  it("rejects an unknown outcome", () => {
    const r = receiptWith({ phase: "pre-pr", outcome: "pass" });
    r.attempts[0].outcome = "maybe";
    expect(validate(r)).toBe(false);
  });
});

describe("module purity", () => {
  it("run-receipt.mjs performs no I/O", () => {
    const src = readFileSync(path.resolve(import.meta.dirname, "..", "src", "run-receipt.mjs"), "utf8");
    expect(src).not.toMatch(/node:child_process|node:fs|node:os|node:process/);
  });
});
