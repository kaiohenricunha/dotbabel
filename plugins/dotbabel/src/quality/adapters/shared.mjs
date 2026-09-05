const FAST_CAPABILITIES = new Set(["format", "compile", "typecheck", "lint", "complexity"]);
const PR_CAPABILITIES = new Set([...FAST_CAPABILITIES, "test", "coverage", "dead-code", "dependencies", "duplication", "security"]);
const DEEP_CAPABILITIES = new Set([...PR_CAPABILITIES, "mutation", "race"]);

/** Return true when a capability belongs to a fixed profile. */
export function capabilityInProfile(capability, profile) {
  const capabilities = profile === "fast" ? FAST_CAPABILITIES : profile === "pr" ? PR_CAPABILITIES : DEEP_CAPABILITIES;
  return capabilities.has(capability);
}

/** Map a tool capability to language-independent policy rules. */
export function capabilityRules(capability) {
  return {
    format: ["correctness.format"],
    compile: ["correctness.compile"],
    typecheck: ["correctness.types"],
    lint: ["correctness.lint"],
    test: ["correctness.compile", "correctness.tests"],
    coverage: [],
    complexity: ["complexity.cognitive", "complexity.cyclomatic"],
    mutation: ["mutation.changed_score"],
    "dead-code": ["maintainability.dead_code"],
    dependencies: ["maintainability.unused_dependencies"],
    duplication: ["duplication.percent"],
    security: ["security.high_confidence"],
    race: ["correctness.tests"],
  }[capability] ?? [];
}

/** Build one command plan per project-configured tool capability in scope for a profile. */
export function projectToolPlans(component, profile) {
  return Object.entries(component.tools ?? {})
    .filter(([capability]) => capabilityInProfile(capability, profile))
    .map(([capability, tool]) => ({
      id: `${component.id}:${capability}`,
      componentId: component.id,
      capability,
      ruleIds: capabilityRules(capability),
      executable: tool.argv[0],
      argv: tool.argv.slice(1),
      cwd: component.absoluteRoot,
      timeoutSeconds: tool.timeout_seconds,
      report: tool.report,
      availability: "available",
      source: "project",
      requiresTrust: true,
    }));
}
