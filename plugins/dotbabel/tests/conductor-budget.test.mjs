import { describe, it, expect } from "vitest";

import {
  CONDUCTOR_PHASES,
  DEFAULT_MAX_ATTEMPTS,
  MAX_ATTEMPTS_CEILING,
  checkAttemptBudget,
  resolveMaxAttempts,
} from "../src/pr-gates.mjs";

describe("resolveMaxAttempts", () => {
  it("defaults to 3 when the repository sets nothing", () => {
    expect(DEFAULT_MAX_ATTEMPTS).toBe(3);
    expect(resolveMaxAttempts(undefined, "review-pr")).toBe(3);
    expect(resolveMaxAttempts({}, "review-pr")).toBe(3);
    expect(resolveMaxAttempts({ conductor: {} }, "review-pr")).toBe(3);
  });

  it("uses the repository-wide cap, and a per-phase override before it", () => {
    const config = { conductor: { max_attempts: 2, phase_max_attempts: { "local-attest": 1 } } };
    expect(resolveMaxAttempts(config, "review-pr")).toBe(2);
    expect(resolveMaxAttempts(config, "local-attest")).toBe(1);
  });

  it("throws on a value the schema rejects rather than silently using the default", () => {
    expect(() => resolveMaxAttempts({ conductor: { max_attempts: 0 } }, "pre-pr")).toThrow(/max_attempts/);
    expect(() => resolveMaxAttempts({ conductor: { max_attempts: "3" } }, "pre-pr")).toThrow(/max_attempts/);
    expect(() => resolveMaxAttempts({ conductor: { phase_max_attempts: { "pre-pr": -1 } } }, "pre-pr")).toThrow(/pre-pr/);
  });

  it("throws on a misspelled key or a block of the wrong shape, rather than using the default", () => {
    for (const config of [
      { conductor: { max_attempt: 1 } },
      { conductor: { phase_max_attempts: { localattest: 1 } } },
      { conductor: 3 },
      { conductor: null },
      { conductor: [] },
      { conductor: { phase_max_attempts: 5 } },
      { conductor: { phase_max_attempts: [] } },
    ]) {
      expect(() => resolveMaxAttempts(config, "local-attest"), JSON.stringify(config)).toThrow(/conductor/);
    }
  });

  it("caps the cap, so one edit cannot make the budget unlimited", () => {
    expect(MAX_ATTEMPTS_CEILING).toBe(10);
    expect(resolveMaxAttempts({ conductor: { max_attempts: 10 } }, "pre-pr")).toBe(10);
    expect(() => resolveMaxAttempts({ conductor: { max_attempts: 11 } }, "pre-pr")).toThrow(/10/);
    expect(() => resolveMaxAttempts({ conductor: { phase_max_attempts: { "pre-pr": 9007199254740991 } } }, "pre-pr")).toThrow(/10/);
  });

  it("throws on an unknown phase", () => {
    expect(() => resolveMaxAttempts({}, "deploy")).toThrow(/phase/);
  });
});

describe("checkAttemptBudget", () => {
  it("passes while consecutive failures are below the cap", () => {
    const r = checkAttemptBudget({ phase: "review-pr", consecutiveFailures: 2, maxAttempts: 3 });
    expect(r).toMatchObject({ ok: true, gate: "budget", reasons: [], warnings: [], hint: null });
    expect(r.remaining).toBe(1);
  });

  it("passes for a phase never attempted", () => {
    expect(checkAttemptBudget({ phase: "pre-pr", consecutiveFailures: 0, maxAttempts: 1 }).ok).toBe(true);
  });

  it("fails at the cap with CONDUCTOR_BUDGET_EXHAUSTED and an escalation hint", () => {
    const r = checkAttemptBudget({ phase: "review-pr", consecutiveFailures: 3, maxAttempts: 3 });
    expect(r.ok).toBe(false);
    expect(r.remaining).toBe(0);
    expect(r.reasons).toEqual([
      expect.objectContaining({ code: "CONDUCTOR_BUDGET_EXHAUSTED", message: expect.stringMatching(/review-pr.*3.*3/) }),
    ]);
    expect(r.hint).toMatch(/user/);
  });

  it("fails above the cap too, so a lowered cap still stops a long run", () => {
    expect(checkAttemptBudget({ phase: "pre-pr", consecutiveFailures: 5, maxAttempts: 2 }).ok).toBe(false);
  });

  it("refuses inputs that are not counts, rather than passing them", () => {
    expect(() => checkAttemptBudget({ phase: "pre-pr", consecutiveFailures: -1, maxAttempts: 3 })).toThrow();
    expect(() => checkAttemptBudget({ phase: "pre-pr", consecutiveFailures: 0, maxAttempts: 0 })).toThrow();
    expect(() => checkAttemptBudget({ phase: "nope", consecutiveFailures: 0, maxAttempts: 3 })).toThrow(/phase/);
  });

  it("covers every conductor phase", () => {
    for (const { id } of CONDUCTOR_PHASES) {
      expect(checkAttemptBudget({ phase: id, consecutiveFailures: 0, maxAttempts: 1 }).ok).toBe(true);
    }
  });
});

describe("dotbabel.config.schema.json conductor block", () => {
  it("lists exactly the conductor phases as override keys", async () => {
    const { readFileSync } = await import("node:fs");
    const path = await import("node:path");
    const schema = JSON.parse(
      readFileSync(path.resolve(import.meta.dirname, "../../../schemas/dotbabel.config.schema.json"), "utf8"),
    );
    expect(schema.properties.conductor.properties.phase_max_attempts.propertyNames.enum).toEqual(
      CONDUCTOR_PHASES.map((p) => p.id),
    );
    expect(schema.properties.conductor.properties.max_attempts.default).toBe(DEFAULT_MAX_ATTEMPTS);
    expect(schema.properties.conductor.properties.max_attempts.maximum).toBe(MAX_ATTEMPTS_CEILING);
    expect(schema.properties.conductor.properties.phase_max_attempts.additionalProperties.maximum).toBe(MAX_ATTEMPTS_CEILING);
  });
});
