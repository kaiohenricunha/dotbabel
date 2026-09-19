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

  describe("reusing a result the caller already holds", () => {
    const HEAD = "a".repeat(40);
    /** A plan whose command leaves proof on disk that it actually ran. */
    function markingPlan(repoRoot, id, capability) {
      const mark = path.join(repoRoot, `ran-${id}`);
      return {
        plan: {
          id, componentId: ".:javascript", cwd: repoRoot, executable: process.execPath,
          argv: ["-e", `require("node:fs").writeFileSync(${JSON.stringify(mark)}, "x")`],
          timeoutSeconds: 5, availability: "available", capability, ruleIds: [`correctness.${capability}`],
          requiresTrust: true, report: { format: "exit-code" },
        },
        mark,
      };
    }
    const hit = { leg: "lint", head_sha: HEAD };

    it("does not spawn a plan the resolver accepts", async () => {
      const repoRoot = tempDir();
      const { plan, mark } = markingPlan(repoRoot, "lint", "lint");
      await runQualityPlans({ repoRoot, plans: [plan], allowProjectCommands: true, reuse: () => hit });
      expect(fs.existsSync(mark)).toBe(false);
    });

    it("returns a result shaped like an executed one, so nothing downstream must special-case it", async () => {
      const repoRoot = tempDir();
      const { plan } = markingPlan(repoRoot, "lint", "lint");
      const [result] = await runQualityPlans({ repoRoot, plans: [plan], allowProjectCommands: true, reuse: () => hit });
      expect(result).toMatchObject({
        id: "lint", componentId: ".:javascript", capability: "lint", ruleIds: ["correctness.lint"],
        state: "checked", exitCode: 0, signal: null, timedOut: false, truncated: false,
        stdout: "", stderr: "", durationMs: 0, stdoutFailure: false,
      });
      expect(result.capabilities).toEqual(["lint"]);
    });

    it("says where the result came from, and for which commit", async () => {
      const repoRoot = tempDir();
      const { plan } = markingPlan(repoRoot, "lint", "lint");
      const [result] = await runQualityPlans({ repoRoot, plans: [plan], allowProjectCommands: true, reuse: () => hit });
      expect(result.reused).toEqual({ leg: "lint", head_sha: HEAD });
    });

    it("runs a plan the resolver declines, exactly as before", async () => {
      const repoRoot = tempDir();
      const { plan, mark } = markingPlan(repoRoot, "lint", "lint");
      const [result] = await runQualityPlans({ repoRoot, plans: [plan], allowProjectCommands: true, reuse: () => null });
      expect(fs.existsSync(mark)).toBe(true);
      expect(result.reused).toBeUndefined();
      expect(result.exitCode).toBe(0);
    });

    it("decides per plan, so one refusal does not cost the plans that were accepted", async () => {
      const repoRoot = tempDir();
      const a = markingPlan(repoRoot, "lint", "lint");
      const b = markingPlan(repoRoot, "test", "test");
      const results = await runQualityPlans({
        repoRoot, plans: [a.plan, b.plan], allowProjectCommands: true,
        reuse: (plan) => (plan.capability === "lint" ? hit : null),
      });
      expect(fs.existsSync(a.mark)).toBe(false);
      expect(fs.existsSync(b.mark)).toBe(true);
      expect(results.map((r) => [r.id, Boolean(r.reused)]).sort()).toEqual([["lint", true], ["test", false]]);
    });

    it("offers the resolver each executable plan, and only those", async () => {
      const repoRoot = tempDir();
      const { plan } = markingPlan(repoRoot, "lint", "lint");
      const notConfigured = { id: "fmt", componentId: ".:javascript", capability: "format", ruleIds: [], availability: "not_configured" };
      const offered = [];
      await runQualityPlans({ repoRoot, plans: [plan, notConfigured], allowProjectCommands: true, reuse: (p) => (offered.push(p.id), null) });
      expect(offered).toEqual(["lint"]);
    });

    it("needs no project-command trust for a plan it does not execute", async () => {
      // Trust exists to gate running repository-defined commands. A reused
      // result runs none, and demanding trust for it would turn every
      // untrusted-but-attested worktree into an exit-2 for no safety gain.
      const repoRoot = tempDir();
      const untrusted = { CHECK_ON_STOP_TRUSTED_FILE: path.join(repoRoot, "no-such-allowlist") };
      const { plan } = markingPlan(repoRoot, "lint", "lint");
      await expect(runQualityPlans({ repoRoot, plans: [plan], env: untrusted, reuse: () => hit })).resolves.toHaveLength(1);
    });

    it("still demands trust for a plan it does execute in the same run", async () => {
      const repoRoot = tempDir();
      const untrusted = { CHECK_ON_STOP_TRUSTED_FILE: path.join(repoRoot, "no-such-allowlist") };
      const a = markingPlan(repoRoot, "lint", "lint");
      const b = markingPlan(repoRoot, "test", "test");
      await expect(
        runQualityPlans({ repoRoot, plans: [a.plan, b.plan], env: untrusted, reuse: (p) => (p.capability === "lint" ? hit : null) }),
      ).rejects.toThrow(/trust/);
      expect(fs.existsSync(b.mark)).toBe(false);
    });

    it("behaves exactly as before when no resolver is given", async () => {
      const repoRoot = tempDir();
      const { plan, mark } = markingPlan(repoRoot, "lint", "lint");
      await runQualityPlans({ repoRoot, plans: [plan], allowProjectCommands: true });
      expect(fs.existsSync(mark)).toBe(true);
    });
  });
});
