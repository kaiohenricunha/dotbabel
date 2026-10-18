import { describe, it, expect } from "vitest";
import { performance } from "node:perf_hooks";
import { spawnSync } from "node:child_process";
import { classify, MAX_PROMPT_BYTES } from "../src/adaptive-session-routing/classifier/index.mjs";
import { tasks } from "./fixtures/adaptive-session-routing/tasks.mjs";

describe("local contextual task classification", () => {
  it("evaluates representative engineering scenarios with explicit uncertainty", () => {
    const run = spawnSync(process.execPath, ["experiments/adaptive-session-routing-classifier/compare.mjs"], { encoding: "utf8" });
    expect(run.status, run.stderr).toBe(0);
    const report = JSON.parse(run.stdout);
    expect(report.fixtureKind).toContain("not held-out accuracy");
    expect(report.modelAssisted).toMatchObject({ evaluated: false, calls: 0 });
    expect(report.approaches.contextual.count).toBe(tasks.length);
    expect(report.approaches.contextual.agreement).toBe(tasks.length);
    expect(report.approaches.lexical.agreement).toBeLessThan(tasks.length);
    const cases = report.approaches.contextual.cases;
    expect(cases.map(item => item.id)).toEqual(tasks.map(task => task.id));
    for (const item of cases) {
      expect(item.confidence).toMatch(/^(low|medium|high)$/);
      expect(item.status).toMatch(/^(classified|uncertain)$/);
      expect(item.reasonCodes.length).toBeGreaterThan(0);
      expect(item).not.toHaveProperty("prompt");
      expect(item).not.toHaveProperty("context");
    }
    expect(cases.filter(item => item.status === "uncertain")).not.toHaveLength(0);
    expect(cases.filter(item => item.status === "uncertain").every(item => item.confidence === "low")).toBe(true);
    expect(JSON.stringify(report)).not.toContain(tasks[0].prompt);
  });
  it.each(tasks)("classifies $id without native model identifiers", fixture => {
    const result = classify({ prompt: fixture.prompt, context: fixture.context });
    if (fixture.expected.status === "uncertain") {
      expect(result.status).toBe("uncertain");
      expect(result.confidence).toBe("low");
      expect(result.diagnostics.map(x => x.code)).toContain("classification_uncertain");
    } else {
      expect(result.status).toBe("classified");
      expect(result.requirement).toMatchObject({ requirement: fixture.expected.requirement, binding: "session", mode: "dynamic" });
      expect(result.effortIntent).toBe(fixture.expected.effortIntent);
    }
    expect(result.strategy).toEqual({ id: "local-contextual", version: 1 });
    expect(result.confidence).toMatch(/^(low|medium|high)$/);
    expect(Array.isArray(result.diagnostics)).toBe(true);
    if (result.status === "classified") {
      expect(result.requirement.provenance).toEqual({ sourceId: "local-task-classifier", sourceKind: "artifact" });
      expect(result.characteristics.risk).toMatch(/^(low|medium|high|unknown)$/);
      expect(result.characteristics.ambiguity).toMatch(/^(low|medium|high|unknown)$/);
      expect(result.characteristics.verification).toMatch(/^(simple|integration|adversarial|unknown)$/);
      expect(result.characteristics.priorFailures).toBe(fixture.context.priorFailures ?? 0);
    }
    for (const entry of [...result.reasons, ...result.diagnostics]) {
      expect(entry.message.trim().length).toBeGreaterThan(0);
      expect(entry.code).toMatch(/^[a-z][a-z_]+$/);
    }
    expect(result).not.toHaveProperty("model");
    expect(result).not.toHaveProperty("configuration");
    expect(result.reasons.length).toBeGreaterThan(0);
    for (const reason of result.reasons) expect(reason.code).toMatch(/^[a-z][a-z_]+$/);
  });
  it("uses task characteristics when no structured context is available", () => {
    const architecture = classify({ prompt: "Design a new distributed ingestion architecture." });
    expect(architecture.requirement.requirement).toBe("frontier");
    expect(architecture.effortIntent).toBe("high");
    const debugging = classify({ prompt: "Investigate why the scoring formula produces inconsistent results." });
    expect(debugging.requirement.requirement).toBe("deep");
    expect(debugging.effortIntent).toBe("high");
    const integration = classify({ prompt: "Implement integration tests for the payment gateway." });
    expect(integration.requirement.requirement).toBe("deep");
    expect(integration.effortIntent).toBe("medium");
    expect(integration.confidence).toBe("medium");
  });
  it("changes model capability and effort intent independently", () => {
    const integration = classify(tasks.find(x => x.id === "payment-integration"));
    const auth = classify(tasks.find(x => x.id === "auth-known-fix"));
    expect(integration.requirement.requirement).toBe("deep");
    expect(auth.requirement.requirement).toBe("deep");
    expect(integration.effortIntent).toBe("medium");
    expect(auth.effortIntent).toBe("high");
  });
  it("uses recent failures as supplied context without reading a repository", () => {
    const base = tasks.find(x => x.id === "payment-integration");
    const initial = classify(base);
    const repeated = classify({ prompt: base.prompt, context: { ...base.context, priorFailures: 2, ambiguity: "high" } });
    expect(initial.requirement.requirement).toBe("deep");
    expect(repeated.requirement.requirement).toBe("frontier");
    expect(repeated.effortIntent).toBe("high");
    expect(repeated.reasons.map(x => x.code)).toContain("prior_failures_considered");
  });
  it("does not promote risk from fenced source or quoted log lines", () => {
    const prompt = 'Fix the button spacing.\n```text\nproduction security architecture race\n```\n> architecture security production';
    const result = classify({ prompt, context: { componentCount: 1, ambiguity: "low", verification: "simple" } });
    expect(result.requirement.requirement).toBe("routine");
    expect(result.effortIntent).toBe("medium");
  });
  it("does not promote risk from inline code or a truncated fenced example", () => {
    for (const prompt of ['Fix the button text `production consistency race`.', 'Fix the button spacing.\n```text\nproduction consistency race']) {
      const result = classify({ prompt, context: { componentCount: 1, ambiguity: "low", verification: "simple" } });
      expect(result.requirement.requirement).toBe("routine");
      expect(result.effortIntent).toBe("medium");
    }
  });
  it("preserves supplied consequence and verification as independent demand inputs", () => {
    const prompt = "Review the specified change and its tests.";
    const base = { componentCount: 1, risk: "low", consequence: "low", ambiguity: "low", verification: "simple", specification: "present", priorFailures: 0 };
    const routine = classify({ prompt, context: base });
    expect(routine).toMatchObject({ confidence: "high", effortIntent: "medium", requirement: { requirement: "routine" }, characteristics: { scope: "local", risk: "low", consequence: "low", ambiguity: "low", verification: "simple", specification: "present", priorFailures: 0 } });
    const consequential = classify({ prompt, context: { ...base, consequence: "high" } });
    expect(consequential.requirement.requirement).toBe("deep");
    expect(consequential.effortIntent).toBe("high");
    expect(consequential.characteristics.consequence).toBe("high");
    const adversarial = classify({ prompt, context: { ...base, verification: "adversarial" } });
    expect(adversarial.requirement.requirement).toBe("frontier");
    expect(adversarial.effortIntent).toBe("medium");
  });
  it("reports known and unknown scope instead of inventing component counts", () => {
    const prompt = "Implement the specified fixture change.";
    const base = { risk: "low", ambiguity: "low", verification: "simple" };
    for (const [componentCount, scope] of [[0, "local"], [1, "local"], [2, "cross-component"], [3, "cross-component"], [4, "system"], [64, "system"]]) {
      const value = classify({ prompt, context: { ...base, componentCount } });
      expect(value.status).toBe("classified");
      expect(value.characteristics.scope).toBe(scope);
    }
    const unknown = classify({ prompt });
    expect(unknown.characteristics).toMatchObject({ scope: "unknown", risk: "unknown", ambiguity: "unknown", verification: "unknown", specification: "unknown", priorFailures: 0 });
    expect(unknown.confidence).toBe("medium");
  });
  it("accepts inclusive failure bounds and reports a first failure without fabricating escalation", () => {
    const prompt = "Implement integration tests for a bounded change.";
    const base = { componentCount: 2, risk: "medium", ambiguity: "low", verification: "integration" };
    const first = classify({ prompt, context: { ...base, priorFailures: 1 } });
    expect(first.requirement.requirement).toBe("deep");
    expect(first.effortIntent).toBe("medium");
    expect(first.characteristics.priorFailures).toBe(1);
    expect(first.reasons.map(x => x.code)).toContain("prior_failures_considered");
    expect(classify({ prompt, context: { ...base, priorFailures: 20 } }).status).toBe("classified");
    expect(classify({ prompt, context: { ...base, priorFailures: 21 } }).status).toBe("invalid");
    expect(classify({ prompt, context: { ...base, componentCount: 65 } }).status).toBe("invalid");
  });
  it("uses supplied specification context without converting unknown risk to certainty", () => {
    const result = classify({ prompt: "Implement the specified fixture change.", context: { specification: "present" } });
    expect(result.characteristics.specification).toBe("present");
    expect(result.characteristics.ambiguity).toBe("low");
    expect(result.confidence).toBe("medium");
    expect(result.reasons.map(x => x.code)).toEqual(["task_demand_classified", "scope_considered", "risk_considered", "verification_considered"]);
    expect(result.diagnostics).toEqual([]);
  });
  it("is deterministic and does not change supplied context", () => {
    const fixture = tasks.find(x => x.id === "ingestion-race");
    const before = structuredClone(fixture);
    const result = classify(fixture);
    for (let i = 0; i < 100; i++) expect(classify(fixture)).toEqual(result);
    expect(fixture).toEqual(before);
  });
  it("rejects invalid or oversized inputs without echoing private content", () => {
    for (const input of [null, [], { prompt: null }, { prompt: "" }, { prompt: "x".repeat(16385) }, { prompt: "Fix the button spacing", context: { priorFailures: -1 } }, { prompt: "Fix the button spacing", context: { componentCount: 100000 } }, { prompt: "Fix the button spacing", context: { risk: "private-marker" } }]) {
      const result = classify(input);
      expect(result.status).toBe("invalid");
      expect(result.confidence).toBe("low");
      expect(result.diagnostics).toHaveLength(1);
      expect(result.diagnostics[0].code).toMatch(/^(invalid_classification_input|classification_input_too_large)$/);
      expect(result.diagnostics[0].message.trim().length).toBeGreaterThan(0);
      expect(JSON.stringify(result)).not.toContain("private-marker");
    }
  });
  it("counts the prompt limit in bytes and accepts the inclusive boundary", () => {
    const prefix = "Format the JSON file.";
    const exact = prefix + " ".repeat(MAX_PROMPT_BYTES - Buffer.byteLength(prefix));
    expect(classify({ prompt: exact }).status).toBe("classified");
    expect(classify({ prompt: exact + "x" }).status).toBe("invalid");
    expect(classify({ prompt: prefix + "é".repeat(MAX_PROMPT_BYTES / 2) }).status).toBe("invalid");
  });
  it("requires data objects for explicit context", () => {
    for (const context of [null, [], "text", new Date(), { priorFailures: 0.5 }, { risk: true }, { unknown: "private-context-marker" }]) {
      const result = classify({ prompt: "Fix the button spacing.", context });
      expect(result.status).toBe("invalid");
      expect(JSON.stringify(result)).not.toContain("private-context-marker");
    }
  });
  it("preserves explicitly unknown context instead of inventing verified facts", () => {
    const result = classify({ prompt: "Implement the specified fixture change.", context: { specification: "unknown", risk: "unknown", consequence: "unknown", ambiguity: "unknown", verification: "unknown" } });
    expect(result.status).toBe("classified");
    expect(result.confidence).toBe("medium");
    expect(result.characteristics).toMatchObject({ risk: "unknown", consequence: "unknown", ambiguity: "unknown", verification: "unknown", specification: "unknown" });
  });
  it("reports invalid values for every supplied context field", () => {
    for (const context of [{ specification: "file:path" }, { risk: "critical" }, { consequence: "unbounded" }, { ambiguity: "certain" }, { verification: "none" }, { componentCount: "2" }, { priorFailures: "2" }]) {
      const result = classify({ prompt: "Implement the specified fixture change.", context });
      expect(result.status).toBe("invalid");
      expect(result.diagnostics.map(x => x.code)).toEqual(["invalid_classification_input"]);
      expect(result.diagnostics[0].message.trim().length).toBeGreaterThan(0);
      expect(result.reasons.map(x => x.code)).toEqual(["invalid_classification_input"]);
      expect(result.reasons[0].message.trim().length).toBeGreaterThan(0);
      expect(result.strategy).toEqual({ id: "local-contextual", version: 1 });
    }
  });
  it("returns uncertainty for conversation and text with no actionable instruction", () => {
    for (const prompt of ["Hello there", "Thanks", '"Fix production races"', "Do not change authentication."]) {
      const result = classify({ prompt });
      expect(result.status).toBe("uncertain");
      expect(result.confidence).toBe("low");
      expect(result.diagnostics.map(x => x.code)).toEqual(["classification_uncertain"]);
    }
    for (const prompt of [" ", "\n", "\t"]) expect(classify({ prompt }).status).toBe("invalid");
  });
  it("returns a safe diagnostic for an unexpected context-read failure", () => {
    const context = Object.defineProperty({}, "risk", { enumerable: true, get() { throw new Error("private-exception-marker"); } });
    const result = classify({ prompt: "Investigate the bounded fixture failure.", context });
    expect(result).toMatchObject({ status: "invalid", confidence: "low", diagnostics: [{ code: "invalid_classification_input" }] });
    expect(JSON.stringify(result)).not.toContain("private-exception-marker");
  });
  it("ignores repeated quoted examples rather than only the first one", () => {
    const context = { componentCount: 1, ambiguity: "low", verification: "simple" };
    for (const prompt of [
      'Rename the label "Settings" to "Production security".',
      'Rename the label "Settings" to "Production security" and "Architecture" to "Race conditions".'
    ]) {
      const result = classify({ prompt, context });
      expect(result.requirement.requirement).toBe("mechanical");
      expect(result.effortIntent).toBe("low");
    }
    for (const prompt of [
      'Fix the button spacing.\n```text\nsafe example\n```\n```text\nproduction race\n```',
      'Fix the button spacing.\n> safe example\n> production security race',
      'Fix the button text `safe label` and `production security race`.'
    ]) {
      const result = classify({ prompt, context });
      expect(result.requirement.requirement).toBe("routine");
      expect(result.effortIntent).toBe("medium");
    }
  });
  it("infers risk from a concrete authentication task without supplied risk metadata", () => {
    const result = classify({ prompt: "Implement the authentication guard and its token validation tests." });
    expect(result.requirement.requirement).toBe("deep");
    expect(result.effortIntent).toBe("high");
    expect(result.characteristics.risk).toBe("high");
    expect(result.confidence).toBe("medium");
  });
  it("accepts prototype-free supplied data objects", () => {
    const context = Object.assign(Object.create(null), { componentCount: 1, risk: "low", ambiguity: "low", verification: "simple" });
    const result = classify({ prompt: "Fix the button spacing.", context });
    expect(result.status).toBe("classified");
    expect(result.characteristics.scope).toBe("local");
  });
  it("keeps mechanical verification simple without structured context", () => {
    const result = classify({ prompt: "Format this JSON file with the existing formatter." });
    expect(result.requirement.requirement).toBe("mechanical");
    expect(result.effortIntent).toBe("low");
    expect(result.characteristics.verification).toBe("simple");
    expect(result.characteristics.ambiguity).toBe("unknown");
  });
  it("distinguishes a cross-component investigation from consequential system design", () => {
    const prompt = "Design a distributed ingestion architecture with replay guarantees.";
    const base = { componentCount: 3, risk: "high", consequence: "high", ambiguity: "high", verification: "adversarial" };
    expect(classify({ prompt, context: base }).requirement.requirement).toBe("frontier");
    expect(classify({ prompt, context: { ...base, componentCount: 4 } }).requirement.requirement).toBe("exceptional");
    const consequential = classify({ prompt, context: { ...base, componentCount: 4, risk: "low" } });
    expect(consequential.requirement.requirement).toBe("exceptional");
    expect(consequential.effortIntent).toBe("high");
    expect(consequential.characteristics).toMatchObject({ risk: "low", consequence: "high", scope: "system" });
  });
  it("does not let an unknown risk label hide explicit task risk", () => {
    const result = classify({ prompt: "Investigate the production authentication failure.", context: { risk: "unknown" } });
    expect(result.requirement.requirement).toBe("frontier");
    expect(result.characteristics.risk).toBe("high");
    expect(result.effortIntent).toBe("high");
  });
  it("classifies 1,000 warmed representative prompts within the 25 ms local budget", () => {
    for (const fixture of tasks) classify(fixture);
    const samples = Array.from({ length: 1000 }, (_, index) => {
      const start = performance.now(); classify(tasks[index % tasks.length]); return performance.now() - start;
    }).sort((a, b) => a - b);
    expect(samples[949]).toBeLessThanOrEqual(25);
  });
});
