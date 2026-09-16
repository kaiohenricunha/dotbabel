/**
 * Shared factory for a hidden-comment marker: a first line a CI gate greps
 * for, naming the head SHA a trusted comment attests. `local-attest-lib.mjs`
 * (`<!-- local-attest verified-sha=`) and the `dotbabel criteria` evidence
 * comment (`<!-- dotbabel-criteria verified-sha=`) share this implementation
 * rather than each keeping their own copy (KD-2).
 *
 * @typedef {object} Comment
 * @property {number|string} [id]
 * @property {string} author_association
 * @property {string} body
 */

const SHA_RE = /^[0-9a-f]{7,40}$/i;

/**
 * @param {string} prefix e.g. `"<!-- local-attest verified-sha="`
 * @returns {{
 *   prefix: string,
 *   build: (sha: string) => string,
 *   isAttested: (comments: Comment[], headSha: string, opts?: { trustedAssociations?: string[] }) => boolean,
 *   find: (comments: Comment[]) => Comment|null,
 * }}
 */
export function createMarker(prefix) {
  /**
   * Build the hidden marker the CI gate greps for. Throws on a non-SHA so a
   * malformed value can never produce a marker that silently never matches.
   *
   * @param {string} sha
   * @returns {string}
   */
  function build(sha) {
    if (typeof sha !== "string" || !SHA_RE.test(sha)) {
      throw new Error(`invalid sha: ${JSON.stringify(sha)}`);
    }
    return `${prefix}${sha} -->`;
  }

  /**
   * True iff a comment from a trusted author attests this exact head SHA.
   * Trust is determined by `trustedAssociations` (default `["OWNER"]`) — a
   * non-trusted user cannot forge a skip by commenting the marker.
   *
   * @param {Comment[]} comments
   * @param {string} headSha
   * @param {{ trustedAssociations?: string[] }} [opts]
   * @returns {boolean}
   */
  function isAttested(comments, headSha, opts = {}) {
    if (!Array.isArray(comments) || typeof headSha !== "string" || headSha === "") {
      return false;
    }
    let marker;
    try {
      marker = build(headSha);
    } catch {
      return false;
    }
    const trusted = new Set(opts.trustedAssociations ?? ["OWNER"]);
    return comments.some(
      (c) =>
        c &&
        trusted.has(c.author_association) &&
        typeof c.body === "string" &&
        c.body.split("\n")[0] === marker,
    );
  }

  /**
   * Find any existing comment carrying this marker prefix (any SHA, any
   * author) so a caller can update or minimize it instead of ignoring it.
   *
   * @param {Comment[]} comments
   * @returns {Comment|null}
   */
  function find(comments) {
    if (!Array.isArray(comments)) return null;
    return comments.find((c) => c && typeof c.body === "string" && c.body.includes(prefix)) ?? null;
  }

  /**
   * The SHA a comment's marker names, or null when line 1 is not this
   * marker. The gate needs the SHA itself, not just a yes/no — it has to
   * tell "attests an older commit" (stale) from "attests nothing" (missing),
   * and those are different reason codes.
   *
   * Anchored at line 1 for the same reason `isAttested` is: a marker quoted
   * later in a body is a quotation, not an attestation.
   *
   * @param {string} body
   * @returns {string|null}
   */
  function parseSha(body) {
    if (typeof body !== "string") return null;
    const line = body.split("\n")[0];
    if (!line.startsWith(prefix) || !line.endsWith(" -->")) return null;
    const sha = line.slice(prefix.length, -" -->".length).trim();
    return SHA_RE.test(sha) ? sha : null;
  }

  return { prefix, build, isAttested, find, parseSha };
}
