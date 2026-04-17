import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { fileURLToPath } from "url";
import path from "path";
import fs from "fs";
import os from "os";
import { scaffoldHarness } from "../src/init-harness-scaffold.mjs";
import { ValidationError, ERROR_CODES } from "../src/lib/errors.mjs";

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
      ".claude/agents/architect-reviewer.md",
      ".claude/agents/aws-engineer.md",
      ".claude/agents/azure-engineer.md",
      ".claude/agents/backend-developer.md",
      ".claude/agents/changelog-assistant.md",
      ".claude/agents/container-engineer.md",
      ".claude/agents/crossplane-engineer.md",
      ".claude/agents/deployment-engineer.md",
      ".claude/agents/devops-engineer.md",
      ".claude/agents/documentation-writer.md",
      ".claude/agents/frontend-developer.md",
      ".claude/agents/gcp-engineer.md",
      ".claude/agents/iac-engineer.md",
      ".claude/agents/kubernetes-specialist.md",
      ".claude/agents/platform-engineer.md",
      ".claude/agents/pulumi-engineer.md",
      ".claude/agents/security-auditor.md",
      ".claude/agents/security-engineer.md",
      ".claude/agents/terragrunt-engineer.md",
      ".claude/agents/test-engineer.md",
      ".claude/agents/workflow-orchestrator.md",
      ".claude/commands/audit-and-fix.md",
      ".claude/commands/changelog.md",
      ".claude/commands/create-assessment.md",
      ".claude/commands/create-audit.md",
      ".claude/commands/create-inspection.md",
      ".claude/commands/dependabot-sweep.md",
      ".claude/commands/detect-flaky.md",
      ".claude/commands/fix-with-evidence.md",
      ".claude/commands/git.md",
      ".claude/commands/ground-first.md",
      ".claude/commands/markdown.md",
      ".claude/commands/merge-pr.md",
      ".claude/commands/review-pr.md",
      ".claude/commands/security-review.md",
      ".claude/hooks/guard-destructive-git.sh",
      ".claude/settings.headless.json",
      ".claude/settings.json",
      ".claude/skills-manifest.json",
      ".claude/skills/agents-search/SKILL.md",
      ".claude/skills/aws-specialist/SKILL.md",
      ".claude/skills/azure-specialist/SKILL.md",
      ".claude/skills/crossplane-specialist/SKILL.md",
      ".claude/skills/gcp-specialist/SKILL.md",
      ".claude/skills/kubernetes-specialist/SKILL.md",
      ".claude/skills/pulumi-specialist/SKILL.md",
      ".claude/skills/spec/SKILL.md",
      ".claude/skills/terraform-specialist/SKILL.md",
      ".claude/skills/terragrunt-specialist/SKILL.md",
      ".claude/skills/validate-spec/SKILL.md",
      ".github/workflows/ai-review.yml",
      ".github/workflows/detect-drift.yml",
      ".github/workflows/validate-skills.yml",
      "docs/repo-facts.json",
      "docs/specs/README.md",
      "githooks/pre-commit",
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
