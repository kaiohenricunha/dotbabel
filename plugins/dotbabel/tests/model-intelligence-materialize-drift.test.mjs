import { describe, it, expect } from "vitest";
import fs from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { hostname } from "node:os";
import { makeTempDir } from "./fixtures/temp-dir.mjs";
import { materializationFixture } from "./fixtures/model-intelligence/materialize.mjs";
import { materialize } from "../src/model-intelligence/materialize/index.mjs";
import { hashContent } from "../src/model-intelligence/materialize/manifest.mjs";
import { classifyDrift } from "../src/model-intelligence/materialize/drift.mjs";
import { syncProjectionTree, inspectProjectionTree } from "../src/model-intelligence/materialize/transaction.mjs";

const manifestName = ".dotbabel-projection.json";
const lockName = ".dotbabel-projection.lock";
const pendingName = ".dotbabel-projection.pending.json";
function fixture(label = "one") {
  const inputs = materializationFixture();
  inputs.artifacts[0].sourceContent += label + "\n";
  return inputs;
}
function setup(label = "one") {
  const root = makeTempDir("mi-projection-tree-");
  const inputs = fixture(label);
  return { root, loadInputs: () => structuredClone(inputs), inputs };
}
const readManifest = root => JSON.parse(fs.readFileSync(join(root, manifestName), "utf8"));

describe("projection drift classification", () => {
  it("classifies clean, user drift, stale, diverged, missing, and orphan from output and input hashes", () => {
    const previous = { outputHash: "old-output", inputsHash: "old-input" };
    const expected = { outputHash: "new-output", inputsHash: "old-input" };
    expect(classifyDrift({ previous, expected, outputHash: "old-output" })).toBe("clean");
    expect(classifyDrift({ previous, expected, outputHash: "edited" })).toBe("user-drift");
    expected.inputsHash = "new-input";
    expect(classifyDrift({ previous, expected, outputHash: "old-output" })).toBe("stale");
    expect(classifyDrift({ previous, expected, outputHash: "edited" })).toBe("diverged");
    expect(classifyDrift({ previous, expected })).toBe("missing");
    expect(classifyDrift({ previous, outputHash: "old-output" })).toBe("orphan");
    expect(classifyDrift({ expected, outputHash: "unowned" })).toBe("unowned");
    expect(classifyDrift({ expected })).toBe("missing");
  });
});

