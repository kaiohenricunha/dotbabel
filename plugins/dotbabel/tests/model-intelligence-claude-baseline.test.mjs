import { describe, expect, it } from "vitest";
import fs from "node:fs";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { makeTempDir } from "./fixtures/temp-dir.mjs";
import { claudeProjectionFixture } from "./fixtures/model-intelligence/claude-projection.mjs";
import { materializeClaude } from "../src/model-intelligence/materialize/runtime/claude.mjs";
import { installClaudeBaseline } from "../src/model-intelligence/materialize/runtime/claude-baseline.mjs";
import { bootstrapGlobal } from "../src/bootstrap-global.mjs";
import { acquireLock } from "../src/lib/process-lock.mjs";

function setup() {
  const source = makeTempDir("mi-claude-source-"); const target = makeTempDir("mi-claude-target-");
  const fixtures = ["agent", "command", "skill"].map(kind => claudeProjectionFixture(kind));
  const inputs = { ...fixtures[0], artifacts: fixtures.flatMap(item => item.artifacts) };
  const write = () => {
    const batch = materializeClaude(inputs); const root = join(source, "plugins/dotbabel/templates/claude");
    for (const artifact of inputs.artifacts) {
      fs.mkdirSync(join(source, artifact.sourcePath, ".."), { recursive: true });
      fs.writeFileSync(join(source, artifact.sourcePath), artifact.sourceContent);
    }
    for (const file of batch.files) { fs.mkdirSync(join(root, file.path, ".."), { recursive: true }); fs.writeFileSync(join(root, file.path), file.content); }
    fs.writeFileSync(join(root, ".dotbabel-projection.json"), JSON.stringify(batch.manifest));
    return batch;
  };
  return { source, target, inputs, write };
}

