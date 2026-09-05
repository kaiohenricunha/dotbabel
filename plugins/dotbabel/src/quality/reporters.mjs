import { QUALITY_RESULT_SCHEMA_VERSION } from "./types.mjs";

/** Wrap quality output in its stable JSON envelope. */
export function qualityEnvelope(command, body) {
  return { schema_version: QUALITY_RESULT_SCHEMA_VERSION, command, ...body };
}

/** Render a human quality report grouped by component and policy class. */
export function renderQualityHuman(report) {
  if (report.state === "disabled") return "dotbabel quality: disabled by project policy\n";
  if (report.command === "detect") return renderDetection(report);
  if (report.command === "explain") return renderPolicy(report);
  const lines = [`dotbabel quality ${report.command}: ${report.verdict ?? "ok"}`];
  let group = "";
  for (const item of report.results ?? []) {
    const next = `${item.component ?? "repository"} / ${item.class}`;
    if (next !== group) { group = next; lines.push("", group); }
    lines.push(`  ${item.verdict.padEnd(4)} ${item.rule} [${item.state}]${item.message ? ` — ${item.message}` : ""}`);
  }
  if (report.command === "baseline" && report.baseline) {
    lines.push("", "Candidate baseline:", JSON.stringify(report.baseline, null, 2));
  }
  return `${lines.join("\n")}\n`;
}

function renderDetection(report) {
  const lines = ["dotbabel quality detect", `Project command trust: ${report.trust?.trusted ? "trusted" : "not trusted"}`];
  for (const component of report.components ?? []) {
    lines.push("", `${component.id} [${component.state}]`, `  markers: ${(component.markers ?? []).join(", ") || "source files"}`);
    for (const plan of (report.plans ?? []).filter((item) => item.componentId === component.id)) {
      const command = plan.executable ? `${plan.executable} ${(plan.argv ?? []).join(" ")}`.trim() : (plan.candidates ?? []).join(", ");
      lines.push(`  ${plan.capability}: ${plan.availability} (${plan.source ?? "unselected"})${command ? ` - ${command}` : ""}`);
    }
  }
  for (const exclusion of report.exclusions ?? []) lines.push(`excluded: ${exclusion.count} file(s), ${exclusion.reason}`);
  for (const candidate of report.rejected_candidates ?? []) lines.push(`rejected: ${candidate}`);
  return `${lines.join("\n")}\n`;
}

function renderPolicy(report) {
  const lines = [`dotbabel quality explain: profile=${report.profile}`];
  for (const rule of Object.values(report.policy?.rules ?? {})) {
    const threshold = rule.threshold === undefined ? "" : ` threshold=${rule.threshold}`;
    const provenance = rule.provenance?.threshold ?? rule.provenance?.level ?? "shipped";
    lines.push(`${rule.id}: class=${rule.class} scope=${rule.scope} level=${rule.level}${threshold} on_unavailable=${rule.on_unavailable} provenance=${provenance}`);
  }
  return `${lines.join("\n")}\n`;
}
