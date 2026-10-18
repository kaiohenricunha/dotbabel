import { describe, expect, it, vi, afterEach } from "vitest";
import fs from "node:fs";
import { join } from "node:path";
import { makeTempDir } from "./fixtures/temp-dir.mjs";
import { openProjectionTree } from "../src/model-intelligence/materialize/projection-fs.mjs";
import { syncClaudeCompanions } from "../src/model-intelligence/materialize/runtime/claude-companions.mjs";

afterEach(() => vi.restoreAllMocks());
const ledgerName = ".dotbabel-claude-companions.json";
function setup() {
  const root = makeTempDir("mi-companion-owner-"); const source = makeTempDir("mi-companion-package-");
  fs.mkdirSync(join(source, "skills/example"), { recursive: true });
  fs.writeFileSync(join(source, "skills/example/SKILL.md"), "canonical private metadata");
  fs.writeFileSync(join(source, "skills/example/reference.md"), "release asset");
  const manifest = { entries: { "skills/example/SKILL.md": { artifactKind: "skill", sourcePath: "skills/example/SKILL.md" } } };
  return { root, source, manifest };
}
async function run(options) {
  const tree = openProjectionTree(options.root);
  try { await syncClaudeCompanions({ ...options, tree }); } finally { tree.close(); }
}

describe("Claude companion ownership boundary", () => {
  it.each([
    null, 4, { schemaVersion: 1, links: 4 },
    { schemaVersion: 1, links: { "outside/skills/example/reference.md": { current: "/old" } } },
    { schemaVersion: 1, links: { "skills/example/nested/reference.md": { current: "/old" } } },
    { schemaVersion: 1, links: { "skills/example/reference.md": [] } },
    { schemaVersion: 1, links: { "skills/example/reference.md": { current: 5 } } },
    { schemaVersion: 1, links: { "skills/example/reference.md": { current: "/bad\npath" } } },
    { schemaVersion: 1, links: { "skills/example/reference.md": { current: "/" + "a".repeat(4096) } } },
    { schemaVersion: 1, links: Object.fromEntries(Array.from({ length: 4097 }, (_, n) => [`skills/example/asset-${n}`, { current: "/old" }])) },
  ])("rejects malformed ownership case %# with a stable error code", async ledger => {
    const options = setup(); fs.writeFileSync(join(options.root, ledgerName), JSON.stringify(ledger));
    await expect(run(options)).rejects.toMatchObject({ code: "claude_companion_ownership_invalid" });
    expect(fs.existsSync(join(options.root, "skills"))).toBe(false);
  });
  it("accepts the ownership count and target-length limits and retires only ownership", async () => {
    const options = setup(); options.manifest.entries = {};
    const links = Object.fromEntries(Array.from({ length: 4096 }, (_, n) => [`skills/example/asset-${n}`, { current: "/" + "a".repeat(n === 0 ? 4095 : 1) }]));
    fs.writeFileSync(join(options.root, ledgerName), JSON.stringify({ schemaVersion: 1, links }));
    fs.writeFileSync(join(options.root, "personal"), "preserved");
    await run(options);
    expect(JSON.parse(fs.readFileSync(join(options.root, ledgerName), "utf8"))).toEqual({ schemaVersion: 1, links: {} });
    expect(fs.readFileSync(join(options.root, "personal"), "utf8")).toBe("preserved");
  });
  it("preserves an exclusive-create race and records no ownership for the user's object", async () => {
    const options = setup(); const originalLink = fs.linkSync; let raced = false;
    vi.spyOn(fs, "linkSync").mockImplementation((source, destination, ...args) => {
      if (!raced && String(destination).endsWith("/reference.md")) {
        raced = true; fs.writeFileSync(destination, "user race bytes");
      }
      return originalLink(source, destination, ...args);
    });
    await run(options);
    expect(raced).toBe(true);
    expect(fs.readFileSync(join(options.root, "skills/example/reference.md"), "utf8")).toBe("user race bytes");
    expect(JSON.parse(fs.readFileSync(join(options.root, ledgerName), "utf8")).links).toEqual({});
  });
  it("forgets replaced user links and does not reclaim them if they later resemble the old release", async () => {
    const options = setup(); await run(options);
    const asset = join(options.root, "skills/example/reference.md"); const original = fs.readlinkSync(asset);
    fs.unlinkSync(asset); fs.symlinkSync("/user/reference", asset); await run(options);
    fs.unlinkSync(asset); fs.symlinkSync(original, asset);
    const next = setup(); await run({ ...next, root: options.root });
    expect(fs.readlinkSync(asset)).toBe(original);
    expect(JSON.parse(fs.readFileSync(join(options.root, ledgerName), "utf8")).links).toEqual({});
  });
  it("does not create ownership state when no companions exist", async () => {
    const options = setup(); fs.unlinkSync(join(options.source, "skills/example/reference.md"));
    await run(options); expect(fs.readdirSync(options.root)).toEqual([]);
  });
  it.each(["bad:name", "bad\nname"])("refuses an unsafe companion name %j before linking", async name => {
    const options = setup(); fs.writeFileSync(join(options.source, "skills/example", name), "asset");
    await expect(run(options)).rejects.toMatchObject({ code: "claude_companion_ownership_invalid" });
    expect(fs.readdirSync(options.root)).toEqual([]);
  });
});
