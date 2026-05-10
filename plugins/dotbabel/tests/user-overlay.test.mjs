import { describe, it, expect, afterEach } from "vitest";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import {
  USER_OVERLAY_BEGIN,
  USER_OVERLAY_END,
  NO_OVERLAY_PLACEHOLDER,
  composeUserScopeClaudeMd,
  resolveLocalRulesPath,
} from "../src/lib/user-overlay.mjs";

let tmpDirs = [];

function makeTmpDir(prefix = "user-overlay-test-") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  tmpDirs = [];
});

const CANONICAL = `# CLAUDE.md — Global Claude Code Rules

> Sample canonical content.

## Some heading

- bullet
- another bullet
`;

describe("composeUserScopeClaudeMd", () => {
  it("appends overlay block with content when overlay arg is non-null", () => {
    const overlay = "## Local rules\n\n- be terse\n- be helpful";
    const out = composeUserScopeClaudeMd(CANONICAL, overlay);
    // Canonical content present verbatim
    expect(out).toContain("# CLAUDE.md — Global Claude Code Rules");
    expect(out).toContain("Sample canonical content.");
    // User-overlay block present with content
    expect(out).toContain(USER_OVERLAY_BEGIN);
    expect(out).toContain(USER_OVERLAY_END);
    expect(out).toContain("- be terse");
    expect(out).toContain("- be helpful");
    // Overlay sits AFTER canonical (not before)
    const canonicalIdx = out.indexOf("Sample canonical content.");
    const overlayIdx = out.indexOf(USER_OVERLAY_BEGIN);
    expect(overlayIdx).toBeGreaterThan(canonicalIdx);
    // Placeholder must NOT appear when real content is provided
    expect(out).not.toContain(NO_OVERLAY_PLACEHOLDER);
  });

  it('appends "(no user overlay)" placeholder when overlay arg is null', () => {
    const out = composeUserScopeClaudeMd(CANONICAL, null);
    expect(out).toContain(USER_OVERLAY_BEGIN);
    expect(out).toContain(USER_OVERLAY_END);
    expect(out).toContain(NO_OVERLAY_PLACEHOLDER);
  });

  it('appends "(no user overlay)" placeholder when overlay is empty or whitespace-only', () => {
    const outEmpty = composeUserScopeClaudeMd(CANONICAL, "");
    const outWhitespace = composeUserScopeClaudeMd(CANONICAL, "   \n\n  \t\n");
    expect(outEmpty).toContain(NO_OVERLAY_PLACEHOLDER);
    expect(outWhitespace).toContain(NO_OVERLAY_PLACEHOLDER);
    // All three "no real overlay" states render IDENTICALLY
    const outNull = composeUserScopeClaudeMd(CANONICAL, null);
    expect(outEmpty).toBe(outNull);
    expect(outWhitespace).toBe(outNull);
  });

  it("output ends with exactly one trailing newline; idempotent on re-compose", () => {
    const overlay = "- be terse";
    const out1 = composeUserScopeClaudeMd(CANONICAL, overlay);
    // Exactly one trailing newline
    expect(out1.endsWith("\n")).toBe(true);
    expect(out1.endsWith("\n\n")).toBe(false);
    // Idempotence: composing with the same inputs is byte-identical
    const out2 = composeUserScopeClaudeMd(CANONICAL, overlay);
    expect(out1).toBe(out2);
    // Even when re-composed from a slightly-mangled overlay (extra newlines
    // around the same content) — the trim normalization should produce the
    // same output.
    const out3 = composeUserScopeClaudeMd(CANONICAL, `\n\n${overlay}\n\n`);
    expect(out3).toBe(out1);
  });
});

describe("resolveLocalRulesPath", () => {
  it("honors DOTBABEL_LOCAL_RULES env override", () => {
    const env = {
      DOTBABEL_LOCAL_RULES: "/custom/path/to/local-rules.md",
      HOME: "/home/test",
    };
    expect(resolveLocalRulesPath(env)).toBe("/custom/path/to/local-rules.md");
  });

  it("honors XDG_CONFIG_HOME", () => {
    const env = {
      XDG_CONFIG_HOME: "/custom/xdg/config",
      HOME: "/home/test",
    };
    expect(resolveLocalRulesPath(env)).toBe(
      "/custom/xdg/config/dotbabel/local-rules.md",
    );
  });

  it("defaults to ~/.config/dotbabel/local-rules.md when neither override is set", () => {
    const env = { HOME: "/home/test" };
    expect(resolveLocalRulesPath(env)).toBe(
      "/home/test/.config/dotbabel/local-rules.md",
    );
  });
});
