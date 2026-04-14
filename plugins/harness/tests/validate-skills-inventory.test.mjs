import { describe, it, expect } from "vitest";
import { fileURLToPath } from "url";
import path from "path";
import { readFileSync, writeFileSync, mkdtempSync, cpSync } from "fs";
import { tmpdir } from "os";
import { createHarnessContext } from "../src/spec-harness-lib.mjs";
import { validateManifest, refreshChecksums } from "../src/validate-skills-inventory.mjs";
import { ValidationError, ERROR_CODES } from "../src/lib/errors.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_SRC = path.join(__dirname, "fixtures", "minimal-repo");

function isolateFixture() {
  const dst = mkdtempSync(path.join(tmpdir(), "harness-test-"));
  cpSync(FIXTURE_SRC, dst, { recursive: true });
  return dst;
}

describe("validateManifest", () => {
  it("passes when all manifest entries exist and checksums match", () => {
    const root = isolateFixture();
    const ctx = createHarnessContext({ repoRoot: root });
    const result = validateManifest(ctx);
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("emits MANIFEST_ENTRY_MISSING when a manifest entry references a missing file", () => {
    const root = isolateFixture();
    const ctx = createHarnessContext({ repoRoot: root });
    const manifestPath = path.join(root, ".claude", "skills-manifest.json");
    const m = JSON.parse(readFileSync(manifestPath, "utf8"));
    m.skills[0].path = ".claude/commands/does-not-exist.md";
    writeFileSync(manifestPath, JSON.stringify(m, null, 2));
    const result = validateManifest(ctx);
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toBeInstanceOf(ValidationError);
    expect(result.errors[0].code).toBe(ERROR_CODES.MANIFEST_ENTRY_MISSING);
    expect(result.errors[0].message).toMatch(/File not found/);
  });

  it("emits MANIFEST_CHECKSUM_MISMATCH when a checksum is stale", () => {
    const root = isolateFixture();
    const ctx = createHarnessContext({ repoRoot: root });
    writeFileSync(path.join(root, ".claude", "commands", "example.md"), "# modified\n");
    const result = validateManifest(ctx);
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toBeInstanceOf(ValidationError);
    expect(result.errors[0].code).toBe(ERROR_CODES.MANIFEST_CHECKSUM_MISMATCH);
    expect(result.errors[0].message).toMatch(/Checksum mismatch/);
  });

  it("emits MANIFEST_ORPHAN_FILE when a file on disk is not in the manifest", () => {
    const root = isolateFixture();
    const ctx = createHarnessContext({ repoRoot: root });
    writeFileSync(path.join(root, ".claude", "commands", "orphan.md"), "# orphan\n");
    const result = validateManifest(ctx);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.code === ERROR_CODES.MANIFEST_ORPHAN_FILE)).toBe(true);
    expect(result.errors.join("\n")).toMatch(/orphan/);
  });
});

describe("refreshChecksums", () => {
  it("rewrites stale checksums in place", () => {
    const root = isolateFixture();
    const ctx = createHarnessContext({ repoRoot: root });
    writeFileSync(path.join(root, ".claude", "commands", "example.md"), "# modified\n");
    refreshChecksums(ctx);
    const result = validateManifest(ctx);
    expect(result.ok).toBe(true);
  });
});
