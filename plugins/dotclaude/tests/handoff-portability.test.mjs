// Portability / boundary unit tests — filesystem edge cases and input
// shapes that are awkward to exercise from bats.
//
// Covered:
//   - collectSessionFiles: bounded depth, does not follow symlinks that
//     loop back to the walk root (would otherwise re-enumerate forever)
//   - projectSlugFromCwd: ≤40-char output even for near-PATH_MAX inputs
//   - UUID_HEAD_RE: returns the *first* UUID when multiple are present
//     in the input (documented first-match behavior).

import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  collectSessionFiles,
  projectSlugFromCwd,
  UUID_HEAD_RE,
} from "../bin/dotclaude-handoff.mjs";

describe("collectSessionFiles (symlink safety)", () => {
  it("does not recurse into a symlink that points back up the walk", () => {
    // The session-tree walkers cap recursion at a hard depth (walk=1 for
    // claude, walk=3 for codex). A self-referential symlink is harmless
    // under that cap IF the walker uses `isDirectory()` (which follows
    // symlinks) rather than tracking real paths. This test pins that the
    // walk terminates and — crucially — does not enumerate the same
    // files twice (which would happen on any path that followed the loop).
    const root = mkdtempSync(join(tmpdir(), "handoff-symlink-"));
    try {
      const leaf = join(root, "leaf");
      mkdirSync(leaf);
      writeFileSync(join(leaf, "session.jsonl"), "{}\n");
      // Symlink back to root — classic infinite-loop bait.
      symlinkSync(root, join(leaf, "loop"));

      const files = collectSessionFiles(root, 2, (name) => name.endsWith(".jsonl"));
      // Exactly one real file. If the walker followed the loop, the
      // same file would appear more than once.
      expect(files.length).toBe(1);
      expect(files[0]).toContain("session.jsonl");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("projectSlugFromCwd (boundary inputs)", () => {
  it("caps output at 40 chars for a near-PATH_MAX cwd", () => {
    // Simulate a deeply nested cwd with a very long final segment. The
    // function's contract is a ≤40-char lowercased slug.
    const deep = "/" + "x".repeat(4000);
    const slug = projectSlugFromCwd(deep);
    expect(slug.length).toBeLessThanOrEqual(40);
    // All "x" chars survive the sanitizer — lowercase alnum is preserved.
    expect(slug).toMatch(/^x+$/);
  });

  it("sanitises non-alnum characters and folds case", () => {
    // Final segment has uppercase, spaces, and punctuation. Runs of
    // non-[a-z0-9-] fold to a single "-"; the sanitizer does not trim
    // trailing separators (documented side-effect of slice-at-40).
    const slug = projectSlugFromCwd("/tmp/My Weird Project!!");
    expect(slug).toBe("my-weird-project-");
  });
});

describe("UUID_HEAD_RE (first-match behavior)", () => {
  it("returns the head of the first UUID when a path has multiple", () => {
    // Codex rollout paths contain exactly one UUID, but list/describe
    // paths could theoretically concatenate multiple. The regex must
    // pick the earliest — tooling on top of this (e.g. dedup) relies
    // on "first UUID" being the origin marker.
    const input =
      "/foo/aaaa1111-1111-1111-1111-111111111111/bar/bbbb2222-2222-2222-2222-222222222222/baz";
    const m = input.match(UUID_HEAD_RE);
    expect(m?.[1]).toBe("aaaa1111");
  });

  it("matches a UUID at the start of a string", () => {
    const m = "aaaa1111-1111-1111-1111-111111111111.jsonl".match(UUID_HEAD_RE);
    expect(m?.[1]).toBe("aaaa1111");
  });

  it("does not match a truncated UUID (only 7 hex in head)", () => {
    // Short-UUID shape is 8 hex; anything shorter should not match the
    // full 5-group pattern.
    expect("aaaa111-1111-1111-1111-111111111111".match(UUID_HEAD_RE)).toBeNull();
  });
});
