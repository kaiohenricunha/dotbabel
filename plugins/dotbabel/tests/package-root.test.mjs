import { describe, it, expect } from "vitest";
import path from "path";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { findPackageJson } from "../src/lib/package-root.mjs";

describe("findPackageJson", () => {
  it("returns the package.json inside the starting directory itself", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "find-package-json-"));
    writeFileSync(path.join(dir, "package.json"), "{}");
    expect(findPackageJson(dir)).toBe(path.join(dir, "package.json"));
    rmSync(dir, { recursive: true, force: true });
  });

  it("walks up past directories with no package.json to find one in an ancestor", () => {
    const root = mkdtempSync(path.join(tmpdir(), "find-package-json-"));
    writeFileSync(path.join(root, "package.json"), "{}");
    const leaf = path.join(root, "a", "b", "c");
    mkdirSync(leaf, { recursive: true });
    // Must resolve to the ancestor's file, not the leaf's (which does not
    // exist) — proves the walk actually climbed rather than assuming the
    // first directory it checked always has one.
    expect(findPackageJson(leaf)).toBe(path.join(root, "package.json"));
    rmSync(root, { recursive: true, force: true });
  });

  it("throws once it reaches the filesystem root without finding one", () => {
    // os.tmpdir() and everything above it has no package.json on a normal
    // machine, so this walks all the way to "/" and throws.
    const dir = mkdtempSync(path.join(tmpdir(), "find-package-json-"));
    expect(() => findPackageJson(dir)).toThrow(/no package\.json found above/);
    rmSync(dir, { recursive: true, force: true });
  });
});
