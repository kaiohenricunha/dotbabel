/** Read-only handoff consumer of the existing runtime source-adapter registry. */
import { openSync, closeSync, fstatSync, readSync, constants } from "node:fs";
import { isRuntimeId } from "../domain/index.mjs";
import { SOURCE_ADAPTERS } from "../sources/index.mjs";
import { MAX_OUTPUT_BYTES } from "../sources/runtime/process.mjs";
const unknown = code => ({ status: "unknown", diagnostic: { code, message: "Transcript observation is unavailable." } });

/**
 * Read one bounded regular file and pass its bytes to the existing adapter without starting a runtime.
 * Unsupported adapters return a diagnostic without reading the path. No transcript text is returned.
 * @param {string} runtimeId Canonical runtime id.
 * @param {string} file Explicit transcript path.
 * @param {{now?:Function,adapters?:object[]}} [options] Caller clock and adapter handles for testing.
 * @returns {Promise<object>} The adapter's observation result, or a bounded consumer diagnostic.
 */
export async function observeTranscript(runtimeId, file, options = {}) {
  if (!isRuntimeId(runtimeId)) return unknown("observation_runtime_invalid");
  const adapter = (options.adapters ?? SOURCE_ADAPTERS).find(entry => entry.descriptor.kind === "runtime" && entry.descriptor.id === runtimeId);
  if (adapter?.descriptor.capabilities.observation?.support === "unverified") return unknown("observation_unverified");
  if (!adapter || adapter.descriptor.capabilities.observation?.support !== "supported") return { status: "unsupported", diagnostic: { code: "observation_unsupported", message: "This runtime has no supported transcript observation adapter." } };
  if (typeof adapter.observeStream !== "function") return unknown("observation_stream_unavailable");
  let fd, stream;
  try {
    if (typeof constants.O_NOFOLLOW !== "number") return unknown("observation_file_unsupported");
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const before = fstatSync(fd);
    if (!before.isFile() || before.size > MAX_OUTPUT_BYTES) return unknown("observation_file_invalid");
    const buffer = Buffer.alloc(before.size + 1);
    const size = readSync(fd, buffer, 0, buffer.length, 0), after = fstatSync(fd);
    if (size !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) return unknown("observation_file_changed");
    stream = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, size));
  } catch { return unknown("observation_file_unavailable"); }
  finally { if (fd !== undefined) closeSync(fd); }
  try { return await adapter.observeStream(stream, options.now ? { now: options.now } : {}); }
  catch { return unknown("observation_failed"); }
}
