import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { fileURLToPath } from "url";
import path from "path";
import fs from "fs";
import os from "os";
import { scaffoldHarness } from "../src/init-harness-scaffold.mjs";
import { ValidationError, ERROR_CODES } from "../src/lib/errors.mjs";

/** Prefix mapping applied by scaffoldHarness (mirrors init-harness-scaffold.mjs). */
const PREFIX_MAP = [
  { from: "claude/", to: ".claude/" },
  { from: "docs/", to: "docs/" },
  { from: "workflows/", to: ".github/workflows/" },
];
function applyPrefixMap(rel) {
  for (const { from, to } of PREFIX_MAP) {
    if (rel.startsWith(from)) return to + rel.slice(from.length);
  }
  return rel;
}

/** Walk templates dir, apply prefix map, sort — mirrors expected filesWritten. */
function expectedFromTemplates(templatesDir) {
  const results = [];
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) {
        const rel = path.relative(templatesDir, full);
        results.push(applyPrefixMap(rel));
      }
    }
  }
  walk(templatesDir);
  return results.sort();
}

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

    // Derived dynamically so the test stays in sync as build-plugin adds files.
    const expected = expectedFromTemplates(TEMPLATES_DIR);

    // All expected files exist on disk
    for (const rel of expected) {
      expect(
        fs.existsSync(path.join(targetDir, rel)),
        `Expected file to exist: ${rel}`
      ).toBe(true);
    }

    // filesWritten matches the expected set exactly (sorted)
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

  it("refuses if .claude/skills-manifest.json already exists — throws SCAFFOLD_CONFLICT", () => {
    fs.mkdirSync(path.join(targetDir, ".claude"), { recursive: true });
    fs.writeFileSync(path.join(targetDir, ".claude/skills-manifest.json"), "{}");

    let caught;
    try {
      scaffoldHarness({
        templatesDir: TEMPLATES_DIR,
        targetDir,
        placeholders: DEFAULT_PLACEHOLDERS,
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ValidationError);
    expect(caught.code).toBe(ERROR_CODES.SCAFFOLD_CONFLICT);
    expect(caught.message).toMatch(/already|initialized/i);
  });

  it("refuses if docs/specs/ already exists — throws SCAFFOLD_CONFLICT", () => {
    fs.mkdirSync(path.join(targetDir, "docs/specs"), { recursive: true });

    let caught;
    try {
      scaffoldHarness({
        templatesDir: TEMPLATES_DIR,
        targetDir,
        placeholders: DEFAULT_PLACEHOLDERS,
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ValidationError);
    expect(caught.code).toBe(ERROR_CODES.SCAFFOLD_CONFLICT);
    expect(caught.message).toMatch(/already|initialized/i);
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
