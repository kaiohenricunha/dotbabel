import { afterEach, describe, it, expect, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { load } from "js-yaml";
import { spawnSync } from "node:child_process";
import { bootstrapGlobal } from "../src/bootstrap-global.mjs";
import { RUNTIMES } from "../src/agents.mjs";
import { makeTempDir } from "./fixtures/temp-dir.mjs";

const repo = path.resolve(import.meta.dirname, "../../..");

afterEach(() => vi.unstubAllEnvs());

describe("native Codex yolo skill", () => {
  it.each(["skills", "plugins/dotbabel/templates/claude/skills"])(
    "installs %s with policies and references, idempotently",
    async (skillsDir) => {
      const source = makeTempDir("codex-skills-source-");
      const target = makeTempDir("codex-skills-home-");
      for (const runtime of Object.values(RUNTIMES)) {
        if (runtime.configDir?.envVar) {
          vi.stubEnv(runtime.configDir.envVar, path.join(target, runtime.configDir.baseDir));
        }
      }
      fs.cpSync(path.join(repo, skillsDir, "yolo"), path.join(source, "skills", "yolo"), {
        recursive: true,
      });

      for (let pass = 0; pass < 2; pass++) {
        const result = await bootstrapGlobal({ source, target, allCli: true, quiet: true });
        expect(result.ok).toBe(true);
        expect(result.backed_up).toBe(0);
        const installed = path.join(target, ".codex", "skills", "yolo");
        expect(fs.realpathSync(installed)).toBe(path.join(source, "skills", "yolo"));
        const metadata = load(fs.readFileSync(path.join(installed, "agents/openai.yaml"), "utf8"));
        expect(metadata.policy.allow_implicit_invocation).toBe(false);
        const skill = fs.readFileSync(path.join(installed, "SKILL.md"), "utf8");
        const frontmatter = load(skill.split("---")[1]);
        expect(frontmatter.name).toBe("yolo");
        expect(typeof frontmatter.description).toBe("string");
        expect(fs.statSync(path.join(installed, "references/codex.md")).isFile()).toBe(true);
        expect(fs.statSync(path.join(installed, "scripts/codex-yolo.mjs")).isFile()).toBe(true);
        const help = spawnSync(
          process.execPath,
          [path.join(installed, "scripts/codex-yolo.mjs"), "--help"],
          { encoding: "utf8" },
        );
        expect(help.error).toBeUndefined();
        expect(help.status).toBe(0);
        expect(help.stdout).toContain("Full access");
      }
    },
  );
});
