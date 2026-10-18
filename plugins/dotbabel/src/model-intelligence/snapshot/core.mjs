/** Immutable accepted release evidence; operational clocks remain outside snapshot identity. */
import fs from "node:fs";
import Ajv from "ajv";
import addFormats from "ajv-formats";
import { resolve } from "../resolver/index.mjs";
import { mergePolicy, SHIPPED_POLICY } from "../policy/index.mjs";
import { RUNTIME_IDS } from "../domain/index.mjs";
import { validateDescriptor } from "../sources/contract.mjs";
import { canonicalJson, hashContent } from "../materialize/manifest.mjs";

const schema = JSON.parse(fs.readFileSync(new URL("../../../../../schemas/dotbabel.release-capabilities.schema.json", import.meta.url), "utf8"));
const ajv = new Ajv({ strict: true, allErrors: false }); addFormats(ajv);
const validShape = ajv.compile(schema);
const fail = code => Object.assign(new Error(code), { code });
const sourceKey = source => canonicalJson({ sourceId: source.sourceId, sourceKind: source.sourceKind, sourceVersion: source.sourceVersion ?? null, adapterVersion: source.adapterVersion ?? null });
const digest = snapshot => { const { snapshotId, ...content } = snapshot; return hashContent(canonicalJson(content, true)); };
const envelopes = runtime => runtime.models.flatMap(model => Object.values(model.fields).flat());
/** @param {object} snapshot Validated release input. @param {object} provenance Exact source identity. @returns {object} Its accepted source record. */
export function releaseSourceFor(snapshot, provenance) {
  const found = snapshot.sources.find(source => sourceKey(source) === sourceKey(provenance));
  if (!found) throw fail("snapshot_provenance_unknown");
  return found;
}
function verifyContent(snapshot) {
  if (!validShape(snapshot) || Buffer.byteLength(canonicalJson(snapshot)) > 4 * 1024 * 1024 || !snapshot.runtimes.claude) throw fail("snapshot_invalid");
  for (const source of snapshot.sources) if (source.url !== undefined) {
    const url = new URL(source.url); if (url.username || url.password || url.search || url.hash) throw fail("snapshot_source_url_invalid");
  }
  const keys = snapshot.sources.map(sourceKey); if (new Set(keys).size !== keys.length) throw fail("snapshot_source_duplicate");
  for (const [runtimeId, runtime] of Object.entries(snapshot.runtimes)) {
    if (!RUNTIME_IDS.includes(runtimeId) || runtime.provenance.sourceId !== runtimeId || runtime.provenance.sourceKind !== "runtime") throw fail("snapshot_runtime_invalid");
    releaseSourceFor(snapshot, runtime.provenance);
    const contract = runtime.runtimeContract;
    if (contract.id !== runtimeId || contract.kind !== "runtime" || validateDescriptor(contract).errors.length) throw fail("snapshot_runtime_contract_invalid");
    if (new Set(runtime.models.map(model => model.model)).size !== runtime.models.length) throw fail("snapshot_model_duplicate");
    for (const model of runtime.models) {
      for (const identity of model.fields.id) if (identity.value !== model.model || identity.provenance.sourceId !== runtimeId || identity.provenance.sourceKind !== "runtime") throw fail("snapshot_identity_unverified");
      for (const entry of Object.values(model.fields).flat()) releaseSourceFor(snapshot, entry.provenance);
    }
  }
  return snapshot;
}

/**
 * Accept already-normalized source facts; do not copy live cache state or infer a model ranking.
 * @param {object} input Explicit sources and runtime field-level facts.
 * @returns {object} Canonically ordered immutable release input with a deterministic digest.
 */
export function createSnapshot(input) {
  const snapshot = JSON.parse(canonicalJson({ ...input, schemaVersion: 1, snapshotId: "sha256:" + "0".repeat(64) }));
  verifyContent(snapshot);
  snapshot.sources.sort((a, b) => sourceKey(a) < sourceKey(b) ? -1 : sourceKey(a) > sourceKey(b) ? 1 : 0);
  for (const runtime of Object.values(snapshot.runtimes)) {
    runtime.models.sort((a, b) => a.model < b.model ? -1 : a.model > b.model ? 1 : 0);
    for (const model of runtime.models) for (const entries of Object.values(model.fields)) entries.sort((a, b) => { const x = canonicalJson(a, true), y = canonicalJson(b, true); return x < y ? -1 : x > y ? 1 : 0; });
  }
  snapshot.snapshotId = digest(snapshot); return snapshot;
}

