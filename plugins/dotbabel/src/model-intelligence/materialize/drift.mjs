/** Pure projection drift classification. Generated output never becomes canonical input. */
/**
 * Classify one target against the last committed generation and current canonical derivation.
 * @param {{previous?: object, expected?: object, outputHash?: string}} input Hashes only, never output metadata.
 * @returns {string} clean, user-drift, stale, diverged, missing, orphan or unowned.
 */
export function classifyDrift({ previous, expected, outputHash }) {
  if (expected === undefined) return "orphan";
  if (outputHash === undefined) return "missing";
  if (previous === undefined) return "unowned";
  const outputMatches = outputHash === previous.outputHash;
  const inputsMatch = expected.inputsHash === previous.inputsHash;
  return outputMatches ? inputsMatch ? "clean" : "stale" : inputsMatch ? "user-drift" : "diverged";
}
