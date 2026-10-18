// Tier 3: explicit existing-native authorization, read-only Models API; zero inference.
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { makeTempDir } from "../fixtures/temp-dir.mjs";

describe.skipIf(process.env.DOTBABEL_MODELS_TIER3 !== "1")("Anthropic source through native Claude authorization", () => {
  it("normalizes live metadata without exposing authorization or executing a model", context => {
    const version = spawnSync("claude", ["--version"], { encoding: "utf8", timeout: 10_000 });
    if (version.error || version.status !== 0) { context.skip(); return; }
    const root = makeTempDir("mi-anthropic-native-"); const plugin = join(root, "plugin");
    fs.mkdirSync(join(root, ".git")); fs.mkdirSync(join(plugin, ".claude-plugin"), { recursive: true }); fs.mkdirSync(join(plugin, "hooks"));
    fs.writeFileSync(join(plugin, ".claude-plugin/plugin.json"), JSON.stringify({ name: "dotbabel-source-proof", version: "0.1.0" }));
    fs.writeFileSync(join(plugin, "hooks/hooks.json"), JSON.stringify({ modules: ["./register.js"] }));
    const bridge = join(root, "normalize.mjs");
    const source = new URL("../../src/model-intelligence/sources/knowledge/anthropic.mjs", import.meta.url).href;
    fs.writeFileSync(bridge, `import {discover} from ${JSON.stringify(source)};
let input=""; for await (const chunk of process.stdin) { input+=chunk; if(Buffer.byteLength(input)>8*1024*1024) throw new Error("response_too_large"); }
const result=await discover({providers:["anthropic"],fetch:async()=>new Response(input)});
if(result.status!=="ok") {console.log(JSON.stringify({status:result.status,code:result.diagnostic?.code}));process.exitCode=1;}
else {const models=result.evidence.providers[0].discovery.models;console.log(JSON.stringify({status:"ok",sourceId:result.provenance.sourceId,sourceVersion:result.provenance.sourceVersion,modelCount:models.length,effortModelCount:models.filter(x=>x.supportedReasoningLevels.length>0).length,availabilityFacts:models.filter(x=>Object.hasOwn(x,"availability")).length}));}
`);
    fs.writeFileSync(join(plugin, "hooks/register.js"), `export function register(on) {
on("session.start",async($,e,next)=>{await $.command.register({name:"dotbabel-source-proof",description:"Read-only provider source proof"});return next(e);});
on("command.run",{command:"dotbabel-source-proof"},async($)=>{try{
 const authorization=await $.session.authorize();if(authorization===null)return {text:JSON.stringify({status:"skip",code:"native_authorization_unavailable"})};
 const response=await $.http.fetch("https://api.anthropic.com/v1/models?limit=100",{auth:authorization.handle,headers:{"anthropic-version":"2023-06-01"}});
 if(!response.ok)return {text:JSON.stringify({status:"skip",code:"native_metadata_unavailable",httpStatus:response.status})};
 const normalized=await $.process.run(${JSON.stringify([process.execPath, bridge])},{cwd:${JSON.stringify(root)},stdin:response.text,timeoutMs:10000});
 return {text:normalized.exitCode===0?normalized.stdout:JSON.stringify({status:"normalization_failed"})};
}catch{return {text:JSON.stringify({status:"native_source_probe_failed"})};}});
}
`);
    const validated = spawnSync("claude", ["plugin", "validate", plugin], { cwd: root, encoding: "utf8", timeout: 10_000 });
    expect(validated.status).toBe(0);
    const run = spawnSync("claude", ["-p", "/dotbabel-source-proof", "--plugin-dir", plugin, "--no-session-persistence", "--output-format", "json", "--tools", ""], { cwd: root, encoding: "utf8", timeout: 30_000, maxBuffer: 1024 * 1024 });
    expect(run.error).toBeUndefined(); expect(run.status).toBe(0);
    const envelope = JSON.parse(run.stdout);
    // The CLI labels local command output before the command's one-line JSON payload.
    const payload = envelope.result.match(/\{"status":[^\n]*\}/);
    expect(payload).not.toBeNull();
    const result = JSON.parse(payload[0]);
    if (result.status === "skip") { console.info(JSON.stringify(result)); context.skip(); return; }
    expect(result).toMatchObject({ status: "ok", sourceId: "anthropic-models-api", availabilityFacts: 0 });
    expect(result.modelCount).toBeGreaterThan(0); expect(result.effortModelCount).toBeGreaterThan(0);
    expect(result.sourceVersion).toMatch(/^sha256:[a-f0-9]{32}$/);
    expect(envelope.num_turns).toBe(0); expect(envelope.duration_api_ms).toBe(0); expect(envelope.total_cost_usd).toBe(0);
    expect(envelope.usage.input_tokens).toBe(0); expect(envelope.usage.output_tokens).toBe(0); expect(envelope.modelUsage).toEqual({});
    const evidence = { runtimeVersion: version.stdout.match(/\d+\.\d+\.\d+/)?.[0], ...result, inferenceCalls: 0, credentialBoundary: "native-opaque-handle", runtimeAvailability: "not-claimed", turns: envelope.num_turns, apiDurationMs: envelope.duration_api_ms, costUsd: envelope.total_cost_usd, inputTokens: envelope.usage.input_tokens, outputTokens: envelope.usage.output_tokens };
    if (process.env.DOTBABEL_MODELS_EVIDENCE_PATH) fs.writeFileSync(process.env.DOTBABEL_MODELS_EVIDENCE_PATH, JSON.stringify(evidence, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    console.info(JSON.stringify(evidence));
  }, 55_000);
});
