// Round-trip tests for encodeDescription. It shells out to
// scripts/handoff-description.sh so the test exercises both the JS wrapper
// and the shell encoder.
//
// Schema: handoff:v1:<cli>:<short-uuid>:<project-slug>:<hostname>[:<tag>]

import { describe, it, expect } from "vitest";
import { encodeDescription } from "../bin/dotclaude-handoff.mjs";

function parse(encoded) {
  const [prefix, version, cli, shortId, project, host, tag] = encoded.split(":");
  return { prefix, version, cli, shortId, project, host, tag };
}

describe("encodeDescription", () => {
  it("produces a 6-segment string when no tag is supplied", () => {
    const s = encodeDescription({
      cli: "claude",
      shortId: "abcd1234",
      project: "my-app",
      host: "laptop",
    });
    expect(s.split(":")).toHaveLength(6);
    const p = parse(s);
    expect(p.prefix).toBe("handoff");
    expect(p.version).toBe("v1");
    expect(p.cli).toBe("claude");
    expect(p.shortId).toBe("abcd1234");
    expect(p.project).toBe("my-app");
    expect(p.host).toBe("laptop");
    expect(p.tag).toBeUndefined();
  });

  it("appends the tag segment when provided", () => {
    const s = encodeDescription({
      cli: "copilot",
      shortId: "12345678",
      project: "my-app",
      host: "laptop",
      tag: "wip-refactor",
    });
    expect(s.split(":")).toHaveLength(7);
    expect(parse(s).tag).toBe("wip-refactor");
  });

  it("normalises uppercase and special characters in project/host/tag slugs", () => {
    const s = encodeDescription({
      cli: "codex",
      shortId: "deadbeef",
      project: "My Project!",
      host: "My.Laptop",
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
    });
    expect(parse(s).project).toBe("adhoc");
  });

  it("substitutes 'unknown' for empty host", () => {
    const s = encodeDescription({
      cli: "claude",
      shortId: "abcd1234",
      project: "my-app",
      host: "",
    });
    expect(parse(s).host).toBe("unknown");
  });
});