describe("Claude release baseline installation", () => {
  it("recovers an interrupted owned companion transition into a third release", async () => {
    const first = setup(); first.write(); fs.writeFileSync(join(first.source, "skills/example-skill/reference.md"), "A");
    await installClaudeBaseline(first);
    const second = setup(); second.write(); fs.writeFileSync(join(second.source, "skills/example-skill/reference.md"), "B");
    await expect(installClaudeBaseline({ ...second, target: first.target, onStep: step => {
      if (step.kind === "companion") throw new Error("companion interruption");
    } })).rejects.toThrow(/companion interruption/);
    const third = setup(); third.write(); fs.writeFileSync(join(third.source, "skills/example-skill/reference.md"), "C");
    await installClaudeBaseline({ ...third, target: first.target });
    expect(fs.readFileSync(join(first.target, "skills/example-skill/reference.md"), "utf8")).toBe("C");
  });
  it("holds the shared lock through companion installation and identical-batch refresh", async () => {
    const options = setup(); options.write(); fs.writeFileSync(join(options.source, "skills/example-skill/reference.md"), "A");
    let observed = 0;
    const onStep = step => {
      if (step.kind !== "companion") return;
      const lock = acquireLock(join(options.target, ".dotbabel-projection.lock"), { resource: "test" });
      if (lock.acquired) lock.release();
      expect(lock.acquired).toBe(false); observed++;
    };
    await installClaudeBaseline({ ...options, onStep }); await installClaudeBaseline({ ...options, onStep });
    expect(observed).toBe(2);
  });
  it("does not adopt an unowned link that resembles an earlier release", async () => {
    const first = setup(); first.write(); fs.writeFileSync(join(first.source, "skills/example-skill/reference.md"), "A");
    const reference = join(first.target, "skills/example-skill/reference.md"); fs.mkdirSync(join(reference, ".."), { recursive: true });
    fs.symlinkSync(join(first.source, "skills/example-skill/reference.md"), reference);
    await installClaudeBaseline(first);
    const second = setup(); second.write(); fs.writeFileSync(join(second.source, "skills/example-skill/reference.md"), "B");
    await installClaudeBaseline({ ...second, target: first.target });
    expect(fs.readlinkSync(reference)).toBe(join(first.source, "skills/example-skill/reference.md"));
  });
  it.each(["malformed", "version", "array", "path", "projection", "target", "extra-key", "pending"])("refuses %s companion ownership without changing a user asset", async fault => {
    const options = setup(); options.write(); fs.writeFileSync(join(options.source, "skills/example-skill/reference.md"), "A");
    const reference = join(options.target, "skills/example-skill/reference.md"); fs.mkdirSync(join(reference, ".."), { recursive: true }); fs.writeFileSync(reference, "user bytes");
    const ledger = { schemaVersion: 1, links: { "skills/example-skill/reference.md": { current: "/old/reference.md" } } };
    if (fault === "version") ledger.schemaVersion = 2;
    if (fault === "array") ledger.links = [];
    if (fault === "path") ledger.links = { "../outside": { current: "/old" } };
    if (fault === "projection") ledger.links = { "skills/example-skill/SKILL.md": { current: "/old" } };
    if (fault === "target") ledger.links["skills/example-skill/reference.md"].current = "relative";
    if (fault === "extra-key") ledger.links["skills/example-skill/reference.md"].other = true;
    if (fault === "pending") ledger.links["skills/example-skill/reference.md"].pending = "relative";
    fs.writeFileSync(join(options.target, ".dotbabel-claude-companions.json"), fault === "malformed" ? "{" : JSON.stringify(ledger));
    await expect(installClaudeBaseline(options)).rejects.toMatchObject({ code: "claude_companion_ownership_invalid" });
    expect(fs.readFileSync(reference, "utf8")).toBe("user bytes");
  });
  it("refuses a sibling destination through a symlink alias before initial installation", async () => {
    const options = setup(); options.write(); const alias = join(makeTempDir("mi-runtime-alias-"), "alias"); fs.symlinkSync(options.target, alias);
    const previous = process.env.CODEX_HOME; process.env.CODEX_HOME = alias;
    try {
      await expect(bootstrapGlobal({ ...options, projections: true, allCli: true, quiet: true })).rejects.toThrow(/overlap/);
      expect(fs.readdirSync(options.target)).toEqual([]);
    } finally { if (previous === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previous; }
  });
  it("updates owned companion links across source roots even with an identical generated batch", async () => {
    const first = setup(); first.write();
    fs.writeFileSync(join(first.source, "skills/example-skill/reference.md"), "release A\n");
    await installClaudeBaseline(first);
    const second = setup(); second.write();
    fs.writeFileSync(join(second.source, "skills/example-skill/reference.md"), "release B\n");
    await installClaudeBaseline({ ...second, target: first.target });
    const reference = join(first.target, "skills/example-skill/reference.md");
    expect(fs.readlinkSync(reference)).toBe(join(second.source, "skills/example-skill/reference.md"));
    expect(fs.readFileSync(reference, "utf8")).toBe("release B\n");
  });
  it("preserves a changed user link during a source-root upgrade", async () => {
    const first = setup(); first.write();
    fs.writeFileSync(join(first.source, "skills/example-skill/reference.md"), "release A\n");
    await installClaudeBaseline(first);
    const reference = join(first.target, "skills/example-skill/reference.md");
    const user = join(makeTempDir("mi-user-reference-"), "reference.md"); fs.writeFileSync(user, "user bytes\n");
    fs.unlinkSync(reference); fs.symlinkSync(user, reference);
    const second = setup(); second.write(); fs.writeFileSync(join(second.source, "skills/example-skill/reference.md"), "release B\n");
    await installClaudeBaseline({ ...second, target: first.target });
    expect(fs.readlinkSync(reference)).toBe(user);
    expect(fs.readFileSync(reference, "utf8")).toBe("user bytes\n");
  });
  it.each(["skills", "commands"])("refuses a sibling runtime alias into protected %s before any writes", async kind => {
    const options = setup(); options.write();
    await installClaudeBaseline(options);
    // The command wrapper shares the generated skill slug to expose that collision too.
    if (kind === "commands") {
      fs.copyFileSync(join(options.source, "commands/example-command.md"), join(options.source, "commands/example-skill.md"));
      fs.rmSync(join(options.source, "skills"), { recursive: true });
    }
    const previous = process.env.CODEX_HOME;
    process.env.CODEX_HOME = options.target;
    try {
      const before = fs.readFileSync(join(options.target, "skills/example-skill/SKILL.md"), "utf8");
      await expect(bootstrapGlobal({ ...options, allCli: true, quiet: true })).rejects.toThrow(/overlap/);
      expect(fs.readFileSync(join(options.target, "skills/example-skill/SKILL.md"), "utf8")).toBe(before);
      expect(fs.lstatSync(join(options.target, "skills/example-skill")).isDirectory()).toBe(true);
    } finally { if (previous === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previous; }
  });
  it("copies a verified generated release batch and replaces only manifest-owned outputs", async () => {
    const options = setup(); const first = options.write();
    expect((await installClaudeBaseline(options)).status).toBe("synced");
    for (const file of first.files) { expect(fs.lstatSync(join(options.target, file.path)).isFile()).toBe(true); expect(fs.readFileSync(join(options.target, file.path), "utf8")).toBe(file.content); }
    options.inputs.artifacts[0].sourceContent += "release update\n";
    const second = options.write(); await installClaudeBaseline(options);
    expect(fs.readFileSync(join(options.target, second.files.find(file => file.path.startsWith("agents/")).path), "utf8")).toContain("release update\n");
    expect(JSON.parse(fs.readFileSync(join(options.target, ".dotbabel-projection.json"), "utf8"))).toEqual(second.manifest);
  });
  it("bootstrap explicitly installs generated copies and later plain bootstrap preserves them", async () => {
    const options = setup(); const first = options.write();
    expect((await bootstrapGlobal({ ...options, projections: true, quiet: true })).ok).toBe(true);
    for (const file of first.files) {
      expect(fs.lstatSync(join(options.target, file.path)).isSymbolicLink()).toBe(false);
      expect(fs.readFileSync(join(options.target, file.path), "utf8")).toBe(file.content);
    }
    expect((await bootstrapGlobal({ ...options, quiet: true })).ok).toBe(true);
    expect(fs.lstatSync(join(options.target, "skills/example-skill")).isSymbolicLink()).toBe(false);
    expect(fs.lstatSync(join(options.target, "commands/example-command.md")).isSymbolicLink()).toBe(false);
  });
  it("plain first bootstrap keeps legacy links and creates no projection state", async () => {
    const options = setup(); options.write();
    expect((await bootstrapGlobal({ ...options, quiet: true })).ok).toBe(true);
    expect(fs.lstatSync(join(options.target, "skills/example-skill")).isSymbolicLink()).toBe(true);
    expect(fs.lstatSync(join(options.target, "commands/example-command.md")).isSymbolicLink()).toBe(true);
    expect(fs.existsSync(join(options.target, ".dotbabel-projection.json"))).toBe(false);
    expect(fs.existsSync(join(options.target, ".dotbabel-projection.pending.json"))).toBe(false);
  });
  it("plain bootstrap refuses an interrupted generation before invoking legacy writers", async () => {
    const options = setup(); options.write();
    await expect(installClaudeBaseline({ ...options, onStep: () => { throw new Error("interruption"); } })).rejects.toThrow();
    const file = join(options.target, "agents/example.md"); const before = fs.readFileSync(file, "utf8");
    await expect(bootstrapGlobal({ ...options, quiet: true })).rejects.toThrow(/incomplete/);
    expect(fs.readFileSync(file, "utf8")).toBe(before);
    expect(fs.existsSync(join(options.target, "commands/example-command.md"))).toBe(false);
  });
  it("plain bootstrap respects a held projection transaction lock", async () => {
    const options = setup(); options.write();
    const lock = acquireLock(join(options.target, ".dotbabel-projection.lock"), { resource: "test" });
    expect(lock.acquired).toBe(true);
    try {
      await expect(bootstrapGlobal({ ...options, quiet: true })).rejects.toThrow(/busy/);
      expect(fs.existsSync(join(options.target, "commands/example-command.md"))).toBe(false);
    } finally { lock.release(); }
  });
  it("a real plain shell bootstrap excludes a concurrent Node projection install", async () => {
    const options = setup(); options.write(); const root = makeTempDir("mi-bootstrap-race-");
    const home = join(root, "home"); const bin = join(root, "bin"); fs.mkdirSync(bin); fs.mkdirSync(home);
    const ready = join(root, "ready"); const release = join(root, "release"); const probed = join(root, "probed");
    fs.writeFileSync(join(bin, "ln"), '#!/bin/bash\nprintf ready > "$MI_READY"\nfor attempt in {1..500}; do [[ -e "$MI_RELEASE" ]] && break; sleep 0.01; done\nexec /bin/ln "$@"\n', { mode: 0o755 });
    // Without --all, a host without copilot runs `gh copilot --version`, which downloads and
    // unpacks the Copilot CLI into this HOME while the test runs. This stub records such a probe.
    fs.writeFileSync(join(bin, "gh"), '#!/bin/bash\nprintf probed > "$MI_PROBED"\n', { mode: 0o755 });
    const env = { PATH: bin + ":" + process.env.PATH, HOME: home, MI_READY: ready, MI_RELEASE: release, MI_PROBED: probed };
    const boot = new URL("../../../bootstrap.sh", import.meta.url).pathname;
    const cli = new URL("../bin/dotbabel-bootstrap.mjs", import.meta.url).pathname;
    const child = spawn("bash", [boot, "--source", options.source, "--all", "--quiet"], { env, stdio: "ignore" });
    const completed = new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", code => resolve(code)); });
    try {
      const deadline = Date.now() + 5000;
      while (!fs.existsSync(ready) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
      expect(fs.existsSync(ready)).toBe(true);
      expect(fs.lstatSync(join(home, ".claude/.dotbabel-projection.lock")).isDirectory()).toBe(true);
      const blocked = spawnSync(process.execPath, [cli, "--source", options.source, "--target", join(home, ".claude"), "--projections", "--quiet"], { env, encoding: "utf8", timeout: 5000 });
      expect(blocked.status).toBe(2);
      expect(blocked.stdout + blocked.stderr).toMatch(/busy/);
      expect(fs.existsSync(join(home, ".claude/.dotbabel-projection.json"))).toBe(false);
    } finally {
      fs.writeFileSync(release, "release");
      const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
      try { expect(await completed).toBe(0); } finally { clearTimeout(timer); }
    }
    expect(fs.existsSync(join(home, ".claude/.dotbabel-projection.lock"))).toBe(false);
    expect(fs.existsSync(probed)).toBe(false);
  }, 15_000);
  it("recovers an interrupted release installation using a complete new release generation", async () => {
    const options = setup(); options.write();
    await expect(installClaudeBaseline({ ...options, onStep: step => { if (step.kind === "file") throw new Error("interrupted release"); } })).rejects.toThrow(/interrupted/);
    options.inputs.artifacts.forEach(artifact => { artifact.sourceContent += "replacement release\n"; });
    const expected = options.write(); await installClaudeBaseline(options);
    for (const file of expected.files) expect(fs.readFileSync(join(options.target, file.path), "utf8")).toBe(file.content);
    expect(fs.existsSync(join(options.target, ".dotbabel-projection.pending.json"))).toBe(false);
  });
  it("rejects a source projection symlink without following it or touching output", async () => {
    const options = setup(); const batch = options.write();
    const file = join(options.source, "plugins/dotbabel/templates/claude", batch.files[0].path);
    const outside = join(makeTempDir("mi-baseline-symlink-"), "file"); fs.writeFileSync(outside, "private outside bytes\n");
    fs.unlinkSync(file); fs.symlinkSync(outside, file);
    await expect(installClaudeBaseline(options)).rejects.toThrow(/path/);
    expect(fs.readFileSync(outside, "utf8")).toBe("private outside bytes\n");
    expect(fs.readdirSync(options.target)).toEqual([]);
  });
  it("leaves user-owned files untouched when no ownership manifest proves the file", async () => {
    const options = setup(); options.write(); fs.mkdirSync(join(options.target, "agents"));
    const file = join(options.target, "agents/example.md"); fs.writeFileSync(file, "my personal agent\n");
    await expect(installClaudeBaseline(options)).rejects.toThrow(/owned/);
    expect(fs.readFileSync(file, "utf8")).toBe("my personal agent\n");
    expect(fs.existsSync(join(options.target, "commands/example-command.md"))).toBe(false);
  });
  it("refuses an edited owned projection and preserves the user's exact content", async () => {
    const options = setup(); options.write(); await installClaudeBaseline(options);
    const file = join(options.target, "skills/example-skill/SKILL.md"); fs.appendFileSync(file, "my edit\n");
    const edited = fs.readFileSync(file, "utf8");
    options.inputs.artifacts[0].sourceContent += "new version\n"; options.write();
    await expect(installClaudeBaseline(options)).rejects.toThrow(/drift/);
    expect(fs.readFileSync(file, "utf8")).toBe(edited);
    expect(fs.readFileSync(join(options.target, "agents/example.md"), "utf8")).not.toContain("new version\n");
  });
  it("validates the release's content hashes before touching an output", async () => {
    const options = setup(); const batch = options.write();
    fs.appendFileSync(join(options.source, "plugins/dotbabel/templates/claude", batch.files[0].path), "tampered\n");
    await expect(installClaudeBaseline(options)).rejects.toThrow(/batch|baseline|hash/);
    expect(fs.readdirSync(options.target)).toEqual([]);
  });
  it("does nothing when the source has no generated baseline manifest", async () => {
    const source = makeTempDir("mi-no-claude-baseline-"); const target = join(source, "not-created");
    const result = await installClaudeBaseline({ source, target });
    expect(result.status).toBe("absent"); expect(fs.existsSync(target)).toBe(false);
  });
  it("refuses an unowned skill directory symlink instead of changing its target", async () => {
    const options = setup(); options.write(); const outside = makeTempDir("mi-user-skill-");
    fs.mkdirSync(join(options.target, "skills")); fs.symlinkSync(outside, join(options.target, "skills/example-skill"));
    await expect(installClaudeBaseline(options)).rejects.toThrow(/path|owned/);
    expect(fs.readdirSync(outside)).toEqual([]);
    expect(fs.lstatSync(join(options.target, "skills/example-skill")).isSymbolicLink()).toBe(true);
  });
  it("links companion assets without replacing existing user assets", async () => {
    const options = setup(); options.write();
    fs.writeFileSync(join(options.source, "skills/example-skill/reference.md"), "canonical reference\n");
    await installClaudeBaseline(options);
    const reference = join(options.target, "skills/example-skill/reference.md");
    expect(fs.lstatSync(reference).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(reference, "utf8")).toBe("canonical reference\n");
    fs.unlinkSync(reference); fs.writeFileSync(reference, "my reference\n");
    await installClaudeBaseline(options);
    expect(fs.readFileSync(reference, "utf8")).toBe("my reference\n");
  });
});
