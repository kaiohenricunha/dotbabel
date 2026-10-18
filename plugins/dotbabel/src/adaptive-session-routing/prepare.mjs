/** Project-gated preparation. Nothing discovers or applies a model on the disabled path. */
import { readProjectActivation } from "../model-intelligence/activation/index.mjs";
import { classify as localClassify } from "./classifier/index.mjs";
import { route, isClassificationUsable } from "./route.mjs";

/**
 * Prepare a decision lazily after reading only the active project's activation.
 * The caller supplies capability loading; this module performs no discovery or application.
 * Original prompts and runtime parameters are never copied into diagnostic output.
 * @param {object} request Project root, prompt, bounded context and routing session inputs.
 * @param {{readActivation?: Function, classify?: Function, loadResolverInput?: Function}} [dependencies]
 * @returns {Promise<object>} A decision; exceptions preserve configuration with a coded diagnostic.
 */
export async function prepareRoute(request, dependencies = {}) {
  let stage = "project_config_unavailable";
  try {
    const activation = await (dependencies.readActivation ?? readProjectActivation)(request.repoRoot);
    if (activation.enabled !== true || activation.routingEnabled !== true) return route({ activation });
    if (request.runtimeCapability?.support !== "supported") return route({ activation, runtimeCapability: request.runtimeCapability });
    stage = "classification_failed";
    const classification = await (dependencies.classify ?? localClassify)({ prompt: request.prompt, context: request.context });
    if (!isClassificationUsable(classification)) return { status: "preserved", confidence: "low", diagnostics: [{ code: "classification_uncertain" }] };
    stage = "capability_evidence_unavailable";
    const resolverInput = await dependencies.loadResolverInput(request.repoRoot);
    return route({ activation, classification, resolverInput, current: request.current, manual: request.manual, runtimeCapability: request.runtimeCapability });
  } catch { return { status: "preserved", confidence: "low", diagnostics: [{ code: stage }] }; }
}
