import fs from "node:fs";
import path from "node:path";
import { materializeClaude } from "../../../src/model-intelligence/materialize/runtime/claude.mjs";
import { claudeProjectionFixture } from "./claude-projection.mjs";

const [source, revision = "first"] = process.argv.slice(2);
if (!source || !["first", "second"].includes(revision)) process.exit(64);
const fixtures = ["agent", "command", "skill"].map(kind => claudeProjectionFixture(kind));
const inputs = { ...fixtures[0], artifacts: fixtures.flatMap(item => item.artifacts).map(artifact => ({ ...artifact, sourceContent: artifact.sourceContent + revision + " release\n" })) };
const batch = materializeClaude(inputs);
const root = path.join(source, "plugins/dotbabel/templates/claude");
for (const artifact of inputs.artifacts) {
  const file = path.join(source, artifact.sourcePath);
  fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, artifact.sourceContent);
}
for (const item of batch.files) {
  const file = path.join(root, item.path);
  fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, item.content);
}
fs.writeFileSync(path.join(root, ".dotbabel-projection.json"), JSON.stringify(batch.manifest));
fs.writeFileSync(path.join(source, "CLAUDE.md"), "# Isolated baseline fixture\n");
