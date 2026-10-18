import { describe, it, expect, onTestFinished } from "vitest";
import fs from "node:fs";
import { join } from "node:path";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { makeTempDir } from "./fixtures/temp-dir.mjs";
import { materializationFixture } from "./fixtures/model-intelligence/materialize.mjs";
import { materialize } from "../src/model-intelligence/materialize/index.mjs";
import { hashContent } from "../src/model-intelligence/materialize/manifest.mjs";

const worker = fileURLToPath(new URL("./fixtures/model-intelligence/projection-worker.mjs", import.meta.url));
const execute = promisify(execFile);
async function waitForFile(file) {
  const deadline = Date.now() + 5000;
  while (!fs.existsSync(file)) {
    if (Date.now() > deadline) throw new Error("worker readiness timeout");
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
function paused(root, label) {
  const ready = join(root, "ready"); const release = join(root, "release");
  const child = spawn(process.execPath, [worker, root, label, ready, release], { stdio: ["ignore", "pipe", "pipe"] });
  let stdout = ""; child.stdout.on("data", data => { stdout += data; });
  const done = new Promise((resolve, reject) => { child.on("error", reject); child.on("exit", (code, signal) => resolve({ code, signal, stdout })); });
  onTestFinished(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); });
  return { child, done, ready, release };
}
async function run(root, label) {
  const { stdout } = await execute(process.execPath, [worker, root, label], { timeout: 8000 });
  return JSON.parse(stdout);
}
function assertGeneration(root, label) {
  const inputs = materializationFixture(); inputs.artifacts[0].sourceContent += label + "\n";
  const manifest = JSON.parse(fs.readFileSync(join(root, ".dotbabel-projection.json"), "utf8"));
  expect(manifest).toEqual(materialize(inputs).manifest);
  expect(manifest.entries["agents/example.md"].outputHash).toBe(hashContent(fs.readFileSync(join(root, "agents/example.md"), "utf8")));
}

describe("projection coordination across native processes", () => {
  it.each(["same", "different"])("serializes %s canonical inputs across independent processes", async kind => {
    const root = makeTempDir("mi-projection-process-"); const first = paused(root, "first");
    await waitForFile(first.ready);
    const next = kind === "same" ? "first" : "second";
    expect((await run(root, next)).status).toBe("busy");
    fs.writeFileSync(first.release, "release");
    expect((await first.done).code).toBe(0); assertGeneration(root, "first");
    expect((await run(root, next)).status).toBe("synced"); assertGeneration(root, next);
  });
  it("recovers a real killed process only after its lock becomes eligible", async () => {
    const root = makeTempDir("mi-projection-killed-"); const first = paused(root, "interrupted");
    await waitForFile(first.ready); first.child.kill("SIGKILL");
    expect((await first.done).signal).toBe("SIGKILL");
    expect((await run(root, "replacement")).status).toBe("busy");
    const lockPath = join(root, ".dotbabel-projection.lock"); const owner = JSON.parse(fs.readFileSync(lockPath, "utf8"));
    owner.acquiredAt = new Date(Date.now() - 20 * 60_000).toISOString();
    fs.writeFileSync(lockPath, JSON.stringify(owner));
    expect((await run(root, "replacement")).status).toBe("synced"); assertGeneration(root, "replacement");
    expect(fs.existsSync(join(root, ".dotbabel-projection.pending.json"))).toBe(false);
  });
});
