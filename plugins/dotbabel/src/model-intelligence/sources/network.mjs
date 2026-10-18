/** Bounded response reads shared by credential-neutral source adapters. */

/**
 * Read at most the caller's remaining response budget and cancel on abort or overflow.
 * @param {Response} response Native or caller-owned fetch response.
 * @param {AbortSignal} signal The whole operation's deadline signal.
 * @param {number} maxBytes Remaining byte budget, including all earlier pages.
 * @returns {Promise<{tooLarge:true}|{tooLarge:false,bytes:Buffer}>} Bounded raw bytes.
 */
export async function readBoundedResponse(response, signal, maxBytes) {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => {});
    return { tooLarge: true };
  }
  if (response.body === null) return { tooLarge: false, bytes: Buffer.alloc(0) };
  const reader = response.body.getReader();
  const cancel = () => { reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", cancel, { once: true });
  const chunks = []; let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) { cancel(); return { tooLarge: true }; }
      chunks.push(value);
    }
  } finally { signal.removeEventListener("abort", cancel); }
  return { tooLarge: false, bytes: Buffer.concat(chunks) };
}
