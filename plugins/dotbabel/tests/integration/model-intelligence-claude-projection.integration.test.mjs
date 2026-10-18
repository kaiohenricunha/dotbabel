// Tier 2 native frontmatter loading, isolated from credentials and the real runtime root.
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { materializeClaude } from "../../src/model-intelligence/materialize/runtime/claude.mjs";
import { resolveContext, runIsolated } from "../../src/model-intelligence/sources/runtime/process.mjs";
import { claudeNativeProjectionFixture } from "../fixtures/model-intelligence/claude-projection.mjs";

describe.skipIf(process.env.DOTBABEL_MODELS_INTEGRATION !== "1")("installed Claude projection acceptance", () => {
  it("loads generated agent, command and skill frontmatter without private compute or API inference", async context => {
    const batch = materializeClaude(claudeNativeProjectionFixture());
    const runtime = { rootEnvVar: "CLAUDE_CONFIG_DIR", rootDirName: ".claude" };
    const result = await runIsolated(resolveContext({ timeoutMs: 20_000 }, runtime), {
      prefix: "mi-claude-projection", command: "claude",
      args: ["-p", "x", "--model", "sonnet", "--output-format", "stream-json", "--verbose", "--no-session-persistence"],
      rootEnvVar: runtime.rootEnvVar,
      provenance: { sourceId: "claude", sourceKind: "runtime", adapterVersion: "projection-contract-1" },
      prepare: async ({ work }) => {
        fs.mkdirSync(path.join(work, ".git"));
        for (const file of batch.files) {
          const destination = path.join(work, ".claude", file.path);
          fs.mkdirSync(path.dirname(destination), { recursive: true }); fs.writeFileSync(destination, file.content);
          expect(fs.readFileSync(destination, "utf8")).not.toMatch(/^dotbabel:/m);
        }
      },
      stopWhen: ({ stdout }) => stdout.split("\n").some(line => { try { const event = JSON.parse(line); return event.type === "system" && event.subtype === "init"; } catch { return false; } }),
    });
    if (result.status === "unavailable" && result.diagnostic?.code === "binary_missing") { context.skip(); return; }
    expect(result.status).toBe("ok");
    expect(result.evidence.aborted).toBe(false); expect(result.evidence.truncated).toBe(false);
    const events = result.evidence.stdout.split("\n").flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
    const init = events.find(event => event.type === "system" && event.subtype === "init");
    expect(init.claude_code_version).toMatch(/^\d+\.\d+\.\d+/);
    expect(init.agents).toContain("projection-example");
    expect(init.slash_commands).toEqual(expect.arrayContaining(["example-command", "example-skill"]));
    expect(init.skills).toContain("example-skill");
    const results = events.filter(event => event.type === "result");
    for (const event of results) {
      expect(event.duration_api_ms).toBe(0); expect(event.total_cost_usd).toBe(0);
      expect(event.modelUsage).toEqual({});
      expect(event.usage.input_tokens).toBe(0); expect(event.usage.output_tokens).toBe(0);
    }
    console.info(JSON.stringify({ runtimeVersion: init.claude_code_version, loadedArtifacts: 3, privateCompute: false, apiInference: false, effectiveAgentEffort: "not-observed" }));
  }, 25_000);
});
