/**
 * Effort discrimination probe: does a Mods `turn.step` effort override change the request?
 *
 * One ordinary prompt runs repeatedly with the model pinned and the session effort unchanged. A
 * private plugin rewrites only `turn.step`'s `effort` to `low` or `high`, alternating, and logs the
 * native request's own effort before the rewrite. If the override applies, thinking tokens differ by
 * group; if it is ignored, they do not. This spends real inference: one paid turn per run.
 *
 * Usage: node experiments/adaptive-session-routing-claude/effort-probe.mjs <runs-per-group> <out.json>
 */
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, execFileSync } from "node:child_process";

const [runsArg = "6", out = "effort-probe.json"] = process.argv.slice(2);
const runs = Number(runsArg);
const prompt = "How many distinct ways can a 2x12 board be tiled with 1x2 dominoes? Think it through, then answer with the number only.";
const version = execFileSync("claude", ["--version"], { encoding: "utf8" }).trim();

async function plugin(effort) {
  const dir = await mkdtemp(join(tmpdir(), "dotbabel-effort-probe-"));
  await mkdir(join(dir, ".claude-plugin")); await mkdir(join(dir, "hooks"));
  await writeFile(join(dir, ".claude-plugin/plugin.json"), JSON.stringify({ name: "dotbabel-effort-probe", version: "0.1.0", description: "Effort override probe", author: { name: "dotbabel" } }));
  await writeFile(join(dir, "hooks/hooks.json"), JSON.stringify({ modules: ["./register.js"] }));
  await writeFile(join(dir, "hooks/register.js"), `export function register(on) {
  on("turn.step", async function* ($, e, next) {
    if (e.agentId !== undefined) return yield* next(e);
    $.ui.log(JSON.stringify({ probe: "request", nativeEffort: e.effort ?? null, model: e.model ?? null, override: ${JSON.stringify(effort)} }));
    const result = yield* next({ ...e, effort: ${JSON.stringify(effort)} });
    $.ui.log(JSON.stringify({ probe: "result", usageModel: result.usage?.model ?? null }));
    return result;
  });
}
`);
  return dir;
}

async function once(effort) {
  const work = await mkdtemp(join(tmpdir(), "dotbabel-effort-work-"));
  execFileSync("git", ["init", "--quiet", work]);
  const dir = await plugin(effort);
  try {
    const recording = await new Promise((resolve, reject) => {
      const child = spawn("claude", ["--plugin-dir", dir, "--model", "haiku", "-p", prompt, "--output-format", "stream-json", "--verbose", "--no-session-persistence", "--tools", ""], { cwd: work, stdio: ["ignore", "pipe", "pipe"] });
      let stdout = ""; child.stdout.on("data", (b) => { stdout += b; });
      const timer = setTimeout(() => child.kill("SIGTERM"), 180000);
      child.once("error", reject);
      child.once("close", (code) => { clearTimeout(timer); resolve({ code, stdout }); });
    });
    const events = recording.stdout.split("\n").filter(Boolean).map((line) => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
    const result = events.findLast((event) => event.type === "result");
    const logs = events.filter((event) => event.subtype === "ui_log" && event.plugin === "dotbabel-effort-probe").map((event) => JSON.parse(event.text));
    const usage = Object.values(result?.modelUsage ?? {})[0] ?? {};
    return { effort, code: recording.code, answer: result?.result?.trim(), model: Object.keys(result?.modelUsage ?? {})[0] ?? null, thinkingTokens: usage.thinkingTokens ?? null, outputTokens: usage.outputTokens ?? null, costUSD: result?.total_cost_usd ?? null, durationApiMs: result?.duration_api_ms ?? null, probe: logs };
  } finally { await rm(dir, { recursive: true, force: true }); await rm(work, { recursive: true, force: true }); }
}

const rows = [];
for (let i = 0; i < runs; i += 1) for (const effort of ["low", "high"]) { rows.push(await once(effort)); process.stderr.write(`${rows.length}/${runs * 2}\n`); }
const stats = (effort) => { const values = rows.filter((row) => row.effort === effort && Number.isFinite(row.thinkingTokens)).map((row) => row.thinkingTokens).sort((a, b) => a - b); return { n: values.length, values, median: values.length ? values[Math.floor(values.length / 2)] : null }; };
const summary = { version, prompt, runsPerGroup: runs, low: stats("low"), high: stats("high"), totalCostUSD: rows.reduce((sum, row) => sum + (row.costUSD ?? 0), 0) };
await writeFile(out, JSON.stringify({ summary, rows }, null, 2) + "\n");
console.log(JSON.stringify(summary));
