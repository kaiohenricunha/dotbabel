// npm installs package bins as node_modules/.bin symlinks. Node realpath-
// resolves the ESM entry module (so import.meta.url points at the real file)
// but leaves process.argv[1] as the symlink path, so a run-direct guard that
// compares the two verbatim concludes the bin was imported, not executed —
// and the bin silently exits 0 having done nothing. These tests invoke each
// guarded bin through a symlink, exactly like `npx <bin>` does, and expect
// the same loud usage error a direct invocation produces.

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const BIN_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../bin");

const GUARDED_BINS = ["dotbabel-local-attest", "dotbabel-pr-stack", "dotbabel-handoff"];

const shimDir = mkdtempSync(path.join(tmpdir(), "dotbabel-bin-shim-"));
afterAll(() => rmSync(shimDir, { recursive: true, force: true }));

describe.each(GUARDED_BINS)("%s invoked through a .bin-style symlink", (bin) => {
  it("still runs main() — a bogus flag dies loudly instead of a silent exit 0", () => {
    const shim = path.join(shimDir, bin);
    symlinkSync(path.join(BIN_DIR, `${bin}.mjs`), shim);
    const r = spawnSync(process.execPath, [shim, "--bogus-flag"], { encoding: "utf8" });
    expect(r.status).toBe(64);
    expect(r.stderr).toMatch(/[Uu]nknown (argument|option)/);
  });
});
