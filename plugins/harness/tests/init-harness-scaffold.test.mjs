import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { fileURLToPath } from "url";
import path from "path";
import fs from "fs";
import os from "os";
import { scaffoldHarness } from "../src/init-harness-scaffold.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATES_DIR = path.join(__dirname, "..", "templates");

let targetDir;

beforeEach(() => {
  targetDir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-scaffold-test-"));
});

afterEach(() => {
  fs.rmSync(targetDir, { recursive: true, force: true });
});

const DEFAULT_PLACEHOLDERS = {
  project_name: "test-project",
  project_type: "node",
  today: "2026-04-14",
};

describe("scaffoldHarness", () => {
  it("copies every template file to target preserving tree", () => {
    const { filesWritten } = scaffoldHarness({
      templatesDir: TEMPLATES_DIR,
      targetDir,
      placeholders: DEFAULT_PLACEHOLDERS,
    });

    const expected = [
      ".claude/hooks/guard-destructive-git.sh",
      ".claude/settings.headless.json",
      ".claude/settings.json",
      ".claude/skills-manifest.json",
      ".github/workflows/validate-skills.yml",
      "docs/repo-facts.json",
      "docs/specs/README.md",
    ];

    // All expected files exist on disk
    for (const rel of expected) {
      expect(
        fs.existsSync(path.join(targetDir, rel)),
        `Expected file to exist: ${rel}`
      ).toBe(true);
    }

    // filesWritten matches the expected set (sorted)
    expect(filesWritten).toEqual(expected);
  });

  it("substitutes {{project_name}}, {{project_type}}, {{today}}", () => {
    scaffoldHarness({
      templatesDir: TEMPLATES_DIR,
      targetDir,
      placeholders: { project_name: "my-proj", project_type: "node", today: "2026-04-14" },
    });

    const repoFacts = JSON.parse(
      fs.readFileSync(path.join(targetDir, "docs/repo-facts.json"), "utf8")
    );
    expect(repoFacts.project_name).toBe("my-proj");
    expect(repoFacts.project_type).toBe("node");

    const manifest = JSON.parse(
      fs.readFileSync(path.join(targetDir, ".claude/skills-manifest.json"), "utf8")
    );
    expect(manifest.generatedAt).toBe("2026-04-14");
  });

  it("refuses if .claude/skills-manifest.json already exists", () => {
    fs.mkdirSync(path.join(targetDir, ".claude"), { recursive: true });
    fs.writeFileSync(path.join(targetDir, ".claude/skills-manifest.json"), "{}");

    expect(() =>
      scaffoldHarness({
        templatesDir: TEMPLATES_DIR,
        targetDir,
        placeholders: DEFAULT_PLACEHOLDERS,
      })
    ).toThrow(/already|initialized/i);
  });

  it("refuses if docs/specs/ already exists", () => {
    fs.mkdirSync(path.join(targetDir, "docs/specs"), { recursive: true });

    expect(() =>
      scaffoldHarness({
        templatesDir: TEMPLATES_DIR,
        targetDir,
        placeholders: DEFAULT_PLACEHOLDERS,
      })
    ).toThrow(/already|initialized/i);
  });

  it("makes guard-destructive-git.sh executable post-copy", () => {
    scaffoldHarness({
      templatesDir: TEMPLATES_DIR,
      targetDir,
      placeholders: DEFAULT_PLACEHOLDERS,
    });

    const hookPath = path.join(targetDir, ".claude/hooks/guard-destructive-git.sh");
    const mode = fs.statSync(hookPath).mode;
    expect(mode & 0o111).toBeTruthy();
  });

  it("leaves unrecognized {{placeholder}} tokens untouched", () => {
    // Omit 'today' from placeholders — {{today}} in skills-manifest.json should survive
    scaffoldHarness({
      templatesDir: TEMPLATES_DIR,
      targetDir,
      placeholders: { project_name: "my-proj", project_type: "go" },
    });

    const raw = fs.readFileSync(
      path.join(targetDir, ".claude/skills-manifest.json"),
      "utf8"
    );
    expect(raw).toContain("{{today}}");
  });
});
