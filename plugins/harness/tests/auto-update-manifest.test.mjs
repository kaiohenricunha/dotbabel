import { describe, it, expect } from "vitest";
import { execFileSync } from "child_process";
import { mkdtempSync, cpSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WRAPPER = path.resolve(__dirname, "..", "scripts", "auto-update-manifest.mjs");
const FIXTURE = path.resolve(__dirname, "fixtures", "minimal-repo");

function iso() {
  const d = mkdtempSync(path.join(tmpdir(), "harness-aum-"));
  cpSync(FIXTURE, d, { recursive: true });
  return d;
}

describe("auto-update-manifest.mjs", () => {
  it("invokes harness-validate-skills --update in the current working directory", () => {
    const root = iso();
    // Mutate a command so checksums are stale.
    writeFileSync(path.join(root, ".claude/commands/example.md"), "# mutated\n");

    execFileSync(process.execPath, [WRAPPER], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, HARNESS_REPO_ROOT: root },
    });

    const manifest = JSON.parse(
      readFileSync(path.join(root, ".claude/skills-manifest.json"), "utf8"),
    );
    const example = manifest.skills.find((s) => s.path === ".claude/commands/example.md");
    expect(example).toBeDefined();
    expect(example.checksum).not.toBe("sha256:deadbeef");
    // The new checksum reflects the mutated content.
    expect(example.checksum).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});
