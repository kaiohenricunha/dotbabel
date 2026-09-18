/**
 * Stryker configuration for the `dotbabel quality` harness (P-F1).
 *
 * Identical to `stryker.config.mjs` except that it carries no `break`
 * threshold, and `package.json`'s `mutation` script — the argv the declared
 * `mutation` tool in `.dotbabel.json` runs — points here.
 *
 * `break` and a parsed report are mutually exclusive. `quality/index.mjs:25-35`
 * parses a tool's report only when the tool exits 0, and `coverage` is the one
 * capability it rescues from a non-zero exit. With `break` set, a score below
 * the floor makes Stryker exit non-zero, so no mutation metric is ever computed
 * and `quality/evaluate.mjs:29` reports the tool's stdout as the verdict
 * message instead of a score.
 *
 * It would also mis-attribute the result. `mutation.changed_score` is a
 * CHANGED-scope rule (`quality/policy.mjs:41`), while `break` judges the whole
 * `mutate` glob, so a run whose diff touches nothing under that glob would
 * still fail on pre-existing code — the conflation `quality/reports.mjs:150-152`
 * refuses for mutmut.
 *
 * The 85 floor is not lost: the harness applies it through
 * `mutation.changed_score` (`quality/policy.mjs:41`, error severity in `deep`),
 * and `stryker.config.mjs` keeps `break: 85` for the direct per-unit runs that
 * IMPL-6 and `docs/specs/model-intelligence` TEST-3 prescribe.
 */
import base from "./stryker.config.mjs";

const { break: _break, ...thresholds } = base.thresholds;

export default { ...base, thresholds };