/** @param {object} snapshot Untrusted persisted data. @returns {object} Validated input, unchanged. */
export function validateSnapshot(snapshot) {
  verifyContent(snapshot);
  if (snapshot.snapshotId !== createSnapshot(snapshot).snapshotId) throw fail("snapshot_identity_mismatch");
  return snapshot;
}

/**
 * Rehydrate accepted release facts for the existing resolver, never for live session eligibility.
 * The fixed fresh/available envelopes mean accepted release support, not current account entitlement.
 * @param {object} snapshot Validated accepted evidence.
 * @returns {object} Release-scoped, clock-independent resolver catalog.
 */
export function snapshotCatalog(snapshot) {
  validateSnapshot(snapshot);
  return { scope: "release", sources: snapshot.sources.map(source => ({ ...source })), models: [], runtimes: Object.entries(snapshot.runtimes).map(([runtimeId, runtime]) => ({ runtimeId, models: runtime.models.map(model => ({ model: model.model, fields: Object.fromEntries(Object.entries(model.fields).map(([key, entries]) => [key, entries.map(entry => ({ ...structuredClone(entry), freshness: "fresh", availability: "available", refresh: "idle" }))])) })) })) };
}

/**
 * Check only required backing evidence against the seven-day release gate (OPS-1).
 * @param {object} snapshot Validated accepted evidence.
 * @param {{now:string}} options Explicit operational clock.
 * @returns {object} Read-only release age and validity, without changing identity or build facts.
 */
export function releaseSnapshotStatus(snapshot, { now } = {}) {
  validateSnapshot(snapshot);
  const dates = Object.values(snapshot.runtimes).flatMap(runtime => [releaseSourceFor(snapshot, runtime.provenance).observedAt, ...envelopes(runtime).flatMap(entry => [releaseSourceFor(snapshot, entry.provenance).observedAt, ...(entry.observedAt === undefined ? [] : [entry.observedAt])])]);
  const ages = dates.map(date => Date.parse(now) - Date.parse(date));
  if (!ages.length || ages.some(age => !Number.isFinite(age) || age < 0)) return { valid: false, reason: "release_evidence_time_invalid", snapshotId: snapshot.snapshotId, releaseSnapshotAgeMs: null };
  const releaseSnapshotAgeMs = Math.max(...ages);
  return { valid: releaseSnapshotAgeMs <= 7 * 86400000, reason: releaseSnapshotAgeMs <= 7 * 86400000 ? "release_evidence_current" : "release_evidence_stale", snapshotId: snapshot.snapshotId, releaseSnapshotAgeMs };
}

/**
 * Verify required release configurations through the existing resolver and shipped policy.
 * @param {object} snapshot Validated immutable release evidence.
 * @param {object[]} requests Explicit required targets and canonical requirements.
 * @param {object} [policy] Effective release policy; defaults to shipped policy.
 * @returns {object} A semantic verdict and the original resolver results.
 */
export function checkReleaseRequirements(snapshot, requests, policy = mergePolicy({ shipped: SHIPPED_POLICY })) {
  validateSnapshot(snapshot);
  const catalog = snapshotCatalog(snapshot);
  const results = requests.map(request => {
    const runtime = snapshot.runtimes[request.runtimeId];
    return resolve({ requirement: request.requirement, target: { runtimeId: request.runtimeId, artifactKind: request.artifactKind }, catalog, policy, runtimeContract: runtime?.runtimeContract });
  });
  const valid = results.every(result => result.status === "resolved" && result.confidence !== "low" && result.enforcement.state !== "unsatisfied");
  return { valid, results, diagnostics: valid ? [] : [{ code: "release_requirement_unsatisfied" }] };
}


/** @param {object} snapshot Validated release input. @returns {string} Canonical, reviewable UTF-8 JSON bytes. */
export function serializeSnapshot(snapshot) {
  validateSnapshot(snapshot);
  return JSON.stringify(createSnapshot(snapshot), null, 2) + "\n";
}
