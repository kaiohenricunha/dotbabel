/** Native Mods I/O. No Node builtins, credential access, settings write or inference call. */
const validValue = value => typeof value === "string" && value.length > 0 && value.length <= 200 && !/[\p{Cc}\p{Cf}]/u.test(value);

async function privatePrepare($, options, request, action, native) {
  const payload = { action, request, ...(native === undefined ? {} : { native }) };
  // The session id keys the route command's catalog cache; it is the transcript name, not a secret.
  if (options.transport?.kind === "process") return processPrepare($, options.transport.argv, JSON.stringify({ ...payload, session: await $.session.id() }));
  const body = JSON.stringify(payload);
  if (typeof options.socketPath !== "string" || !options.socketPath.startsWith("/") || options.socketPath.length > 100) throw Error("native_bridge_unavailable");
  const response = await $.http.fetch("http://localhost/prepare", { method: "POST", socketPath: options.socketPath,
    headers: { "content-type": "application/json" }, body });
  if (!response.ok || typeof response.text !== "string" || response.text.length > 262144) throw Error("native_bridge_unavailable");
  return JSON.parse(response.text);
}

/** Persistent-plugin transport: the request goes on stdin of an absolute local command, never in argv. */
async function processPrepare($, argv, body) {
  if (!Array.isArray(argv) || argv.length < 1 || argv.length > 8 || !argv.every(validValue) || !argv[0].startsWith("/")) throw Error("native_bridge_unavailable");
  let result;
  try { result = await $.process.run(argv, { stdin: body, timeoutMs: 20000 }); } catch { throw Error("native_bridge_unavailable"); }
  if (result?.exitCode !== 0 || typeof result.stdout !== "string" || result.stdout.length > 262144) throw Error("native_bridge_unavailable");
  try { return JSON.parse(result.stdout); } catch { throw Error("native_bridge_unavailable"); }
}

async function nativeManual($, request, options) {
  const baseline = request.nativeAxes ?? request.current.axes;
  const settings = await $.settings.read();
  if (["availableModels", "deniedModels", "enforceAvailableModels", "maxEffortLevel", "modelOverrides", "availableModelsMatch"].some(key => Object.hasOwn(settings, key)) || Object.values(settings.modelSettings ?? {}).some(model => model && Object.hasOwn(model, "maxEffortLevel"))) return { unverifiedPolicy: true };
  // These documented controls can change the scratch probe's selector mapping or native limits.
  // Read presence only; do not forward their values, parse a deployment, or bypass native policy.
  const overrides = await Promise.all([
    $.env.get("ANTHROPIC_DEFAULT_HAIKU_MODEL"), $.env.get("ANTHROPIC_DEFAULT_SONNET_MODEL"),
    $.env.get("ANTHROPIC_DEFAULT_OPUS_MODEL"), $.env.get("ANTHROPIC_DEFAULT_FABLE_MODEL"),
    $.env.get("ANTHROPIC_BASE_URL"), $.env.get("CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST"),
  ]);
  if (overrides.some(value => value !== undefined && value !== "")) return { unverifiedPolicy: true };
  const modelEnv = await $.env.get("ANTHROPIC_MODEL");
  const effortEnv = await $.env.get("CLAUDE_CODE_EFFORT_LEVEL");
  const values = { model: settings.model ?? modelEnv, reasoning: settings.modelSettings?.[baseline.model]?.effortLevel ?? settings.effortLevel ?? effortEnv };
  const signatures = Object.fromEntries(Object.entries(values).map(([axis, value]) => [axis, JSON.stringify(value ?? null)]));
  const sameRoot = options.state.root === request.repoRoot;
  const manual = {};
  for (const axis of ["model", "reasoning"]) {
    let chosen = request.manual[axis] ?? { source: "unknown" };
    if (!sameRoot && chosen.source === "inherited" && options.manual?.[axis]?.source === "native-initial") chosen = { source: "native-initial" };
    if (chosen.source === "native-initial") chosen = { source: values[axis] === undefined ? "inherited" : "manual" };
    if (sameRoot && options.state.signatures[axis] !== signatures[axis]) chosen = { source: "manual" };
    else if (sameRoot && chosen.source === "inherited" && options.state.axes[axis] !== baseline[axis]) chosen = { source: "unknown" };
    const actual = baseline[axis];
    manual[axis] = chosen.source === "manual" ? { source: validValue(actual) ? "manual" : "unknown", ...(validValue(actual) ? { value: actual } : {}) } : { ...chosen };
  }
  options.state.root = request.repoRoot;
  options.state.signatures = signatures;
  options.state.axes = { ...baseline };
  return manual;
}

