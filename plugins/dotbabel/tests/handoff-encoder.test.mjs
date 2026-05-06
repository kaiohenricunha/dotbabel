// Round-trip tests for encodeDescription. It shells out to
// scripts/handoff-description.sh so the test exercises both the JS wrapper
// and the shell encoder.
//
// Schema (v0.10.0+):
//   handoff:v2:<project>:<cli>:<YYYY-MM>:<short>:<host>[:<tag>]

import { describe, it, expect } from "vitest";
import { encodeDescription } from "../bin/dotclaude-handoff.mjs";

// Parse a v2 description back into named segments. Matches the segment
// order defined in handoff-description.sh's encode path.
function parse(encoded) {
  const [prefix, version, project, cli, month, shortId, host, tag] = encoded.split(":");
  return { prefix, version, project, cli, month, shortId, host, tag };
}

describe("encodeDescription (v2)", () => {
  it("produces a 7-segment string when no tag is supplied", () => {
    const s = encodeDescription({
      cli: "claude",
      shortId: "abcd1234",
      project: "my-app",
      host: "laptop",
      month: "2026-04",
    });
    expect(s.split(":")).toHaveLength(7);
    const p = parse(s);
    expect(p.prefix).toBe("handoff");
    expect(p.version).toBe("v2");
    expect(p.project).toBe("my-app");
    expect(p.cli).toBe("claude");
    expect(p.month).toBe("2026-04");
    expect(p.shortId).toBe("abcd1234");
    expect(p.host).toBe("laptop");
    expect(p.tag).toBeUndefined();
  });

  it("appends the tag segment when provided", () => {
    const s = encodeDescription({
      cli: "copilot",
      shortId: "12345678",
      project: "my-app",
      host: "laptop",
      month: "2026-04",
      tag: "wip-refactor",
    });
    expect(s.split(":")).toHaveLength(8);
    expect(parse(s).tag).toBe("wip-refactor");
  });

  it("normalises uppercase and special characters in project/host/tag slugs", () => {
    const s = encodeDescription({
      cli: "codex",
      shortId: "deadbeef",
      project: "My Project!",
      host: "My.Laptop",
      month: "2026-04",
      tag: "V2 Feature",
    });
    const p = parse(s);
    expect(p.project).toBe("my-project");
    expect(p.host).toBe("my-laptop");
    expect(p.tag).toBe("v2-feature");
  });

  it("substitutes 'adhoc' for empty project", () => {
    const s = encodeDescription({
      cli: "claude",
      shortId: "abcd1234",
      project: "",
      host: "laptop",
      month: "2026-04",
    });
    expect(parse(s).project).toBe("adhoc");
  });

  it("substitutes 'unknown' for empty host", () => {
    const s = encodeDescription({
      cli: "claude",
      shortId: "abcd1234",
      project: "my-app",
      host: "",
      month: "2026-04",
    });
    expect(parse(s).host).toBe("unknown");
  });
});
