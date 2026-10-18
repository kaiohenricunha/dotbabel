/** Pure semantic constraint composition; specificity never removes a safety floor. */
import { ARTIFACT_KINDS, WORKLOAD_CLASSES, BINDINGS, RESOLUTION_MODES, isRuntimeId, compareWorkloadClass, checkOpaqueValue } from "../domain/index.mjs";

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
  let pin = input.policy.pin;
  let pinLayer = input.policy.provenance?.pin ?? "policy";
  const reasons = (input.policy.shadowed ?? []).map(() => ({ code: "lower_scope_pin_shadowed", message: "A more specific policy declaration shadows a lower-scope declaration." }));
  for (const [layer, next] of [["artifact", declaration?.pin], ["invocation", input.invocation?.pin]]) {
    if (next === undefined) continue;
    if (pin !== undefined) reasons.push({ code: "lower_scope_pin_shadowed", message: `The ${layer} pin supersedes a lower-scope pin.` });
    pin = next; pinLayer = layer;
  }
  if (pin !== undefined && !validPin(pin, input.target.runtimeId)) return { valid: false };
  const floor = strongest(input.policy.floor?.requirement, declaration?.mode === "floor" ? declaration.requirement : undefined);
  if (floor !== undefined) reasons.push({ code: "artifact_floor_applied", message: `The effective minimum is ${floor}.`, ...(declaration?.provenance ? { provenance: declaration.provenance } : {}) });
  if (pin !== undefined) reasons.push({ code: `${pinLayer}_pin_selected`, message: `The ${pinLayer} pin is the effective exact configuration.` });
  return { valid: true, requirement: strongest(floor, declaration?.mode === "inherit" ? undefined : declaration?.requirement), floor, pin, pinLayer, binding: declaration?.binding ?? "self", reasons };
}
