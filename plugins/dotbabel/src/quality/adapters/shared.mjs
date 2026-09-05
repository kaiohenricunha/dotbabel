/** Return true when a capability belongs to a fixed profile. */
export function capabilityInProfile(capability, profile) {
  const fast = new Set(["format", "compile", "typecheck", "lint", "complexity"]);
  const pr = new Set([...fast, "test", "coverage", "dead-code", "dependencies", "duplication", "security"]);
  const deep = new Set([...pr, "mutation", "race"]);
  return (profile === "fast" ? fast : profile === "pr" ? pr : deep).has(capability);
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
