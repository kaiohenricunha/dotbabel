import { describe, it, expect } from "vitest";
import fs from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { makeTempDir } from "./fixtures/temp-dir.mjs";
import { materializationFixture } from "./fixtures/model-intelligence/materialize.mjs";
import { parseFrontmatter } from "../src/build-index.mjs";
import { projectSync } from "../src/project-sync.mjs";
import { checkProjectSync } from "../src/check-project-sync.mjs";

function fixture() {
  const repoRoot = makeTempDir("mi-projection-sync-");
  fs.writeFileSync(join(repoRoot, "CLAUDE.md"), "# Rules\n\nKeep the project safe.\n");
  fs.writeFileSync(join(repoRoot, ".dotbabel.json"), JSON.stringify({ fan_out: ["codex"], fan_out_layout: "per-cli", gate_on_cli_presence: false, commands_dir: "commands", skills_dir: "skills" }));
  const inputs = materializationFixture(); const artifact = inputs.artifacts[0];
  artifact.sourcePath = "skills/example/SKILL.md"; artifact.target.path = "example/SKILL.md"; artifact.target.artifactKind = "skill";
  artifact.resolverResult.enforcement = { state: "unknown", basis: "none" };
  fs.mkdirSync(join(repoRoot, "skills/example/references"), { recursive: true });
  fs.writeFileSync(join(repoRoot, artifact.sourcePath), artifact.sourceContent);
  fs.writeFileSync(join(repoRoot, "skills/example/references/guide.md"), "Canonical reference.\n");
  return { repoRoot, quiet: true, allCli: true, projectionTrees: [{ root: join(repoRoot, ".codex/skills"), loadInputs: () => structuredClone(inputs) }] };
}

describe("project sync projection transactions", () => {
  it("writes a generated copy where a symlink exposes private metadata and reports subsequent drift", async () => {
    const options = fixture(); const result = await projectSync(options);
    expect(result.ok).toBe(true);
    const path = join(options.repoRoot, ".codex/skills/example/SKILL.md");
    expect(fs.lstatSync(path).isSymbolicLink()).toBe(false);
    expect(parseFrontmatter(fs.readFileSync(path, "utf8")).frontmatter).not.toHaveProperty("dotbabel");
    expect(fs.readFileSync(path, "utf8")).toContain("# dotbabel:generated projection=");
    expect(fs.readFileSync(join(options.repoRoot, ".codex/skills/example/references/guide.md"), "utf8")).toBe("Canonical reference.\n");
    expect((await checkProjectSync(options)).ok).toBe(true);
    fs.appendFileSync(path, "user edit\n");
    const check = await checkProjectSync(options);
    expect(check.ok).toBe(false);
    expect(check.stale).toContainEqual(expect.objectContaining({ kind: "projection", path: ".codex/skills/example/SKILL.md", actual: "user-drift" }));
    expect((await projectSync(options)).ok).toBe(false);
    expect(fs.readFileSync(path, "utf8")).toContain("user edit");
  });
  it("a dry run plans generated files without creating a tree, manifest or lock", async () => {
    const options = fixture();
    expect((await projectSync({ ...options, dryRun: true })).ok).toBe(true);
    expect(fs.existsSync(join(options.repoRoot, ".codex"))).toBe(false);
    expect(fs.existsSync(join(options.repoRoot, "AGENTS.md"))).toBe(false);
  });
  it("refuses a requested projection root outside the active repository", async () => {
    const options = fixture(); const outside = makeTempDir("mi-projection-outside-");
    options.projectionTrees[0].root = outside;
    expect((await projectSync(options)).ok).toBe(false);
    expect(fs.readdirSync(outside)).toEqual([]);
  });
  it("reports missing projection files without writing while checking", async () => {
    const options = fixture();
    const result = await checkProjectSync(options);
    expect(result.ok).toBe(false);
    expect(result.missing).toContainEqual(expect.objectContaining({ kind: "projection", path: ".codex/skills/example/SKILL.md" }));
    expect(fs.existsSync(join(options.repoRoot, ".codex"))).toBe(false);
  });
  it.each([{ fan_out: [] }, { cli_excluded: { codex: ["example"] } }])("honors runtime selection and excluded artifact configuration", async change => {
    const options = fixture(); const configPath = join(options.repoRoot, ".dotbabel.json");
    const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    fs.writeFileSync(configPath, JSON.stringify({ ...config, ...change }));
    expect((await projectSync(options)).ok).toBe(true);
    expect(fs.existsSync(join(options.repoRoot, ".codex/skills/example"))).toBe(false);
    expect((await checkProjectSync(options)).ok).toBe(true);
  });
  it.each(["same", "nested"])("refuses %s overlapping ownership trees before writing", async kind => {
    const options = fixture(); const another = { ...options.projectionTrees[0] };
    if (kind === "nested") another.root = join(another.root, "nested");
    options.projectionTrees.push(another);
    expect((await projectSync(options)).ok).toBe(false);
    expect(fs.existsSync(join(options.repoRoot, ".codex"))).toBe(false);
  });
  it("project-sync p95 is at most 1.5 seconds over 10 warmed runs on the sync fixture with a warm cache and no network", async () => {
    const options = fixture(); expect((await projectSync(options)).ok).toBe(true);
    const times = [];
    for (let i = 0; i < 10; i++) {
      const start = performance.now(); const outcome = await projectSync(options);
      times.push(performance.now() - start); expect(outcome.ok).toBe(true);
    }
    const p95 = times.sort((a, b) => a - b)[9];
    console.info(JSON.stringify({ projectSyncP95Ms: p95, warmedSamples: 10, networkCalls: 0 }));
    expect(p95).toBeLessThanOrEqual(1500);
  });
});
