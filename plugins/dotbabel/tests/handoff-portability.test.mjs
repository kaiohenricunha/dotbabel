// Portability / boundary unit tests that need a real filesystem
// (symlinks) or cover edges not exercised by handoff-unit.test.mjs.

import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  collectSessionFiles,
  projectSlugFromCwd,
  UUID_HEAD_RE,
} from "../bin/dotbabel-handoff.mjs";

describe("collectSessionFiles (symlink safety)", () => {
  it("does not recurse into a symlink that points back up the walk", () => {
    // `readdirSync(..., { withFileTypes:true })` returns Dirents where
    // symlinks report isDirectory()=false, so the walker skips them
    // entirely rather than following or loop-detecting them. Pin that
    // the walk terminates and the leaf file appears exactly once.
    const root = mkdtempSync(join(tmpdir(), "handoff-symlink-"));
    try {
      const leaf = join(root, "leaf");
      mkdirSync(leaf);
      writeFileSync(join(leaf, "session.jsonl"), "{}\n");
      symlinkSync(root, join(leaf, "loop"));

      const files = collectSessionFiles(root, 2, (name) => name.endsWith(".jsonl"));
      expect(files.length).toBe(1);
      expect(files[0]).toContain("session.jsonl");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("projectSlugFromCwd (trailing-separator edge)", () => {
  it("strips a trailing '-' produced by sanitising punctuation", () => {
    // v0.10.0 tightened the JS slugify to match the shell slugify in
    // handoff-description.sh — collapse runs of '-' and trim leading /
    // trailing '-'. A cwd ending in punctuation therefore yields a
    // clean "my-weird-project" rather than "my-weird-project-".
    expect(projectSlugFromCwd("/tmp/My Weird Project!!")).toBe("my-weird-project");
  });
});

describe("UUID_HEAD_RE (truncated input)", () => {
  it("does not match when the first group is only 7 hex", () => {
    // 8-hex head is the shortest recognised form. Guards against a
    // pattern-loosening refactor that would let 7-hex prefixes through.
    expect("aaaa111-1111-1111-1111-111111111111".match(UUID_HEAD_RE)).toBeNull();
  });
});
