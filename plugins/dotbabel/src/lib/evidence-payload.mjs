/**
 * The base64url payload line that rides under an evidence marker.
 *
 * Two evidence families now carry a machine-readable payload — `dotbabel
 * criteria` (`criteria/comment.mjs`) and `local-attest` (`attestation.mjs`) —
 * and both encode it the same way: line 1 is the SHA-pinned marker a grep can
 * find, line 2 is the whole payload, base64url-encoded so Markdown rendering
 * cannot touch it. Keeping one codec means the producer and the gate that
 * judges it cannot drift apart per family, which is the failure mode that
 * leaves a command posting evidence its own gate cannot read.
 *
 * Pure: no I/O, no crypto, no clock.
 */

/** Closing text every payload line ends with, matching the marker's own. */
const LINE_SUFFIX = " -->";

/**
 * Encode a payload into its comment line.
 *
 * @param {string} prefix Opening text, e.g. `"<!-- local-attest-payload "`.
 * @param {object} payload
 * @returns {string}
 */
export function encodePayloadLine(prefix, payload) {
  return `${prefix}${Buffer.from(JSON.stringify(payload)).toString("base64url")}${LINE_SUFFIX}`;
}

/**
 * @typedef {object} DecodedPayload
 * @property {"ok"|"absent"|"undecodable"} state
 * @property {object|null} payload
 * @property {string|null} detail Why it failed, for a gate's reason detail.
 */

/**
 * Decode the payload line out of a comment body.
 *
 * `absent` and `undecodable` are separate states on purpose. A body with no
 * payload line may simply predate the payload (an older tool version wrote
 * it); a body whose payload line will not decode is corrupt or forged. A gate
 * may choose to treat them alike, but it must not be forced to.
 *
 * @param {string} prefix
 * @param {unknown} body
 * @param {number} [lineIndex] Which line carries the payload (default 1, i.e. the second).
 * @returns {DecodedPayload}
 */
export function decodePayloadLine(prefix, body, lineIndex = 1) {
  if (typeof body !== "string") return { state: "absent", payload: null, detail: "body is not a string" };
  const line = body.split("\n")[lineIndex] ?? "";
  if (!line.startsWith(prefix) || !line.endsWith(LINE_SUFFIX)) {
    return { state: "absent", payload: null, detail: `line ${lineIndex + 1} is not the payload comment` };
  }

  const encoded = line.slice(prefix.length, -LINE_SUFFIX.length).trim();
  let payload;
  try {
    payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch (err) {
    return { state: "undecodable", payload: null, detail: `payload did not decode: ${err.message}` };
  }
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return { state: "undecodable", payload: null, detail: "payload is not an object" };
  }
  return { state: "ok", payload, detail: null };
}
