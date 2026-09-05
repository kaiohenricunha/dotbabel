import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { redactOutput } from "../src/lib/redact-output.mjs";
import { runQualityPlans, validateCommandPlan } from "../src/quality/runner.mjs";

const dirs = [];
function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dotbabel-quality-runner-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => dirs.splice(0).forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));

describe("quality runner", () => {
  it("preserves argv and never evaluates shell syntax", async () => {
    const repoRoot = tempDir();
    const marker = path.join(repoRoot, "owned");
    const plans = [{ id: "syntax", componentId: ".:javascript", cwd: repoRoot, executable: process.execPath, argv: ["-e", "process.stdout.write(process.argv[1])", `; touch ${marker}`], timeoutSeconds: 2, ruleIds: ["correctness.compile"], capability: "compile", availability: "available" }];
    const [result] = await runQualityPlans({ repoRoot, plans, allowProjectCommands: true });
    expect(result.stdout).toContain(`; touch ${marker}`);
    expect(fs.existsSync(marker)).toBe(false);
  });

  it("rejects unsafe configured executables and cwd escapes", () => {
    const repoRoot = tempDir();
    expect(() => validateCommandPlan({ repoRoot, plan: { executable: "/bin/sh", argv: [], cwd: repoRoot } })).toThrow(/absolute executable/);
    expect(() => validateCommandPlan({ repoRoot, plan: { executable: "node", argv: [], cwd: path.dirname(repoRoot) } })).toThrow(/cwd/);
  });

  it("deduplicates one command while retaining all supplied rules", async () => {
    const repoRoot = tempDir();
    const base = { componentId: ".:javascript", cwd: repoRoot, executable: process.execPath, argv: ["-e", ""], timeoutSeconds: 2, availability: "available" };
    const results = await runQualityPlans({ repoRoot, allowProjectCommands: true, plans: [
      { ...base, id: "compile", capability: "compile", ruleIds: ["correctness.compile"] },
      { ...base, id: "test", capability: "test", ruleIds: ["correctness.tests"] },
    ] });
    expect(results).toHaveLength(1);
    expect(results[0].ruleIds).toEqual(["correctness.compile", "correctness.tests"]);
  });

  it("redacts credentials and limits passed environment names", () => {
    expect(redactOutput("Authorization: Bearer abcdef\nAPI_KEY=secret-value")).not.toContain("secret-value");
  });

  it.each([
    "ghp_" + "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456",
    "sk-" + "ant-api03-abcdefghijklmnopqrstuvwxyz0123",
    "AKIA" + "IOSFODNN7EXAMPLE",
    "AIza" + "ABCDEFGHIJKLMNOPQRSTUVWXYZ123456789",
    "xoxb-" + "1234567890-abcdefghij",
    "Authorization: Bearer a-secret-token",
    "export SERVICE_PASSWORD=secret-value",
    "-----BEGIN OPENSSH PRIVATE KEY-----",
  ])("matches the shared handoff credential floor for %s", (secret) => {
    expect(redactOutput(secret)).not.toContain(secret);
  });

  it("does not redact the sk-learn package name", () => {
    expect(redactOutput("Use sk-learn and sklearn")).toBe("Use sk-learn and sklearn");
  });
});
