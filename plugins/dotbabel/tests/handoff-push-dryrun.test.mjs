// Unit coverage for Gap 4 (#91): `push --dry-run`.
//
// Most of the dry-run path is exercised end-to-end by handoff-push-dryrun.bats
// (real session fixture, real bare transport repo, real scrub). Here we lock
// down the library-level contract for pushRemote({ dryRun: true }) against
// a mocked subprocess layer so the return shape can't drift silently.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("node:child_process", () => ({
  spawnSync: vi.fn(),
}));
vi.mock("node:fs", () => ({
  existsSync: vi.fn().mockReturnValue(false),
  mkdirSync: vi.fn(),
  mkdtempSync: vi.fn().mockReturnValue("/tmp/mock-dir"),
  readFileSync: vi.fn().mockReturnValue(""),
  renameSync: vi.fn(),
  rmSync: vi.fn(),
  unlinkSync: vi.fn(),
  writeFileSync: vi.fn(),
}));
vi.mock("node:readline", () => ({
  createInterface: vi.fn(),
}));

import { spawnSync } from "node:child_process";
import * as lib from "../src/lib/handoff-remote.mjs";
import { HandoffError } from "../src/lib/handoff-errors.mjs";

// Queue ordered spawnSync returns for a full dry-run: requireTransportRepo
// validates the URL locally (no spawn); then extractMeta, extractPrompts,
// extractTurns, scrubDigest, encodeDescription (projectSlugFromCwd's
// git rev-parse is a no-op since meta.cwd is null here).
function queueDryRunSpawns({ sessionId = "abc12345-aaaa-bbbb-cccc-000000000001" } = {}) {
  const meta = {
    cli: "claude",
    session_id: sessionId,
    short_id: sessionId.slice(0, 8),
    cwd: null,
    customTitle: null,
    thread_name: null,
  };
  spawnSync
    // extractMeta — handoff-extract.sh meta
    .mockReturnValueOnce({ status: 0, stdout: JSON.stringify(meta), stderr: "" })
    // extractPrompts — handoff-extract.sh prompts
    .mockReturnValueOnce({ status: 0, stdout: '"hi"\n', stderr: "" })
    // extractTurns — handoff-extract.sh turns
    .mockReturnValueOnce({ status: 0, stdout: '"hello"\n', stderr: "" })
    // scrubDigest — handoff-scrub.sh (stdout = scrubbed body; stderr line ends with "scrubbed:0")
    .mockReturnValueOnce({ status: 0, stdout: "scrubbed body\n", stderr: "scrubbed:0\n" })
    // encodeDescription — handoff-description.sh encode
    .mockReturnValueOnce({ status: 0, stdout: "handoff:v2:claude:abc12345\n", stderr: "" });
}

describe("pushRemote({ dryRun: true })", () => {
  let origRepo;
  beforeEach(() => {
    origRepo = process.env.DOTCLAUDE_HANDOFF_REPO;
    spawnSync.mockReset();
  });
  afterEach(() => {
    if (origRepo === undefined) delete process.env.DOTCLAUDE_HANDOFF_REPO;
    else process.env.DOTCLAUDE_HANDOFF_REPO = origRepo;
  });

  it("returns the dry-run result shape without any git push", async () => {
    process.env.DOTCLAUDE_HANDOFF_REPO = "git@example.com:me/store.git";
    queueDryRunSpawns();

    const result = await lib.pushRemote({
      cli: "claude",
      path: "/fake/session.jsonl",
      tag: null,
      dryRun: true,
    });

    expect(result.dryRun).toBe(true);
    expect(result.url).toBe("git@example.com:me/store.git");
    // meta.cwd is null → projectSlugFromCwd returns "adhoc" deterministically.
    expect(result.branch).toMatch(/^handoff\/adhoc\/claude\/\d{4}-\d{2}\/abc12345$/);
    expect(result.scrubbedCount).toBe(0);
    expect(result.digestBytes).toBeGreaterThan(0);
    expect(result.metadata.cli).toBe("claude");
    expect(result.metadata.short_id).toBe("abc12345");

    // No git invocation with a "push" verb — the library skipped doPush.
    const pushCalls = spawnSync.mock.calls.filter(
      (c) => c[0] === "git" && Array.isArray(c[1]) && c[1].includes("push"),
    );
    expect(pushCalls).toHaveLength(0);
  });

  it("throws HandoffError (stage=preflight) when DOTCLAUDE_HANDOFF_REPO is unset", async () => {
    delete process.env.DOTCLAUDE_HANDOFF_REPO;

    await expect(
      lib.pushRemote({ cli: "claude", path: "/fake/session.jsonl", dryRun: true }),
    ).rejects.toThrow(HandoffError);

    // No subprocess should have been spawned — strict env check happened first.
    expect(spawnSync).not.toHaveBeenCalled();
  });
});
