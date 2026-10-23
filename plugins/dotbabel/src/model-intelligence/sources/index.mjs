/**
 * model-intelligence/sources — the source adapters this build ships (docs/specs/model-intelligence,
 * §5 `Source Adapter Contract`).
 *
 * Each entry is the adapter module itself: its `descriptor`, operations and exports. `catalog/` takes
 * these handles from its caller and imports no adapter, so this list is the one place that names them.
 * The order is the order `dotbabel models status` reports them in.
 */

import * as claude from "./runtime/claude.mjs";
import * as codex from "./runtime/codex.mjs";
import * as gemini from "./runtime/gemini.mjs";
import * as copilot from "./runtime/copilot.mjs";
import * as modelsDev from "./knowledge/models-dev.mjs";
import * as anthropic from "./knowledge/anthropic.mjs";

/** Every shipped adapter module, runtimes first. */
export const SOURCE_ADAPTERS = Object.freeze([claude, codex, gemini, copilot, modelsDev, anthropic]);