describe("projection filesystem transaction", () => {
  it("holds the projection-tree lock for the whole transaction and commits the manifest last", async () => {
    const options = setup(); const steps = [];
    const original = options.loadInputs;
    options.loadInputs = () => { expect(fs.existsSync(join(options.root, lockName))).toBe(true); return original(); };
    const result = await syncProjectionTree({ ...options, onStep: step => {
      expect(fs.existsSync(join(options.root, lockName))).toBe(true);
      if (step.kind === "file") expect(fs.existsSync(join(options.root, manifestName))).toBe(false);
      steps.push(step.kind);
    } });
    expect(result.status).toBe("synced");
    expect(steps.at(-1)).toBe("manifest");
    expect(readManifest(options.root)).toEqual(materialize(structuredClone(options.inputs)).manifest);
    expect(fs.existsSync(join(options.root, lockName))).toBe(false);
    expect(fs.existsSync(join(options.root, pendingName))).toBe(false);
  });
  it("an interrupted transaction is detected and repaired on the next run", async () => {
    const options = setup();
    await expect(syncProjectionTree({ ...options, onStep: step => { if (step.kind === "file") throw new Error("simulated interruption"); } })).rejects.toThrow();
    expect(fs.existsSync(join(options.root, pendingName))).toBe(true);
    expect((await inspectProjectionTree(options)).status).toBe("incomplete");
    expect((await syncProjectionTree(options)).status).toBe("synced");
    expect((await inspectProjectionTree(options)).status).toBe("clean");
    expect(fs.existsSync(join(options.root, pendingName))).toBe(false);
  });
  it("retires an interrupted projection when the next canonical generation removes its target", async () => {
    const options = setup();
    await expect(syncProjectionTree({ ...options, onStep: step => { if (step.kind === "file") throw new Error("interrupted"); } })).rejects.toThrow();
    options.inputs.artifacts = [];
    await syncProjectionTree(options);
    expect(fs.existsSync(join(options.root, "agents/example.md"))).toBe(false);
    expect(readManifest(options.root).entries).toEqual({});
  });
  it("a user-edited generated file is reported as drift and never read back as policy", async () => {
    const options = setup(); await syncProjectionTree(options);
    const file = join(options.root, "agents/example.md");
    fs.appendFileSync(file, "\ndotbabel: malicious generated policy\n");
    const result = await inspectProjectionTree(options);
    expect(result.entries).toContainEqual(expect.objectContaining({ path: "agents/example.md", state: "user-drift" }));
    const before = fs.readFileSync(file, "utf8");
    await expect(syncProjectionTree(options)).rejects.toThrow(/drift/);
    expect(fs.readFileSync(file, "utf8")).toBe(before);
    expect(options.loadInputs().artifacts[0].requirement.requirement).toBe("deep");
  });
  it("repairs missing files and stale canonical derivations without changing the canonical input", async () => {
    const options = setup(); await syncProjectionTree(options);
    fs.unlinkSync(join(options.root, "agents/example.md"));
    expect((await inspectProjectionTree(options)).entries[0].state).toBe("missing");
    await syncProjectionTree(options);
    options.inputs.artifacts[0].sourceContent += "canonical update\n";
    expect((await inspectProjectionTree(options)).entries[0].state).toBe("stale");
    const before = JSON.stringify(options.inputs); await syncProjectionTree(options);
    expect(JSON.stringify(options.inputs)).toBe(before);
    expect((await inspectProjectionTree(options)).status).toBe("clean");
  });
  it("removes only proven unchanged orphan projections", async () => {
    const options = setup(); await syncProjectionTree(options);
    options.inputs.artifacts = [];
    expect((await inspectProjectionTree(options)).entries[0].state).toBe("orphan");
    await syncProjectionTree(options);
    expect(fs.existsSync(join(options.root, "agents/example.md"))).toBe(false);
    expect(readManifest(options.root).entries).toEqual({});
  });
  it("refuses an existing file not proven Dotbabel-owned", async () => {
    const options = setup(); fs.mkdirSync(join(options.root, "agents"));
    const file = join(options.root, "agents/example.md"); fs.writeFileSync(file, "user owned\n");
    await expect(syncProjectionTree(options)).rejects.toThrow(/owned/);
    expect(fs.readFileSync(file, "utf8")).toBe("user owned\n");
    expect(fs.existsSync(join(options.root, manifestName))).toBe(false);
  });
  it("refuses edited orphans rather than deleting the user's edit", async () => {
    const options = setup(); await syncProjectionTree(options);
    const path = join(options.root, "agents/example.md"); fs.appendFileSync(path, "user edit");
    options.inputs.artifacts = [];
    await expect(syncProjectionTree(options)).rejects.toThrow(/drift/);
    expect(fs.readFileSync(path, "utf8")).toContain("user edit");
  });
  it("stale lock recovery requires a proven dead same-host owner", async () => {
    const options = setup();
    const owner = { token: "prior-owner", pid: 2147483647, host: hostname(), acquiredAt: new Date(Date.now() - 20 * 60_000).toISOString(), resource: "projection-tree" };
    fs.writeFileSync(join(options.root, lockName), JSON.stringify(owner));
    expect((await syncProjectionTree(options)).status).toBe("synced");
    fs.writeFileSync(join(options.root, lockName), JSON.stringify({ ...owner, host: "different-host" }));
    expect((await syncProjectionTree(options))).toMatchObject({ status: "busy", reason: "other_host" });
    expect(JSON.parse(fs.readFileSync(join(options.root, lockName), "utf8")).host).toBe("different-host");
  });
  it("file replacement while status reads produces drift instead of trusting the old path", async () => {
    const options = setup(); await syncProjectionTree(options);
    const file = join(options.root, "agents/example.md"); const temporary = join(options.root, "replacement");
    fs.writeFileSync(temporary, "user replacement\n");
    const result = await inspectProjectionTree({ ...options, loadInputs: () => {
      fs.renameSync(temporary, file); return structuredClone(options.inputs);
    } });
    expect(result.status).toBe("drift"); expect(result.entries[0].state).toBe("user-drift");
    expect(fs.readFileSync(file, "utf8")).toBe("user replacement\n");
  });
  it("never commits the manifest after an output changes before commit", async () => {
    const options = setup();
    await expect(syncProjectionTree({ ...options, onStep: step => {
      if (step.kind === "file") fs.appendFileSync(join(options.root, step.path), "concurrent user edit");
    } })).rejects.toThrow(/drift/);
    expect(fs.existsSync(join(options.root, manifestName))).toBe(false);
    await expect(syncProjectionTree(options)).rejects.toThrow(/drift/);
  });
  it.each(["../outside.md", "/absolute.md", "C:/outside.md", "agents\\outside.md"])("refuses a malicious manifest destination %s", async unsafe => {
    const options = setup(); await syncProjectionTree(options);
    const manifest = readManifest(options.root); manifest.entries[unsafe] = Object.values(manifest.entries)[0];
    fs.writeFileSync(join(options.root, manifestName), JSON.stringify(manifest));
    await expect(syncProjectionTree(options)).rejects.toThrow(/path|manifest/);
  });
  it("refuses a destination that leaves its owning root through a symlink", async () => {
    const options = setup(); const outside = makeTempDir("mi-projection-outside-");
    fs.symlinkSync(outside, join(options.root, "agents"));
    await expect(syncProjectionTree(options)).rejects.toThrow(/path|symlink/);
    expect(fs.readdirSync(outside)).toEqual([]);
  });
  it("does not follow a destination-file symlink or a manifest symlink", async () => {
    for (const target of ["agents/example.md", manifestName]) {
      const options = setup(); const outside = join(makeTempDir("mi-projection-outside-"), "untouched");
      fs.writeFileSync(outside, "outside"); fs.mkdirSync(join(options.root, "agents"));
      fs.symlinkSync(outside, join(options.root, target));
      await expect(syncProjectionTree(options)).rejects.toThrow(/path|symlink|manifest/);
      expect(fs.readFileSync(outside, "utf8")).toBe("outside");
    }
  });
  it("two equivalent syncs racing end in one coherent generation", async () => {
    const options = setup(); let release; const wait = new Promise(resolve => { release = resolve; });
    let entered; const ready = new Promise(resolve => { entered = resolve; });
    const first = syncProjectionTree({ ...options, loadInputs: async () => { entered(); await wait; return fixture(); } });
    await ready;
    expect((await syncProjectionTree(options)).status).toBe("busy");
    expect((await inspectProjectionTree(options)).status).toBe("busy");
    release(); expect((await first).status).toBe("synced");
    expect((await inspectProjectionTree(options)).status).toBe("clean");
  });
  it("two syncs with different canonical inputs never commit a mixed generation", async () => {
    const options = setup(); let release; const wait = new Promise(resolve => { release = resolve; });
    let entered; const ready = new Promise(resolve => { entered = resolve; });
    const first = syncProjectionTree({ ...options, loadInputs: async () => { entered(); await wait; return fixture("first"); } });
    await ready;
    const secondOptions = { root: options.root, loadInputs: () => fixture("second") };
    expect((await syncProjectionTree(secondOptions)).status).toBe("busy");
    release(); await first; await syncProjectionTree(secondOptions);
    const manifest = readManifest(options.root);
    expect(manifest).toEqual(materialize(fixture("second")).manifest);
    expect(manifest.entries["agents/example.md"].outputHash).toBe(hashContent(fs.readFileSync(join(options.root, "agents/example.md"), "utf8")));
  });
  it("project-sync p95 is at most 1.5 seconds over 10 warmed runs on the sync fixture with a warm cache and no network", async () => {
    const options = setup(); await syncProjectionTree(options); const times = [];
    for (let i = 0; i < 10; i++) { const start = performance.now(); await syncProjectionTree(options); times.push(performance.now() - start); }
    expect(times.sort((a, b) => a - b)[9]).toBeLessThanOrEqual(1500);
  });
});
