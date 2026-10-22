// Behavior tests for patchPaths: the files a Codex apply_patch edit touches,
// read from the patch text that the PreToolUse hook receives.

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { patchPaths } from "../src/fleet/patch-paths.mjs";

const FIXTURE = JSON.parse(
  fs.readFileSync(
    path.join(import.meta.dirname, "fixtures/codex-hooks/codex-0.163.0.json"),
    "utf8",
  ),
);

describe("patchPaths", () => {
  it("reads the path of the recorded Codex apply_patch payload", () => {
    expect(patchPaths(FIXTURE.preToolUseApplyPatch.tool_input.command)).toEqual(["blocked.txt"]);
  });

  it("names every added, updated, deleted, and moved file once, in patch order", () => {
    const patch = [
      "*** Begin Patch",
      "*** Update File: src/a.mjs",
      "@@",
      "-old",
      "+new",
      "*** Add File: /abs/repo/docs/b.md",
      "+hello",
      "*** Delete File: c.txt",
      "*** Update File: src/old-name.mjs",
      "*** Move to: src/new-name.mjs",
      "@@",
      "+x",
      "*** Update File: src/a.mjs",
      "+again",
      "*** End Patch",
    ].join("\n");
    expect(patchPaths(patch)).toEqual([
      "src/a.mjs",
      "/abs/repo/docs/b.md",
      "c.txt",
      "src/old-name.mjs",
      "src/new-name.mjs",
    ]);
  });

  it("accepts CRLF line ends and surrounding blank lines", () => {
    expect(
      patchPaths("\r\n*** Begin Patch\r\n*** Add File: x.md\r\n+x\r\n*** End Patch\r\n"),
    ).toEqual(["x.md"]);
  });

  it("ignores a header-like line that is file content, not a header", () => {
    const patch =
      "*** Begin Patch\n*** Add File: notes.md\n+*** Update File: not-a-header.md\n*** End Patch";
    expect(patchPaths(patch)).toEqual(["notes.md"]);
  });

  it("returns null for text that is not a patch, so the edit is not judged", () => {
    for (const text of [
      undefined,
      null,
      42,
      "",
      "echo hi",
      "*** Update File: a.md\n*** End Patch",
    ]) {
      expect(patchPaths(text)).toBe(null);
    }
  });

  it("returns an empty list for a patch without a file header", () => {
    expect(patchPaths("*** Begin Patch\n*** End Patch")).toEqual([]);
    expect(patchPaths("*** Begin Patch\n*** Add File:    \n*** End Patch")).toEqual([]);
  });
});
