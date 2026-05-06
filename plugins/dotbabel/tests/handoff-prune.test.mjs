// Unit tests for handoff prune (#91 Gap 5).
// Coverage of the pure helper `parseDuration`. The end-to-end behavior
// (listPruneCandidates, deleteRemoteBranches, dispatch) is exercised by
// handoff-prune.bats with a real bare transport repo.

import { describe, it, expect } from "vitest";
import { parseDuration } from "../src/lib/handoff-remote.mjs";

const DAY_MS = 24 * 60 * 60 * 1000;

describe("parseDuration", () => {
  it("treats Nd as N days back from now", () => {
    const before = Date.now();
    const got = parseDuration("30d");
    const after = Date.now();
    expect(got).toBeGreaterThanOrEqual(before - 30 * DAY_MS);
    expect(got).toBeLessThanOrEqual(after - 30 * DAY_MS);
  });

  it("treats Nm as N*30 days back (documented approximation)", () => {
    const got = parseDuration("6m");
    const expected = Date.now() - 180 * DAY_MS;
    expect(Math.abs(got - expected)).toBeLessThan(1000);
  });

  it("treats Ny as N*365 days back", () => {
    const got = parseDuration("1y");
    const expected = Date.now() - 365 * DAY_MS;
    expect(Math.abs(got - expected)).toBeLessThan(1000);
  });

  it("treats YYYY-MM-DD as midnight UTC of that date", () => {
    expect(parseDuration("2026-01-01")).toBe(Date.parse("2026-01-01T00:00:00Z"));
  });

  it("0d returns now (delete everything older than now)", () => {
    const before = Date.now();
    const got = parseDuration("0d");
    const after = Date.now();
    expect(got).toBeGreaterThanOrEqual(before);
    expect(got).toBeLessThanOrEqual(after);
  });

  it("throws on garbage", () => {
    expect(() => parseDuration("garbage")).toThrow();
  });

  it("throws on empty string", () => {
    expect(() => parseDuration("")).toThrow();
  });

  it("throws on null/undefined", () => {
    expect(() => parseDuration(null)).toThrow();
    expect(() => parseDuration(undefined)).toThrow();
  });

  it("rejects negative durations", () => {
    expect(() => parseDuration("-5d")).toThrow();
  });

  it("rejects zero with bad unit", () => {
    expect(() => parseDuration("5x")).toThrow();
  });
});
