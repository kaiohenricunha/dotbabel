// Boundary tests for `lib/attest-marker.mjs`, the shared marker factory behind
// the local-attest, criteria, and review-evidence comments. Its behavior was
// only reached through callers, which left the TEST-1 mutation score at 83.53%
// (#390). These tests pin each guard directly.
//
// Four mutants are equivalent and are not chased:
//   - 51:37 (`typeof headSha !== "string"` forced false), 51:68
//     (`headSha === ""` forced false), and 51:80 (`""` changed): `build`
//     re-checks both conditions and throws, and `isAttested` catches that
//     throw and returns false, so the early return only saves work.
//   - 57:13 (the `catch` block emptied): `marker` stays undefined, and no
//     comment's first line can equal undefined, so the result is still false.
import { describe, expect, it } from "vitest";

import { createMarker } from "../src/lib/attest-marker.mjs";

const PREFIX = "<!-- test-marker verified-sha=";
const SHA = "abc1234";
const marker = createMarker(PREFIX);

describe("createMarker build", () => {
  it("builds the marker for a short and a full SHA", () => {
    expect(marker.build(SHA)).toBe(`${PREFIX}${SHA} -->`);
    expect(marker.build("A".repeat(40))).toBe(`${PREFIX}${"A".repeat(40)} -->`);
  });

  it("rejects a value with non-hex characters before or after the SHA", () => {
    expect(() => marker.build(`zz${SHA}`)).toThrow("invalid sha");
    expect(() => marker.build(`${SHA}zz`)).toThrow("invalid sha");
  });

  it("rejects a SHA shorter than 7 or longer than 40 characters", () => {
    expect(() => marker.build("abc123")).toThrow("invalid sha");
    expect(() => marker.build("a".repeat(41))).toThrow("invalid sha");
  });

  it("rejects a number even when its digits look like a SHA", () => {
    expect(() => marker.build(1234567)).toThrow("invalid sha: 1234567");
  });
});

describe("createMarker isAttested", () => {
  const owner = (body) => ({ author_association: "OWNER", body });

  it("accepts a trusted comment whose first line is the marker", () => {
    expect(marker.isAttested([owner(`${PREFIX}${SHA} -->\nbody`)], SHA)).toBe(true);
  });

  it("returns false for a non-array comment list without throwing", () => {
    expect(marker.isAttested({}, SHA)).toBe(false);
    expect(marker.isAttested("comments", SHA)).toBe(false);
  });

  it("returns false for a head SHA that is not a SHA", () => {
    expect(marker.isAttested([owner(`${PREFIX}not-a-sha -->`)], "not-a-sha")).toBe(false);
  });

  it("skips a comment with a non-string body without throwing", () => {
    expect(marker.isAttested([owner(42), owner(`${PREFIX}${SHA} -->`)], SHA)).toBe(true);
    expect(marker.isAttested([owner(42)], SHA)).toBe(false);
  });
});

describe("createMarker find", () => {
  it("skips null entries and non-string bodies to reach the marker comment", () => {
    const hit = { body: `quoted ${PREFIX}${SHA} -->` };
    expect(marker.find([null, { body: 5 }, { body: "unrelated" }, hit])).toBe(hit);
  });

  it("returns null when no comment carries the prefix", () => {
    expect(marker.find([null, { body: 5 }, { body: "unrelated" }])).toBeNull();
    expect(marker.find("not-an-array")).toBeNull();
  });
});

describe("createMarker parseSha", () => {
  it("returns the SHA from a first-line marker", () => {
    expect(marker.parseSha(`${PREFIX}${SHA} -->\nrest`)).toBe(SHA);
  });

  it("trims whitespace around the SHA", () => {
    expect(marker.parseSha(`${PREFIX} ${SHA} -->`)).toBe(SHA);
  });

  it("returns null when the marker line has no closing -->", () => {
    expect(marker.parseSha(`${PREFIX}abcdef1234567`)).toBeNull();
  });

  it("returns null for a non-string body or a marker after line 1", () => {
    expect(marker.parseSha(undefined)).toBeNull();
    expect(marker.parseSha(`intro\n${PREFIX}${SHA} -->`)).toBeNull();
  });
});
