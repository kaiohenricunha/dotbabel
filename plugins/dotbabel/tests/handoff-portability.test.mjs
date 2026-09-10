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

describe("collectSessionFiles (symlinks)", () => {
  it("terminates on a symlink loop and yields the leaf exactly once", () => {
    // The walker follows symlinked directories (#329), so a link pointing back
    // up the walk would recurse forever. Termination comes from a set of
    // realpaths already visited, not from refusing to follow.
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

  it("follows a symlinked directory nested inside the root", () => {
    // #329: a project directory redirected to another volume. A Dirent reports
    // a symlink as neither file nor directory, so without a follow-through stat
    // the whole subtree is invisible — `list` then omits sessions that exist.
    const root = mkdtempSync(join(tmpdir(), "handoff-symlink-"));
    try {
      const real = join(root, "real");
      mkdirSync(real);
      writeFileSync(join(real, "session.jsonl"), "{}\n");
      mkdirSync(join(root, "walk"));
      symlinkSync(real, join(root, "walk", "linked"));

      const files = collectSessionFiles(join(root, "walk"), 2, (name) => name.endsWith(".jsonl"));
      expect(files.length).toBe(1);
      // The caller-visible path, not the realpath — cliFromPath tags a session
      // by matching "/.codex/sessions/" and friends against this string.
      expect(files[0]).toContain(join("walk", "linked"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("finds a symlinked session file", () => {
    const root = mkdtempSync(join(tmpdir(), "handoff-symlink-"));
    try {
      writeFileSync(join(root, "target.jsonl"), "{}\n");
      mkdirSync(join(root, "walk"));
      symlinkSync(join(root, "target.jsonl"), join(root, "walk", "session.jsonl"));

      const files = collectSessionFiles(join(root, "walk"), 2, (name) => name.endsWith(".jsonl"));
      expect(files).toHaveLength(1);
      expect(files[0]).toContain("session.jsonl");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("lists a session file reachable under two names only once", () => {
    // Following symlinks means one file can be reached by its real name and by
    // a link beside it. Without identity dedup `handoff list` renders the same
    // session twice, under two different short ids derived from the two paths.
    const root = mkdtempSync(join(tmpdir(), "handoff-symlink-"));
    try {
      mkdirSync(join(root, "proj"));
      writeFileSync(join(root, "proj", "a.jsonl"), "{}\n");
      symlinkSync(join(root, "proj", "a.jsonl"), join(root, "proj", "latest.jsonl"));

      const files = collectSessionFiles(root, 1, (name) => name.endsWith(".jsonl"));
      expect(files).toHaveLength(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("skips a dangling symlink instead of throwing", () => {
    const root = mkdtempSync(join(tmpdir(), "handoff-symlink-"));
    try {
      writeFileSync(join(root, "session.jsonl"), "{}\n");
      symlinkSync(join(root, "gone"), join(root, "dangling.jsonl"));
      symlinkSync(join(root, "gone-dir"), join(root, "dangling-dir"));

      const files = collectSessionFiles(root, 2, (name) => name.endsWith(".jsonl"));
      expect(files).toHaveLength(1);
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
