/** Fast unit selection for mutation checks; acceptance also runs HTTP/process tests. */
import base from "./vitest.config.mjs";
export default {
  ...base,
  test: {
    ...base.test,
    include: ["plugins/dotbabel/tests/decider.test.mjs", "plugins/dotbabel/tests/decider-config.test.mjs", "plugins/dotbabel/tests/decision-value.test.mjs", "plugins/dotbabel/tests/export.test.mjs", "plugins/dotbabel/tests/fleet-token.test.mjs", "plugins/dotbabel/tests/fleet-merge-queue.test.mjs", "plugins/dotbabel/tests/fleet-platform.test.mjs", "plugins/dotbabel/tests/jev-adapter.test.mjs", "plugins/dotbabel/tests/run-receipt.test.mjs"],
  },
};
