/** Pure semantic constraint composition; specificity never removes a safety floor. */
import { ARTIFACT_KINDS, WORKLOAD_CLASSES, EFFORT_INTENTS, BINDINGS, RESOLUTION_MODES, isRuntimeId, compareWorkloadClass, checkOpaqueValue } from "../domain/index.mjs";

/** @param {unknown} value @returns {boolean} */
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
/** @param {string|undefined} a @param {string|undefined} b @returns {string|undefined} */
const strongest = (a, b) => a === undefined ? b : b === undefined ? a : compareWorkloadClass(a, b) >= 0 ? a : b;
/** @param {object} pin @param {string} runtime @returns {boolean} */
function validPin(pin, runtime) {
  return object(pin) && pin.runtime === runtime && object(pin.config) && Object.keys(pin.config).length > 0 && Object.entries(pin.config).every(([key, value]) => /^[a-z][A-Za-z0-9]{0,63}$/.test(key) && typeof value === "string" && checkOpaqueValue(key, value));
}
/**
 * Normalize the resolver's supplied constraints, without loading policy or evidence.
 * @param {object} input
 * @returns {{valid: boolean, requirement?: string, floor?: string, pin?: object, pinLayer?: string, binding?: string, reasons?: object[]}}
 */
export function compose(input) {
  if (!object(input) || !object(input.target) || !isRuntimeId(input.target.runtimeId) || !ARTIFACT_KINDS.includes(input.target.artifactKind) || !object(input.policy) || !object(input.policy.classes) || !object(input.catalog) || !Array.isArray(input.catalog.runtimes) || !object(input.runtimeContract)) return { valid: false };
  const declaration = input.requirement;
  if (declaration !== undefined && (!object(declaration) || !BINDINGS.includes(declaration.binding) || !RESOLUTION_MODES.includes(declaration.mode) || (declaration.mode === "inherit" ? declaration.requirement !== undefined || declaration.pin !== undefined : !WORKLOAD_CLASSES.includes(declaration.requirement)) || (declaration.mode === "pin" ? !validPin(declaration.pin, input.target.runtimeId) : declaration.pin !== undefined))) return { valid: false };
  if (input.policy.floor !== undefined && (!object(input.policy.floor) || input.policy.floor.mode !== "floor" || !WORKLOAD_CLASSES.includes(input.policy.floor.requirement))) return { valid: false };
  const invocation = input.invocation === undefined ? {} : input.invocation;
  if (!object(invocation) || Object.keys(invocation).some(key => !["pin", "overrides", "requiredModalities", "requiredCapabilities", "effortIntent", "modelSelection"].includes(key))) return { valid: false };
  if (invocation.requiredCapabilities !== undefined && (!object(invocation.requiredCapabilities) || Object.keys(invocation.requiredCapabilities).length > 32 || Object.entries(invocation.requiredCapabilities).some(([key, value]) => !/^[a-z][a-z0-9_]{0,63}$/.test(key) || typeof value !== "boolean"))) return { valid: false };
  if (invocation.requiredModalities !== undefined && (!Array.isArray(invocation.requiredModalities) || invocation.requiredModalities.length > 32 || invocation.requiredModalities.some(value => typeof value !== "string" || !checkOpaqueValue("modality", value)))) return { valid: false };
  if (invocation.modelSelection !== undefined && !["automatic", "explicit"].includes(invocation.modelSelection)) return { valid: false };
  if (invocation.effortIntent !== undefined && !EFFORT_INTENTS.includes(invocation.effortIntent)) return { valid: false };
  if (invocation.overrides !== undefined && (!object(invocation.overrides) || Object.keys(invocation.overrides).length > 0 && !validPin({ runtime: input.target.runtimeId, config: invocation.overrides }, input.target.runtimeId))) return { valid: false };
  let pin = input.policy.pin;
  let pinLayer = input.policy.provenance?.pin ?? "policy";
  const reasons = (input.policy.shadowed ?? []).map(() => ({ code: "lower_scope_pin_shadowed", message: "A more specific policy declaration shadows a lower-scope declaration." }));
  for (const [layer, next] of [["artifact", declaration?.pin], ["invocation", invocation.pin]]) {
    if (next === undefined) continue;
    if (pin !== undefined) reasons.push({ code: "lower_scope_pin_shadowed", message: `The ${layer} pin supersedes a lower-scope pin.` });
    pin = next; pinLayer = layer;
  }
  if (pin !== undefined && !validPin(pin, input.target.runtimeId)) return { valid: false };
  const manualOverrides = Object.keys(invocation.overrides ?? {}).length > 0;
  if (manualOverrides) {
    if (pin !== undefined) reasons.push({ code: Object.keys(pin.config).some(key => !Object.hasOwn(invocation.overrides, key)) ? "lower_scope_axes_preserved" : "lower_scope_pin_shadowed", message: "Manual overrides affect only explicitly selected axes; untouched pinned axes remain in force." });
    pin = { runtime: input.target.runtimeId, config: { ...pin?.config, ...invocation.overrides } };
    pinLayer = "manual";
    reasons.push({ code: "manual_selection_preserved", message: "Explicit per-axis controls take precedence without removing a mandatory floor." });
  }
  if (invocation.modelSelection === "explicit" && pin?.config.model === undefined) return { valid: false };
  const ordinarySelection = invocation.modelSelection === "automatic" || pin?.config.model === undefined;
  const floor = strongest(input.policy.floor?.requirement, declaration?.mode === "floor" ? declaration.requirement : undefined);
  if (floor !== undefined) reasons.push({ code: "artifact_floor_applied", message: `The effective minimum is ${floor}.`, ...(declaration?.provenance ? { provenance: declaration.provenance } : {}) });
  if (pin !== undefined) reasons.push({ code: `${pinLayer}_pin_selected`, message: `The ${pinLayer} pin is the effective exact configuration.` });
  return { valid: true, requirement: strongest(floor, declaration?.mode === "inherit" ? undefined : declaration?.requirement), floor, pin, pinLayer, binding: declaration?.binding ?? "self", requiredModalities: [...(invocation.requiredModalities ?? [])], requiredCapabilities: { ...(invocation.requiredCapabilities ?? {}) }, effortIntent: invocation.effortIntent, manualOverrides, ordinarySelection, reasons };
}
