/** Shell integration driver over the public project sync APIs and canonical test inputs. */
import fs from "node:fs";
import { join } from "node:path";
import { projectSync } from "../../../src/project-sync.mjs";
import { checkProjectSync } from "../../../src/check-project-sync.mjs";
import { resolve } from "../../../src/model-intelligence/resolver/index.mjs";
import { materializationFixture } from "./materialize.mjs";
import { input } from "./resolver.mjs";

const [repoRoot, action] = process.argv.slice(2);
const canonical = "skills/example/SKILL.md";
if (action === "setup") {
  fs.mkdirSync(join(repoRoot, "skills/example"), { recursive: true });
  fs.writeFileSync(join(repoRoot, "CLAUDE.md"), "# Local rules\n\nPreserve original input.\n");
  fs.writeFileSync(join(repoRoot, ".dotbabel.json"), JSON.stringify({ fan_out: ["codex"], fan_out_layout: "per-cli", gate_on_cli_presence: false, skills_dir: "skills", commands_dir: "commands" }));
  fs.writeFileSync(join(repoRoot, canonical), materializationFixture().artifacts[0].sourceContent);
} else {
  const options = { repoRoot, quiet: true, allCli: true, projectionTrees: [{ root: join(repoRoot, ".codex/skills"), loadInputs: () => {
    const inputs = materializationFixture(); const artifact = inputs.artifacts[0];
    artifact.sourcePath = canonical; artifact.sourceContent = fs.readFileSync(join(repoRoot, canonical), "utf8");
    artifact.target = { ...artifact.target, artifactKind: "skill", path: "example/SKILL.md" };
    artifact.resolverResult = resolve(input({ target: artifact.target }));
    return inputs;
  } }] };
  let result;
  if (action === "perf") {
    const warm = await projectSync(options); if (!warm.ok) throw new Error("fixture warmup failed");
    const times = [];
    for (let i = 0; i < 10; i++) {
      const start = performance.now(); const outcome = await projectSync(options);
      if (!outcome.ok) throw new Error("fixture sync failed");
      times.push(performance.now() - start);
    }
    const p95Ms = times.sort((a, b) => a - b)[9];
    result = { ok: p95Ms <= 1500, p95Ms, warmedRuns: 10, networkCalls: 0 };
  } else result = await (action === "sync" ? projectSync(options) : checkProjectSync(options));
  console.log(JSON.stringify(result)); process.exitCode = result.ok ? 0 : 1;
}
