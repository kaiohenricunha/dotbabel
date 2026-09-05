import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { resolveQualityPolicy, validateQualityConfig } from "../src/quality/config.mjs";

const dirs = [];
function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dotbabel-quality-config-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => dirs.splice(0).forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));

describe("quality configuration", () => {
  it("merges shipped, user, and project values with provenance", () => {
    const repoRoot = tempDir();
    const configRoot = tempDir();
    fs.mkdirSync(path.join(configRoot, "dotbabel"));
    fs.writeFileSync(path.join(configRoot, "dotbabel", "quality.json"), JSON.stringify({
      exclude: ["build/**"],
      rules: { "size.file_loc": { threshold: 450 } },
    }));
    fs.writeFileSync(path.join(repoRoot, ".dotbabel.json"), JSON.stringify({
      quality: {
        default_profile: "pr",
        exclude: ["generated/**", "build/**"],
        rules: { "size.file_loc": { threshold: 400, level: "error" } },
      },
    }));

    const policy = resolveQualityPolicy({
      repoRoot,
      env: { XDG_CONFIG_HOME: configRoot },
    });
    expect(policy.default_profile).toBe("pr");
    expect(policy.exclude).toEqual(expect.arrayContaining(["build/**", "generated/**", "vendor/**"]));
    expect(policy.exclude.filter((item) => item === "build/**")).toHaveLength(1);
    expect(policy.rules["size.file_loc"].threshold).toBe(400);
    expect(policy.rules["size.file_loc"].provenance.threshold).toBe("project");
  });

  it("allows unknown languages and rejects unknown nested keys", () => {
    expect(() => validateQualityConfig({ components: [{ root: "api", languages: ["rust"] }] }, { source: "project" })).not.toThrow();
    expect(() => validateQualityConfig({ mystery: true }, { source: "project" })).toThrow(/unknown quality key/);
    expect(() => validateQualityConfig({ rules: { "unknown.rule": {} } }, { source: "project" })).toThrow(/unknown quality rule/);
  });

  it("rejects unsafe commands, paths, thresholds, and user-only forbidden fields", () => {
    expect(() => validateQualityConfig({ components: [{ root: "../api", languages: ["go"] }] }, { source: "project" })).toThrow(/repository-relative/);
    expect(() => validateQualityConfig({ components: [{ root: "api", languages: ["go"], tools: { test: { argv: "make test" } } }] }, { source: "project" })).toThrow(/argv/);
    expect(() => validateQualityConfig({ components: [{ root: "api", languages: ["go"], tools: { test: { argv: ["/bin/sh"] } } }] }, { source: "project" })).toThrow(/executable/);
    expect(() => validateQualityConfig({ rules: { "coverage.changed_lines": { threshold: 101 } } }, { source: "project" })).toThrow(/0 through 100/);
    expect(() => validateQualityConfig({ base_ref: "main" }, { source: "user" })).toThrow(/project-only/);
  });

  it("returns a visible disabled policy", () => {
    const repoRoot = tempDir();
    fs.writeFileSync(path.join(repoRoot, ".dotbabel.json"), JSON.stringify({ quality: { enabled: false } }));
    expect(resolveQualityPolicy({ repoRoot, env: {} }).enabled).toBe(false);
  });

  it("rejects exceptions for configured hard lint failures", () => {
    expect(() => validateQualityConfig({ exceptions: [{
      id: "QEX-9",
      rule: "correctness.lint",
      fingerprint: "sha256:abc",
      reason: "This must not bypass a configured lint gate.",
      expires: "2027-01-01",
    }] })).toThrow(/exceptions cannot apply to correctness\.lint/);
  });

  it.each([
    ["non-object quality", null],
    ["invalid enabled", { enabled: "yes" }],
    ["unknown profile", { default_profile: "full" }],
    ["absolute baseline", { baseline_file: "/tmp/base.json" }],
    ["invalid exclusions", { exclude: [""] }],
    ["invalid critical paths", { critical_paths: "src/**" }],
    ["non-object rules", { rules: [] }],
    ["non-object rule", { rules: { "size.file_loc": null } }],
    ["unknown rule option", { rules: { "size.file_loc": { mystery: true } } }],
    ["threshold-less rule", { rules: { "correctness.compile": { threshold: 1 } } }],
    ["negative threshold", { rules: { "size.file_loc": { threshold: -1 } } }],
    ["invalid level", { rules: { "size.file_loc": { level: "fatal" } } }],
    ["invalid availability level", { rules: { "size.file_loc": { on_unavailable: "fatal" } } }],
    ["invalid scope", { rules: { "size.file_loc": { scope: "workspace" } } }],
    ["invalid profiles", { rules: { "size.file_loc": { profiles: ["full"] } } }],
    ["non-array components", { components: {} }],
    ["non-object component", { components: [null] }],
    ["unknown component option", { components: [{ root: ".", languages: ["go"], mystery: true }] }],
    ["empty languages", { components: [{ root: ".", languages: [] }] }],
    ["non-object tools", { components: [{ root: ".", languages: ["go"], tools: [] }] }],
    ["unknown capability", { components: [{ root: ".", languages: ["go"], tools: { install: { argv: ["go"] } } }] }],
    ["non-object tool", { components: [{ root: ".", languages: ["go"], tools: { lint: null } }] }],
    ["unknown tool option", { components: [{ root: ".", languages: ["go"], tools: { lint: { argv: ["go"], shell: true } } }] }],
    ["empty argv", { components: [{ root: ".", languages: ["go"], tools: { lint: { argv: [] } } }] }],
    ["NUL argv", { components: [{ root: ".", languages: ["go"], tools: { lint: { argv: ["go", "a\0b"] } } }] }],
    ["escaping executable", { components: [{ root: ".", languages: ["go"], tools: { lint: { argv: ["../go"] } } }] }],
    ["invalid timeout", { components: [{ root: ".", languages: ["go"], tools: { lint: { argv: ["go"], timeout_seconds: 0 } } }] }],
    ["non-object report", { components: [{ root: ".", languages: ["go"], tools: { lint: { argv: ["go"], report: [] } } }] }],
    ["unknown report option", { components: [{ root: ".", languages: ["go"], tools: { lint: { argv: ["go"], report: { format: "exit-code", extra: true } } } }] }],
    ["unknown report format", { components: [{ root: ".", languages: ["go"], tools: { lint: { argv: ["go"], report: { format: "xml" } } } }] }],
    ["escaping report", { components: [{ root: ".", languages: ["go"], tools: { lint: { argv: ["go"], report: { format: "sarif", path: "../lint.sarif" } } } }] }],
    ["non-array exceptions", { exceptions: {} }],
    ["non-object exception", { exceptions: [null] }],
    ["unknown exception option", { exceptions: [{ id: "QEX-1", rule: "size.file_loc", fingerprint: "sha256:x", reason: "reason", expires: "2027-01-01", extra: true }] }],
    ["unknown exception rule", { exceptions: [{ id: "QEX-1", rule: "unknown", fingerprint: "sha256:x", reason: "reason", expires: "2027-01-01" }] }],
    ["invalid fingerprint", { exceptions: [{ id: "QEX-1", rule: "size.file_loc", fingerprint: "x", reason: "reason", expires: "2027-01-01" }] }],
    ["empty reason", { exceptions: [{ id: "QEX-1", rule: "size.file_loc", fingerprint: "sha256:x", reason: "", expires: "2027-01-01" }] }],
    ["invalid expiration", { exceptions: [{ id: "QEX-1", rule: "size.file_loc", fingerprint: "sha256:x", reason: "reason", expires: "tomorrow" }] }],
    ["invalid tracking", { exceptions: [{ id: "QEX-1", rule: "size.file_loc", fingerprint: "sha256:x", reason: "reason", expires: "2027-01-01", tracking: "not a URL" }] }],
  ])("rejects %s", (_name, value) => {
    expect(() => validateQualityConfig(value, { source: "project" })).toThrow();
  });

  it("accepts the complete strict project shape", () => {
    expect(() => validateQualityConfig({
      enabled: true,
      default_profile: "deep",
      base_ref: "origin/main",
      baseline_file: ".dotbabel/base.json",
      exclude: ["generated/**"],
      critical_paths: ["internal/auth/**"],
      rules: { "size.file_loc": { enabled: true, level: "warning", threshold: 450, scope: "changed", on_unavailable: "info", profiles: ["fast", "pr"] } },
      components: [{ root: ".", languages: ["rust"], tools: { lint: { argv: ["./tools/lint", "--all"], timeout_seconds: 30, report: { format: "exit-code" } } } }],
      exceptions: [{ id: "QEX-1", rule: "size.file_loc", fingerprint: "sha256:x", reason: "A coherent generated table.", expires: "2027-01-01", tracking: "https://example.invalid/1" }],
    }, { source: "project" })).not.toThrow();
  });
});
