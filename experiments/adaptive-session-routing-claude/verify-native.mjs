/** Controlled native proof. Metadata is zero-inference; --live attempts one ordinary MAIN prompt. */
import { mkdtemp, mkdir, writeFile, copyFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { runClaudeTerminal } from "../../plugins/dotbabel/src/adaptive-session-routing/claude-launcher.mjs";

const live = process.argv.includes("--live");
// --out <file> keeps concurrent runs apart; the default paths stay for the documented manual steps.
const outIndex = process.argv.indexOf("--out");
const out = outIndex === -1 ? undefined : process.argv[outIndex + 1];
const root = await mkdtemp(join(tmpdir(), "dotbabel-claude-proof-"));
const prompt = "Format the supplied JSON with two-space indentation. Return only JSON: {\"proof\":true}";
let recording;
try {
  execFileSync("git", ["init", "--quiet", root], { stdio: "pipe" });
  await writeFile(join(root, ".dotbabel.json"), JSON.stringify({ model_intelligence: { enabled: true, adaptive_routing: { enabled: true } } }));
  const code = await runClaudeTerminal({ repoRoot: root, model: "auto", effort: "auto" }, { startNative: async ({ args, cwd, socketPath }) => {
    let input = prompt;
    if (!live) {
      const auxiliary = join(root, "metadata-plugin");
      await mkdir(join(auxiliary, ".claude-plugin"), { recursive: true }); await mkdir(join(auxiliary, "hooks"));
      await writeFile(join(auxiliary, ".claude-plugin/plugin.json"), JSON.stringify({ name: "dotbabel-routing-metadata-proof", version: "0.1.0", description: "Zero-inference production bridge proof", author: { name: "dotbabel" } }));
      await writeFile(join(auxiliary, "hooks/hooks.json"), JSON.stringify({ modules: ["./register.js"] }));
      await copyFile(new URL("../../plugins/dotbabel/src/adaptive-session-routing/claude-mod-prepare.mjs", import.meta.url), join(auxiliary, "hooks/claude-mod-prepare.mjs"));
      const options = { socketPath, state: {}, manual: { model: { source: "inherited" }, reasoning: { source: "inherited" } } };
      const module = `import { prepareClaudeRoute } from './claude-mod-prepare.mjs';
export function register(on) {
  on('session.start',async($,e,next)=>{await $.command.register({name:'routing-metadata-proof',description:'Inspect the production local bridge without inference'});return next(e)});
  on('command.run',{command:'routing-metadata-proof'},async($)=>{
    const request={repoRoot:await $.session.root(),prompt:${JSON.stringify(prompt)},current:{axes:{model:await $.session.model()},turnExecuted:false},manual:${JSON.stringify(options.manual)}};
    const decision=await prepareClaudeRoute($,request,${JSON.stringify(options)});
    return {text:JSON.stringify({kind:'production-routing-metadata-only',decision,effective:{state:'unknown'}})};
  });
  on('turn.step',async function*(){throw Error('Metadata verification forbids inference')});
}
`;
      await writeFile(join(auxiliary, "hooks/register.js"), module);
      args.push("--plugin-dir", auxiliary); input = "/routing-metadata-proof";
    }
    return await new Promise((resolve, reject) => {
      const child = spawn("claude", [...args, "-p", input, "--output-format", "stream-json", "--verbose", "--no-session-persistence", "--tools", ""], { cwd, stdio: ["ignore", "pipe", "pipe"], shell: false });
      let stdout = "", stderr = "";
      const timer = setTimeout(() => child.kill("SIGTERM"), 60000);
      child.stdout.on("data", bytes => { stdout += bytes; }); child.stderr.on("data", bytes => { stderr += bytes; });
      child.once("error", reject);
      child.once("close", code => { clearTimeout(timer); recording = { code, stdout, stderr }; resolve(code ?? 143); });
    });
  } });
  const events = recording.stdout.split("\n").filter(Boolean).map(line => { try { return JSON.parse(line); } catch { return undefined; } }).filter(Boolean);
  const result = events.findLast(event => event.type === "result");
  const proof = { mode: live ? "native-main-ordinary-prompt-attempt" : "native-production-metadata-only", code, result, stderr: recording.stderr, observations: events.filter(event => event.type === "system" && event.subtype !== "init") };
  if (!live && (result?.duration_api_ms !== 0 || result?.total_cost_usd !== 0 || Object.keys(result?.modelUsage ?? {}).length)) throw Error("Metadata proof unexpectedly executed inference");
  const destination = out ?? (live ? "/tmp/ar-claude-main-native-live.json" : "/tmp/ar-claude-main-native-metadata.json");
  await writeFile(destination, JSON.stringify(proof, null, 2) + "\n");
  console.log(JSON.stringify({ mode: proof.mode, code, file: destination, numTurns: result?.num_turns, apiMs: result?.duration_api_ms, cost: result?.total_cost_usd, result: result?.result, errors: result?.errors }));
} finally { await rm(root, { recursive: true, force: true }); }
