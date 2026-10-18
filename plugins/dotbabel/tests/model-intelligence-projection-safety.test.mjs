import { describe, it, expect, vi, afterEach } from "vitest";
import fs from "node:fs";
import childProcess from "node:child_process";
import { join } from "node:path";
import { makeTempDir } from "./fixtures/temp-dir.mjs";
import { materializationFixture } from "./fixtures/model-intelligence/materialize.mjs";
import { syncProjectionTree, inspectProjectionTree } from "../src/model-intelligence/materialize/transaction.mjs";
import { openProjectionTree } from "../src/model-intelligence/materialize/projection-fs.mjs";

afterEach(() => vi.restoreAllMocks());
function setup() {
  const root = makeTempDir("mi-projection-safety-"); const inputs = materializationFixture();
  return { root, inputs, loadInputs: () => structuredClone(inputs) };
}

describe("projection review safety regressions", () => {
  it("refuses malformed UTF-8 instead of treating replacement decoding as unchanged content", () => {
    const root = makeTempDir("mi-invalid-projection-");
    fs.writeFileSync(join(root, "edited.md"), Buffer.from([0xff]));
    const tree = openProjectionTree(root);
    try { expect(() => tree.write("edited.md", "new", { expected: "\ufffd" })).toThrow(/path_unsafe/); }
    finally { tree.close(); }
    expect(fs.readFileSync(join(root, "edited.md"))).toEqual(Buffer.from([0xff]));
  });
  it("rejects an ancestor symlink introduced during owning-root acquisition", () => {
    const base = makeTempDir("mi-root-acquisition-");
    const project = join(base, "selected/project"); const root = join(project, "tree");
    const outside = join(base, "outside"); fs.mkdirSync(root, { recursive: true });
    fs.mkdirSync(join(outside, "tree"), { recursive: true });
    const originalOpen = fs.openSync; let swapped = false;
    vi.spyOn(fs, "openSync").mockImplementation((file, ...args) => {
      if (!swapped && (file === root || String(file).endsWith("/project"))) {
        swapped = true; fs.renameSync(project, project + ".saved"); fs.symlinkSync(outside, project);
      }
      return originalOpen(file, ...args);
    });
    let failure;
    try { const tree = openProjectionTree(root); try { tree.write("escaped.md", "outside write"); } finally { tree.close(); } }
    catch (error) { failure = error; }
    expect(swapped).toBe(true);
    expect(failure?.code).toBe("projection_path_unsafe");
    expect(fs.readdirSync(join(outside, "tree"))).toEqual([]);
  });
  it("preserves a user edit made while the new output is being fsynced", async () => {
    const options = setup(); await syncProjectionTree(options);
    const file = join(options.root, "agents/example.md"); const before = fs.readFileSync(file, "utf8");
    const manifest = fs.readFileSync(join(options.root, ".dotbabel-projection.json"), "utf8");
    options.inputs.artifacts[0].sourceContent += "canonical update\n";
    const originalFsync = fs.fsyncSync; let edited = false;
    vi.spyOn(fs, "fsyncSync").mockImplementation(fd => {
      const target = fs.readlinkSync(`/proc/self/fd/${fd}`);
      if (!edited && target.includes("example.md.") && target.endsWith(".tmp")) {
        edited = true; fs.appendFileSync(file, "user edit during replacement\n");
      }
      return originalFsync(fd);
    });
    await expect(syncProjectionTree(options)).rejects.toThrow(/drift|conflict/);
    expect(edited).toBe(true);
    expect(fs.readFileSync(file, "utf8")).toBe(before + "user edit during replacement\n");
    expect(fs.readFileSync(join(options.root, ".dotbabel-projection.json"), "utf8")).toBe(manifest);
  });
  it.each([false, true])("recovers changed inputs after a second journal interruption (committed base %s)", async committed => {
    const options = setup();
    if (committed) { await syncProjectionTree(options); options.inputs.artifacts[0].sourceContent += "second\n"; }
    await expect(syncProjectionTree({ ...options, onStep: step => { if (step.kind === "file") throw new Error("first interruption"); } })).rejects.toThrow();
    options.inputs.artifacts[0].sourceContent += "replacement generation\n";
    const originalUnlink = fs.unlinkSync; let interrupted = false;
    const spy = vi.spyOn(fs, "unlinkSync").mockImplementation(file => {
      if (!interrupted && String(file).includes(".dotbabel-projection.pending.json.") && String(file).endsWith(".tmp")) {
        interrupted = true;
        try { originalUnlink(file); } catch (error) { if (error.code !== "ENOENT") throw error; }
        throw new Error("interruption after journal publication");
      }
      return originalUnlink(file);
    });
    await expect(syncProjectionTree(options)).rejects.toThrow();
    expect(interrupted).toBe(true); spy.mockRestore();
    expect((await syncProjectionTree(options)).status).toBe("synced");
    expect((await inspectProjectionTree(options)).status).toBe("clean");
  });
  it("retires all prior pending orphans after interruption during recovery", async () => {
    const options = setup(); const original = options.inputs.artifacts[0];
    options.inputs.artifacts = ["a.md", "b.md"].map(path => ({ ...structuredClone(original), target: { ...original.target, path } }));
    await expect(syncProjectionTree({ ...options, onStep: step => { if (step.path === "b.md") throw new Error("first interruption"); } })).rejects.toThrow();
    options.inputs.artifacts = [{ ...structuredClone(original), target: { ...original.target, path: "z.md" } }];
    await expect(syncProjectionTree({ ...options, onStep: step => { if (step.path === "a.md") throw new Error("recovery interruption"); } })).rejects.toThrow();
    await syncProjectionTree(options);
    expect(fs.existsSync(join(options.root, "a.md"))).toBe(false);
    expect(fs.existsSync(join(options.root, "b.md"))).toBe(false);
    expect((await inspectProjectionTree(options)).status).toBe("clean");
  });
  it("fails closed and retains both files when atomic exchange is unavailable", () => {
    const root = makeTempDir("mi-exchange-unavailable-"); const file = join(root, "owned.md");
    fs.writeFileSync(file, "original user bytes");
    vi.spyOn(childProcess, "spawnSync").mockReturnValue({ status: 2 });
    const tree = openProjectionTree(root);
    try { expect(() => tree.write("owned.md", "replacement", { expected: "original user bytes" })).toThrow(/atomic_exchange_unavailable/); }
    finally { tree.close(); }
    expect(fs.readFileSync(file, "utf8")).toBe("original user bytes");
    const retained = fs.readdirSync(root).filter(name => name.endsWith(".tmp"));
    expect(retained).toHaveLength(1);
    expect(fs.readFileSync(join(root, retained[0]), "utf8")).toBe("replacement");
  });
  it("restores and retains an orphan edited at the actual removal boundary", async () => {
    const options = setup(); await syncProjectionTree(options);
    const file = join(options.root, "agents/example.md"); const before = fs.readFileSync(file, "utf8");
    options.inputs.artifacts = [];
    const originalRename = fs.renameSync; let edited = false;
    vi.spyOn(fs, "renameSync").mockImplementation((source, destination) => {
      if (!edited && String(source).endsWith("/example.md")) { edited = true; fs.appendFileSync(file, "user edit before removal\n"); }
      return originalRename(source, destination);
    });
    await expect(syncProjectionTree(options)).rejects.toThrow(/drift/);
    expect(edited).toBe(true);
    expect(fs.readFileSync(file, "utf8")).toBe(before + "user edit before removal\n");
    const backup = fs.readdirSync(join(options.root, "agents")).find(name => name.endsWith(".tmp"));
    expect(fs.readFileSync(join(options.root, "agents", backup), "utf8")).toBe(before + "user edit before removal\n");
  });
  it.each(["../escaped.md", "agents/../../escaped.md"])("rejects an unsafe retained ownership path %s", async unsafe => {
    const options = setup();
    await expect(syncProjectionTree({ ...options, onStep: () => { throw new Error("interruption"); } })).rejects.toThrow();
    const file = join(options.root, ".dotbabel-projection.pending.json");
    const pending = JSON.parse(fs.readFileSync(file, "utf8"));
    pending.retainedEntries = { [unsafe]: Object.values(pending.entries)[0] };
    fs.writeFileSync(file, JSON.stringify(pending));
    await expect(syncProjectionTree(options)).rejects.toThrow(/manifest_invalid/);
    await expect(inspectProjectionTree(options)).rejects.toThrow(/manifest_invalid/);
  });
  it("reports busy when a pending journal appears during read-only inspection", async () => {
    const options = setup(); await syncProjectionTree(options);
    const originalOpen = fs.openSync; let reads = 0;
    vi.spyOn(fs, "openSync").mockImplementation((file, ...args) => {
      if (String(file).endsWith("/.dotbabel-projection.pending.json") && ++reads === 2) {
        fs.writeFileSync(join(options.root, ".dotbabel-projection.pending.json"), "concurrent incomplete write\n");
      }
      return originalOpen(file, ...args);
    });
    expect((await inspectProjectionTree(options)).status).toBe("busy");
  });
});
