// Tier 2: installed Claude parses the real built package; stop at init before inference.
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolveContext, runIsolated } from "../../src/model-intelligence/sources/runtime/process.mjs";

const plugin = fileURLToPath(new URL("../..", import.meta.url));
describe.skipIf(process.env.DOTBABEL_MODELS_INTEGRATION !== "1")("installed Claude release baseline acceptance", () => {
  it("loads built agent metadata and identifies immutable shipped provenance without inference", async context => {
    const manifest = JSON.parse(fs.readFileSync(path.join(plugin, "templates/claude/.dotbabel-projection.json"), "utf8"));
    const snapshot = JSON.parse(fs.readFileSync(path.join(plugin, "src/model-intelligence/snapshot/release-capabilities.json"), "utf8"));
    expect(Object.values(manifest.entries).every(entry => entry.snapshotId === snapshot.snapshotId)).toBe(true);
    const result = await runIsolated(resolveContext({ timeoutMs: 20_000 }, { rootEnvVar: "CLAUDE_CONFIG_DIR", rootDirName: ".claude" }), {
      prefix: "mi-plugin-baseline", command: "claude", rootEnvVar: "CLAUDE_CONFIG_DIR",
      provenance: { sourceId: "claude", sourceKind: "runtime", adapterVersion: "release-baseline-contract-1" },
      args: ["-p", "x", "--plugin-dir", plugin, "--model", "sonnet", "--output-format", "stream-json", "--verbose", "--no-session-persistence"],
      prepare: async ({ work }) => { fs.mkdirSync(path.join(work, ".git")); },
      stopWhen: ({ stdout }) => stdout.split("\n").some(line => { try { const event = JSON.parse(line); return event.type === "system" && event.subtype === "init"; } catch { return false; } }),
    });
    if (result.status === "unavailable" && result.diagnostic?.code === "binary_missing") { context.skip(); return; }
    expect(result.status).toBe("ok");
    expect(result.evidence.aborted).toBe(false); expect(result.evidence.truncated).toBe(false);
    const events = result.evidence.stdout.split("\n").flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
    const init = events.find(event => event.type === "system" && event.subtype === "init");
    expect(init.claude_code_version).toMatch(/^\d+\.\d+\.\d+/);
    expect(init.agents.some(name => name.includes("security-auditor"))).toBe(true);
    for (const event of events.filter(event => event.type === "result")) {
      expect(event.duration_api_ms).toBe(0); expect(event.total_cost_usd).toBe(0); expect(event.modelUsage).toEqual({});
      expect(event.usage.input_tokens).toBe(0); expect(event.usage.output_tokens).toBe(0);
    }
    const status = spawnSync(process.execPath, [path.join(plugin, "bin/dotbabel-models.mjs"), "status", "--json"], { encoding: "utf8" });
    expect(status.status, status.stderr).toBe(0);
    expect(JSON.parse(status.stdout).shippedBaseline.snapshotIds).toEqual([snapshot.snapshotId]);
    console.info(JSON.stringify({ runtimeVersion: init.claude_code_version, loadedPlugin: "dotbabel", loadedSecurityAgent: true, snapshotId: snapshot.snapshotId, apiInference: false, effectiveAgentEffort: "not-observed" }));
  }, 25_000);
});
