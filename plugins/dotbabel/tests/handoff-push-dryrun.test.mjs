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
import { HandoffError, classifyGitError } from "../src/lib/handoff-errors.mjs";
import { SCRUB_ERROR_PREFIX } from "../src/lib/handoff-scrub.mjs";

// Queue ordered spawnSync returns for a full dry-run: requireTransportRepo
// validates the URL locally (no spawn); then extractMeta, extractPrompts,
// extractTurns, scrubDigest, encodeDescription (projectSlugFromCwd's
// git rev-parse is a no-op since meta.cwd is null here).
//
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
    // extractTodos — handoff-extract.sh todos (claude only; non-claude
    // shortcuts to [] without spawning, see extractTodos export).
    .mockReturnValueOnce({ status: 0, stdout: "", stderr: "" })
    // extractMirror is codex-only and shortcuts to [] for claude — no spawn here.
    // scrubDigest — handoff-scrub.sh (stdout = scrubbed body; stderr line ends with "scrubbed:0")
    .mockReturnValueOnce({ status: 0, stdout: "scrubbed body\n", stderr: "scrubbed:0\n" })
    // encodeDescription — handoff-description.sh encode
    .mockReturnValueOnce({ status: 0, stdout: "handoff:v2:claude:abc12345\n", stderr: "" });
}

describe("pushRemote({ dryRun: true })", () => {
  let origRepo;
  beforeEach(() => {
    origRepo = process.env.DOTBABEL_HANDOFF_REPO;
    spawnSync.mockReset();
  });
  afterEach(() => {
    if (origRepo === undefined) delete process.env.DOTBABEL_HANDOFF_REPO;
    else process.env.DOTBABEL_HANDOFF_REPO = origRepo;
  });

  it("returns the dry-run result shape without any git push", async () => {
    process.env.DOTBABEL_HANDOFF_REPO = "git@example.com:me/store.git";
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

  it("throws HandoffError (stage=preflight) when DOTBABEL_HANDOFF_REPO is unset", async () => {
    delete process.env.DOTBABEL_HANDOFF_REPO;

    await expect(
      lib.pushRemote({ cli: "claude", path: "/fake/session.jsonl", dryRun: true }),
    ).rejects.toThrow(HandoffError);

    // No subprocess should have been spawned — strict env check happened first.
    expect(spawnSync).not.toHaveBeenCalled();
  });
});

// The fail-closed baseline: if the scrubber cannot run, the push must abort
// before anything reaches the remote. This lived in handoff-scrub-push.bats,
// where the only way to make the scrubber unavailable was renaming the real
// script inside the repo — a shared-file mutation that broke every test
// running concurrently and blocked `bats -j`. The subprocess boundary is
// already mocked here, so the same contract is provable without touching the
// filesystem, and without a production seam for redirecting a spec-frozen
// security control (SEC-1, docs/specs/handoff-skill/spec/7-non-functional-requirements.md).
describe("pushRemote fail-closed scrub", () => {
  let origRepo;
  beforeEach(() => {
    origRepo = process.env.DOTBABEL_HANDOFF_REPO;
    spawnSync.mockReset();
  });
  afterEach(() => {
    if (origRepo === undefined) delete process.env.DOTBABEL_HANDOFF_REPO;
    else process.env.DOTBABEL_HANDOFF_REPO = origRepo;
  });

  it("aborts the push and writes no branch when the scrubber cannot run", async () => {
    process.env.DOTBABEL_HANDOFF_REPO = "git@example.com:me/store.git";

    // Keyed on the script rather than call order: the non-dry-run path makes
    // more subprocess calls than the dry-run path, and a positional queue
    // would run dry before reaching the scrubber.
    const meta = {
      cli: "claude",
      session_id: "abc12345-aaaa-bbbb-cccc-000000000001",
      short_id: "abc12345",
      cwd: null,
      customTitle: null,
      thread_name: null,
    };
    spawnSync.mockImplementation((cmd, args) => {
      const script = String(cmd);
      if (script.endsWith("handoff-scrub.sh")) {
        return { status: 127, stdout: "", stderr: "handoff-scrub.sh: not found\n" };
      }
      if (script.endsWith("handoff-extract.sh")) {
        const sub = Array.isArray(args) ? args[0] : "";
        if (sub === "meta") return { status: 0, stdout: JSON.stringify(meta), stderr: "" };
        if (sub === "prompts") return { status: 0, stdout: '"hi"\n', stderr: "" };
        if (sub === "turns") return { status: 0, stdout: '"hello"\n', stderr: "" };
        return { status: 0, stdout: "", stderr: "" };
      }
      return { status: 0, stdout: "", stderr: "" };
    });

    // Not dryRun — this is the path that would otherwise reach the remote.
    await expect(
      lib.pushRemote({ cli: "claude", path: "/fake/session.jsonl", tag: null }),
    ).rejects.toThrow(SCRUB_ERROR_PREFIX);

    // Nothing may be committed or pushed once the scrub failed.
    const gitCalls = spawnSync.mock.calls.filter((c) => c[0] === "git");
    const writeVerbs = gitCalls.filter(
      (c) => Array.isArray(c[1]) && ["push", "commit", "add"].some((v) => c[1].includes(v)),
    );
    expect(writeVerbs).toHaveLength(0);
  });

  it("classifies the failure as stage=scrub, which is what exits 2", () => {
    // main() maps a thrown scrub error through classifyGitError; the CLI
    // surface the old bats test asserted on was this stage string.
    expect(
      classifyGitError(`${SCRUB_ERROR_PREFIX}: handoff-scrub.sh exited 127`, "push").stage,
    ).toBe("scrub");
  });
});
