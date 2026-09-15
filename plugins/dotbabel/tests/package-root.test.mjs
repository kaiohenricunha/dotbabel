import { describe, it, expect } from "vitest";
import path from "path";
import { mkdirSync, writeFileSync } from "fs";
import { findPackageJson } from "../src/lib/package-root.mjs";
import { makeTempDir } from "./fixtures/temp-dir.mjs";

describe("findPackageJson", () => {
  it("returns the package.json inside the starting directory itself", () => {
    const dir = makeTempDir("find-package-json-");
    writeFileSync(path.join(dir, "package.json"), "{}");
    expect(findPackageJson(dir)).toBe(path.join(dir, "package.json"));
  });

  it("walks up past directories with no package.json to find one in an ancestor", () => {
    const root = makeTempDir("find-package-json-");
    writeFileSync(path.join(root, "package.json"), "{}");
    const leaf = path.join(root, "a", "b", "c");
    mkdirSync(leaf, { recursive: true });
    // Must resolve to the ancestor's file, not the leaf's (which does not
    // exist) — proves the walk actually climbed rather than assuming the
    // first directory it checked always has one.
    expect(findPackageJson(leaf)).toBe(path.join(root, "package.json"));
  });

  it("throws once it reaches the filesystem root without finding one", () => {
    // os.tmpdir() and everything above it has no package.json on a normal
    // machine, so this walks all the way to "/" and throws.
    const dir = makeTempDir("find-package-json-");
    expect(() => findPackageJson(dir)).toThrow(/no package\.json found above/);
  });
});
