import { it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const bin = resolve("plugins/dotbabel/bin/dotbabel-models.mjs");
it("shows the managed session and independent automatic-axis controls in help", () => {
  const result = spawnSync(process.execPath, [bin, "--help"], { encoding: "utf8" });
  expect(result.status).toBe(0); expect(result.stdout).toContain("session"); expect(result.stdout).toContain("--effort"); expect(result.stdout).toContain("--model");
});
it("reports experimental Claude integration separately from opt-in and effective session state", () => {
  const root = mkdtempSync(join(tmpdir(), "mi-routing-status-"));
  try {
    const result = spawnSync(process.execPath, [bin, "status", "--repo-root", root, "--json"], { encoding: "utf8", env: { ...process.env, PATH: "" } });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).mainSessionIntegrations).toContainEqual({ runtimeId: "claude", mechanism: "session-only-native-mods", implementation: "experimental", verifiedHostVersions: ["2.1.302", "2.1.304"], providerExecution: "unverified", effective: { state: "unknown" } });
  } finally { rmSync(root, { recursive: true, force: true }); }
});
it("rejects session usage errors before reading activation or starting a runtime", () => {
  for (const args of [["session", "extra"], ["session", "--runtime", "gemini"], ["session", "--runtime", "claude", "--json"], ["session", "--effort", "\u0001"], ["session", "--requirement", "deep"]]) {
    expect(spawnSync(process.execPath, [bin, ...args], { encoding: "utf8" }).status).toBe(64);
  }
});
it("accepts Claude session selection but starts no native process for a disabled project", () => {
  const root = mkdtempSync(join(tmpdir(), "mi-claude-disabled-"));
  try {
    const result = spawnSync(process.execPath, [bin, "session", "--runtime", "claude", "--repo-root", root], { encoding: "utf8", env: { ...process.env, PATH: "" } });
    expect(result.status).toBe(2); expect(result.stdout + result.stderr).toContain("routing_disabled");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
it("starts no native process for a disabled project", () => {
  const root = mkdtempSync(join(tmpdir(), "mi-session-disabled-"));
  try {
    mkdirSync(join(root, "bin")); writeFileSync(join(root, "bin", "codex"), "#!/bin/sh\nexit 99\n", { mode: 0o700 });
    const result = spawnSync(process.execPath, [bin, "session", "--repo-root", root, "--json"], { input: "An ordinary prompt.\n", encoding: "utf8", env: { ...process.env, PATH: join(root, "bin") } });
    expect(result.status).toBe(2); expect(result.stderr).toContain("routing_disabled"); expect(JSON.parse(result.stdout).diagnostics[0].code).toBe("routing_disabled");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
it("routes an ordinary main-session prompt before execution", () => {
  const root = mkdtempSync(join(tmpdir(), "mi-session-enabled-"));
  try {
    mkdirSync(join(root, "bin"));
    const log = join(root, "turns.jsonl"), fixture = resolve("plugins/dotbabel/tests/fixtures/adaptive-session-routing/client-runtime.mjs");
    const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
    writeFileSync(join(root, "bin", "codex"), `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(fixture)} ${quote(log)} "$@"\n`, { mode: 0o700 });
    writeFileSync(join(root, ".dotbabel.json"), JSON.stringify({ model_intelligence: { enabled: true, adaptive_routing: { enabled: true } } }));
    const prompts = ["Format the sample JSON as two-space indented text. Return only JSON: {a:1}", "Debug why this integration test fails intermittently and verify the fix. The retry loop reads a stale cursor."];
    const result = spawnSync(process.execPath, [bin, "session", "--repo-root", root, "--model", "auto", "--effort", "auto", "--json"], { input: prompts.join("\n") + "\n", encoding: "utf8", timeout: 15000, env: { ...process.env, PATH: join(root, "bin") + ":" + process.env.PATH } });
    expect(result.status, result.stderr).toBe(0);
    const turns = result.stdout.trim().split("\n").map(JSON.parse).filter(row => row.type === "turn");
    expect(turns).toHaveLength(2); expect(turns.every(row => row.status === "completed" && row.effective.state === "observed")).toBe(true);
    expect(turns[0].effective.axes.reasoning).toBe("low"); expect(turns[1].effective.axes.reasoning).toBe("high");
    const submissions = readFileSync(log, "utf8").trim().split("\n").map(JSON.parse);
    expect(submissions).toHaveLength(2);
    expect(submissions.map(row => row.threadId)).toEqual(["same-thread", "same-thread"]);
    expect(submissions.map(row => row.input)).toEqual(prompts.map(text => [{ type: "text", text, text_elements: [] }]));
    expect(submissions[0].model).toBe(turns[0].effective.axes.model);
    expect(submissions.map(row => row.effort)).toEqual(["low", "high"]);
    const before = readFileSync(log, "utf8");
    const blocked = spawnSync(process.execPath, [bin, "session", "--repo-root", root, "--model", "auto", "--effort", "unsupported-effort", "--json"], { input: prompts[0] + "\n", encoding: "utf8", timeout: 15000, env: { ...process.env, PATH: join(root, "bin") + ":" + process.env.PATH } });
    expect(blocked.status).toBe(1);
    expect(blocked.stdout.trim().split("\n").map(JSON.parse).find(row => row.type === "turn").status).toBe("blocked");
    expect(readFileSync(log, "utf8")).toBe(before);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
