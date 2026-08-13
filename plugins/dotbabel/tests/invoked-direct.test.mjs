// Direct unit tests for the run-direct guard helper — the subprocess tests in
// bin-symlink.test.mjs prove the wiring, these pin the helper's contract,
// including the two `false` branches a happy-path spawn never reaches.

import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, describe, expect, it } from "vitest";

import { invokedDirectly, misfiredAs } from "../src/lib/invoked-direct.mjs";

const SELF_URL = import.meta.url;
const SELF_PATH = fileURLToPath(SELF_URL);

const tmp = mkdtempSync(path.join(tmpdir(), "invoked-direct-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const originalArgv1 = process.argv[1];
afterEach(() => {
  process.argv[1] = originalArgv1;
});

describe("invokedDirectly", () => {
  it("true on a verbatim path match — no filesystem access needed", () => {
    process.argv[1] = SELF_PATH;
    expect(invokedDirectly(SELF_URL)).toBe(true);
  });

  it("true when argv[1] is a symlink to the module — the npx/.bin shape", () => {
    const link = path.join(tmp, "shim.mjs");
    symlinkSync(SELF_PATH, link);
    process.argv[1] = link;
    expect(invokedDirectly(SELF_URL)).toBe(true);
  });

  it("false with no argv[1] at all (embedded runners)", () => {
    process.argv[1] = undefined;
    expect(invokedDirectly(SELF_URL)).toBe(false);
  });

  it("false when argv[1] does not resolve — a missing path is not this module", () => {
    process.argv[1] = path.join(tmp, "deleted-mid-run.mjs");
    expect(invokedDirectly(SELF_URL)).toBe(false);
  });

  it("false when argv[1] is a different real file — the import-by-a-runner shape", () => {
    process.argv[1] = fileURLToPath(new URL("./bin-symlink.test.mjs", SELF_URL));
    expect(invokedDirectly(SELF_URL)).toBe(false);
  });
});

describe("misfiredAs", () => {
  it("true when argv[1] basename names the bin, with or without .mjs", () => {
    process.argv[1] = "/anywhere/dotbabel-pr-stack.mjs";
    expect(misfiredAs("dotbabel-pr-stack")).toBe(true);
    process.argv[1] = "/anywhere/dotbabel-pr-stack";
    expect(misfiredAs("dotbabel-pr-stack")).toBe(true);
  });

  it("false for other names and for a missing argv[1]", () => {
    process.argv[1] = "/anywhere/vitest.mjs";
    expect(misfiredAs("dotbabel-pr-stack")).toBe(false);
    process.argv[1] = undefined;
    expect(misfiredAs("dotbabel-pr-stack")).toBe(false);
  });
});
