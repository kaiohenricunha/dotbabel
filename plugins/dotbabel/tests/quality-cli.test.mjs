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

describe("quality CLI path scoping", () => {
  it("rejects a path filter that matches no repository file", () => {
    const repo = tempRepo();
    const result = spawnSync(process.execPath, [bin, "detect", "--repo", repo, "--path", "does/not/exist"], { encoding: "utf8" });
    expect(result.status).toBe(64);
    expect(result.stderr).toMatch(/--path/);
  });

  it("rejects an absolute path filter", () => {
    const repo = tempRepo();
    const result = spawnSync(process.execPath, [bin, "detect", "--repo", repo, "--path", "/etc"], { encoding: "utf8" });
    expect(result.status).toBe(64);
  });

  it("rejects a parent-escaping path filter", () => {
    const repo = tempRepo();
    const result = spawnSync(process.execPath, [bin, "detect", "--repo", repo, "--path", "../outside"], { encoding: "utf8" });
    expect(result.status).toBe(64);
  });

  it("rejects a path filter on explain", () => {
    const repo = tempRepo();
    const result = spawnSync(process.execPath, [bin, "explain", "--repo", repo, "--path", "index.js"], { encoding: "utf8" });
    expect(result.status).toBe(64);
  });

  it("rejects a path filter with baseline --write as usage, not an environment failure", () => {
    const repo = tempRepo();
    const result = spawnSync(process.execPath, [bin, "baseline", "--repo", repo, "--path", "index.js", "--write"], { encoding: "utf8" });
    expect(result.status).toBe(64);
    expect(result.status).not.toBe(2);
  });

  it("rejects the whole-repository mode together with a base revision", () => {
    const repo = tempRepo();
    const result = spawnSync(process.execPath, [bin, "check", "--repo", repo, "--all", "--base", "main"], { encoding: "utf8" });
    expect(result.status).toBe(64);
  });

  it("scopes detect to one path and reports the remainder as excluded", () => {
    const repo = tempRepo();
    fs.writeFileSync(path.join(repo, "other.js"), "const other = 2;\n");
    const result = spawnSync(process.execPath, [bin, "detect", "--repo", repo, "--path", "index.js", "--json"], { encoding: "utf8" });
    expect(result.status).toBe(0);
    const body = JSON.parse(result.stdout);
    expect(body.path_scope).toEqual(["index.js"]);
    expect(body.exclusions).toEqual(expect.arrayContaining([expect.objectContaining({ reason: "outside path filter" })]));
  });

  it("accepts a repeated path filter", () => {
    const repo = tempRepo();
    fs.writeFileSync(path.join(repo, "other.js"), "const other = 2;\n");
    const result = spawnSync(process.execPath, [bin, "detect", "--repo", repo, "--path", "index.js", "--path", "other.js", "--json"], { encoding: "utf8" });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).path_scope).toEqual(["index.js", "other.js"]);
  });

  it("normalizes a Windows-separated path filter", () => {
    const repo = tempRepo();
    fs.mkdirSync(path.join(repo, "src"), { recursive: true });
    fs.writeFileSync(path.join(repo, "src", "a.js"), "const a = 1;\n");
    const result = spawnSync(process.execPath, [bin, "detect", "--repo", repo, "--path", "src\\", "--json"], { encoding: "utf8" });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).path_scope).toEqual(["src"]);
  });
});

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