async function providerPages($) {
  const authorization = await $.session.authorize();
  if (!authorization?.handle) throw Error("native_transport_unavailable");
  const pages = []; const cursors = new Set(); let cursor; let length = 0;
  for (let page = 0; page < 10; page++) {
    const url = "https://api.anthropic.com/v1/models?limit=100" + (cursor === undefined ? "" : "&after_id=" + encodeURIComponent(cursor));
    const response = await $.http.fetch(url, { method: "GET", auth: authorization.handle, headers: { accept: "application/json", "anthropic-version": "2023-06-01" } });
    if (!response.ok || typeof response.text !== "string" || (length += response.text.length) > 262144) throw Error("native_catalog_unavailable");
    const body = JSON.parse(response.text);
    if (!Array.isArray(body.data) || typeof body.has_more !== "boolean") throw Error("native_catalog_invalid");
    pages.push(body);
    if (!body.has_more) return pages;
    if (!validValue(body.last_id) || cursors.has(body.last_id)) throw Error("native_catalog_invalid");
    cursor = body.last_id; cursors.add(cursor);
  }
  throw Error("native_catalog_invalid");
}

/**
 * Check project activation locally before reading native controls or requesting metadata. Send
 * prompts only to the private Unix socket. The native host alone consumes its authorization handle
 * for fixed official Models API GETs; neither the bridge nor a classifier receives that handle.
 * @param {object} $ Native Mods API.
 * @param {object} request Bounded current turn and axis provenance.
 * @param {object} options Trusted private socket, initial provenance, session state and optional test strategy.
 * @returns {Promise<object>} Shared-resolver decision plus measured manual-axis provenance.
 */
export async function prepareClaudeRoute($, request, options) {
  if (options.prepare) return options.prepare(request);
  const version = (await $.session.version()).version;
  const base = { ...request, runtimeVersion: version };
  const activation = await privatePrepare($, options, { repoRoot: request.repoRoot, prompt: "", runtimeVersion: version }, "activation");
  if (!activation.ready) return activation.decision;
  const manual = await nativeManual($, request, options);
  if (manual.unverifiedPolicy) return { status: "preserved", diagnostics: [{ code: "native_policy_unverified" }] };
  const prepared = { ...base, manual };
  prepared.current = { ...request.current, axes: { ...request.current.axes } };
  for (const axis of ["model", "reasoning"]) if (manual[axis].source !== "inherited") {
    const value = (request.nativeAxes ?? request.current.axes)[axis];
    if (value === undefined) delete prepared.current.axes[axis]; else prepared.current.axes[axis] = value;
  }
  const first = await privatePrepare($, options, prepared, "prepare");
  if (!first.needsEvidence) return { ...first.decision, manual };
  const rows = await $.config.list();
  const selectors = rows.find(row => row.key === "model")?.options;
  if (!Array.isArray(selectors) || selectors.length < 1 || selectors.length > 32 || !selectors.every(validValue)) throw Error("native_catalog_invalid");
  const pages = await providerPages($);
  const native = { version, selectors, providerPages: pages, observedAt: new Date().toISOString() };
  const result = await privatePrepare($, options, prepared, "prepare", native);
  if (result.needsEvidence || !result.decision) throw Error("native_catalog_unavailable");
  return { ...result.decision, manual };
}
