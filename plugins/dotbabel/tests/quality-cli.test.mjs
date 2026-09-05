import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const bin = path.join(repoRoot, "plugins/dotbabel/bin/dotbabel-quality.mjs");
const dirs = [];
function tempRepo(config = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dotbabel-quality-cli-"));
  dirs.push(dir);
  fs.writeFileSync(path.join(dir, ".dotbabel.json"), JSON.stringify(config));
  fs.writeFileSync(path.join(dir, "index.js"), "const value = 1;\n");
  return dir;
}
afterEach(() => dirs.splice(0).forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));

describe("quality CLI", () => {
  it("explains one rule through a versioned JSON envelope", () => {
    const repo = tempRepo();
    const result = spawnSync(process.execPath, [bin, "explain", "--repo", repo, "--rule", "size.file_loc", "--json"], { encoding: "utf8" });
    expect(result.status).toBe(0);
    const body = JSON.parse(result.stdout);
    expect(body.schema_version).toBe(1);
    expect(body.command).toBe("explain");
    expect(body.policy.rules["size.file_loc"].threshold).toBe(500);
  });

  it("explains resolved rules in human output", () => {
    const repo = tempRepo();
    const result = spawnSync(process.execPath, [bin, "explain", "--repo", repo, "--rule", "size.file_loc"], { encoding: "utf8" });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("size.file_loc");
    expect(result.stdout).toContain("threshold=500");
    expect(result.stdout).toContain("provenance=shipped");
  });

  it("lists components and trust in human detect output", () => {
    const repo = tempRepo();
    const result = spawnSync(process.execPath, [bin, "detect", "--repo", repo], { encoding: "utf8" });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(".:javascript");
    expect(result.stdout).toContain("Project command trust:");
  });

  it("reports disabled checks with exit code zero", () => {
    const repo = tempRepo({ quality: { enabled: false } });
    const result = spawnSync(process.execPath, [bin, "check", "--repo", repo, "--json"], { encoding: "utf8" });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).state).toBe("disabled");
  });

  it("returns usage for an unknown nested command", () => {
    const repo = tempRepo();
    const result = spawnSync(process.execPath, [bin, "unknown", "--repo", repo], { encoding: "utf8" });
    expect(result.status).toBe(64);
  });
});
