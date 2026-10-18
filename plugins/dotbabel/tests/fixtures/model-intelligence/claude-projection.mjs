import yaml from "js-yaml";
import { input } from "./resolver.mjs";

export function claudeProjectionFixture(kind = "agent", compute = { requirement: "deep", mode: "dynamic", binding: "self" }) {
  const context = JSON.parse(JSON.stringify(input()).replaceAll('"codex"', '"claude"'));
  context.runtimeContract.binding.command = { support: "supported", axes: { model: "supported", reasoning: "unverified" } };
  const sourceContent = "---\n" + yaml.dump({ name: "projection-example", description: "A projection fixture.", tools: ["Read"], model: "legacy-shadow", effort: "low", owner: "private-owner", dotbabel: { compute } }) + "---\n\nPreserve this exact body.\n";
  const file = kind === "skill" ? "skills/example-skill/SKILL.md" : kind === "command" ? "commands/example-command.md" : "agents/example.md";
  return { toolVersion: "4.2.0", artifacts: [{ sourcePath: file, sourceContent, target: { path: file, artifactKind: kind } }], context };
}

// Explicit fixture facts for native parsing only: this never claims runtime/model entitlement.
export function claudeNativeProjectionFixture() {
  const fixtures = ["agent", "command", "skill"].map(kind => claudeProjectionFixture(kind));
  const context = fixtures[0].context;
  const record = context.catalog.runtimes[0].models.find(model => model.model === "deep-model");
  record.model = "claude-sonnet-5-5";
  record.fields.id[0].value = record.model;
  record.fields.supportedReasoningLevels[0].value = ["low", "medium", "high"].map(effort => ({ effort }));
  record.fields.defaultReasoningLevel[0].value = "high";
  context.catalog.runtimes[0].models = [record];
  return { ...fixtures[0], artifacts: fixtures.flatMap(item => item.artifacts), context };
}

export function claudeProjectionCases() {
  return {
    agent: claudeProjectionFixture(),
    dynamicCommand: claudeProjectionFixture("command", { requirement: "deep", mode: "dynamic", binding: "session" }),
    floorCommand: claudeProjectionFixture("command", { requirement: "deep", mode: "floor", binding: "session" }),
    pinnedCommand: claudeProjectionFixture("command", { requirement: "deep", mode: "pin", binding: "session", rationale: "An explicit session model.", pin: { runtime: "claude", config: { model: "deep-model" } } }),
    skill: claudeProjectionFixture("skill", { requirement: "deep", mode: "dynamic", binding: "consumer" }),
    inherit: claudeProjectionFixture("agent", { mode: "inherit", binding: "self" }),
  };
}
