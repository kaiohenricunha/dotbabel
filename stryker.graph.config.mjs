/** Graph engineering mutation checks retain the shipped 85% threshold.
 * Inherit the repaired Vitest 5 runner from the repository configuration.
 * Explicit unit selection avoids the upstream related-file discovery defect.
 * The real five-second HTTP deadline is exercised separately in acceptance.
 */
import base from "./stryker.config.mjs";
export default {
  ...base,
  mutate: ["plugins/dotbabel/src/decider.mjs", "plugins/dotbabel/src/decider-config.mjs", "plugins/dotbabel/src/decision-value.mjs", "plugins/dotbabel/src/export.mjs", "plugins/dotbabel/src/jev-adapter.mjs", "plugins/dotbabel/src/fleet/merge-queue.mjs", "plugins/dotbabel/src/fleet/platform-adapter.mjs"],
  vitest: { configFile: "vitest.graph.config.mjs", related: false },
  concurrency: 2,
  reporters: ["clear-text", "progress", "json"],
};
