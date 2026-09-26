/**
 * model-intelligence/sources/runtime/adapter-kit — the mechanical skeleton every runtime adapter shares
 * (docs/specs/model-intelligence, §5 `Source Adapter Contract`, ARCH-47, ARCH-49).
 *
 * The spec plans six runtime adapters. Claude and Codex repeated the same small sequences, and a
 * third adapter getting one of them subtly wrong would be a provenance bug, not a style one: the
 * version stamp that must appear on both the result and the evidence only when the runtime reported a
 * real version, and the `renderInvocation` guard that names every axis it cannot express (ARCH-49).
 *
 * Only mechanics live here. There is no runtime-specific branching, so each adapter still reads top
 * to bottom as its own measured account of one CLI.
 */

import { isPlainObject, isVersionString, makeAdapterResult } from "../contract.mjs";
import { makeInvocation } from "../evidence.mjs";
import { assertOpaqueValue } from "./process.mjs";

/**
 * The provenance every result from one runtime adapter starts from. A fresh object on each call.
 * @param {string} runtimeId
 * @param {string} adapterVersion
 * @returns {{sourceId: string, sourceKind: "runtime", adapterVersion: string}}
 */
export function runtimeProvenance(runtimeId, adapterVersion) {
  return { sourceId: runtimeId, sourceKind: "runtime", adapterVersion };
}

/**
 * Provenance with `sourceVersion` added only when `version` has the shape of a version. Text that is
 * not a version, or no version at all, leaves the provenance without one rather than inventing it.
 * @param {object} provenance
 * @param {unknown} version
 * @returns {object}
 */
export function withSourceVersion(provenance, version) {
  return isVersionString(version) ? { ...provenance, sourceVersion: version } : { ...provenance };
}

/**
 * The evidence field that carries the same version, spread into an evidence builder's input.
 * @param {unknown} version
 * @returns {{runtimeVersion?: string}}
 */
export function runtimeVersionField(version) {
  return isVersionString(version) ? { runtimeVersion: /** @type {string} */ (version) } : {};
}

/**
 * An `unknown` result: the runtime answered, but not with anything this adapter can use.
 * @param {{now: () => string}} ctx
 * @param {object} provenance
 * @param {string} code
 * @param {string} message
 * @returns {object}
 */
export function unknownResult(ctx, provenance, code, message) {
  return makeAdapterResult({ status: "unknown", provenance, observedAt: ctx.now(), diagnostic: { code, message } });
}

/**
 * Render a resolved configuration as structured arguments for one runtime (ARCH-47).
 *
 * `axisArgs` maps each axis the runtime can express to the arguments that express it. Every other axis
 * of the configuration is named in `unsupportedAxes` rather than dropped (ARCH-49). Each value passes
 * `assertOpaqueValue` first, so it cannot be read as an option, and nothing is executed. Like every
 * `renderInvocation`, this throws on an invalid value (failure channels, `contract.mjs`).
 * @param {object} input
 * @param {string} input.runtimeId
 * @param {string} input.command
 * @param {unknown} input.resolvedConfig
 * @param {Readonly<Record<string, (value: string) => string[]>>} input.axisArgs In the order the arguments are emitted.
 * @returns {Readonly<import("../evidence.mjs").Invocation>}
 */
export function renderInvocationFor({ runtimeId, command, resolvedConfig, axisArgs }) {
  const config = /** @type {any} */ (resolvedConfig);
  if (!isPlainObject(config) || config.runtimeId !== runtimeId || !isPlainObject(config.axes)) {
    throw new TypeError(`${runtimeId} renderInvocation: the configuration is not a resolved ${runtimeId} configuration`);
  }
  const axes = /** @type {Record<string, unknown>} */ (config.axes);
  /** @type {string[]} */
  const args = [];
  for (const [name, toArgs] of Object.entries(axisArgs)) {
    if (axes[name] !== undefined) args.push(...toArgs(assertOpaqueValue(name, axes[name])));
  }
  const unsupportedAxes = Object.keys(axes)
    .filter((name) => !Object.hasOwn(axisArgs, name))
    .sort();
  return makeInvocation({ runtimeId, command, args, unsupportedAxes });
}
