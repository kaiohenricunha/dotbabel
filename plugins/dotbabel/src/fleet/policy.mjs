/**
 * Pure decisions for `dotbabel fleet`: repo identity, claim matching, the
 * allow / deny / ask verdict for one edit, and claim-record edits.
 *
 * No filesystem and no processes: bin/dotbabel-fleet.mjs gathers the facts
 * (git, the session registry, the ledger) and this module judges them.
 *
 * A claim is `{ pattern, source, claimedAt, branch, worktree, note }`. The
 * pattern is repo-relative and uses the harness glob dialect
 * (`anyPathMatches`): `**`, `*`, `?`, and a bare path also covers everything
 * below it, so a claim on `docs` covers `docs/hooks.md`.
 */

import { anyPathMatches } from "../spec-harness-lib.mjs";

/**
 * Paths that concurrent sessions change as a side effect of other work.
 * They are never claimed, and an edit to one is never denied. Lockfiles and
 * changelogs conflict often but resolve mechanically; `package.json` is left
 * out on purpose, because two sessions editing its scripts or dependencies is
 * a conflict worth a message.
 */
export const DEFAULT_SHARED_PATHS = Object.freeze([
  "package-lock.json",
  "**/package-lock.json",
  "npm-shrinkwrap.json",
  "**/npm-shrinkwrap.json",
  "pnpm-lock.yaml",
  "**/pnpm-lock.yaml",
  "yarn.lock",
  "**/yarn.lock",
  "go.sum",
  "**/go.sum",
  "uv.lock",
  "**/uv.lock",
  "poetry.lock",
  "**/poetry.lock",
  "Cargo.lock",
  "**/Cargo.lock",
  "CHANGELOG.md",
  "**/CHANGELOG.md",
]);

const GLOB_CHARS = /[*?]/;

/**
 * Normalize a git remote URL to `host/owner/repo`, so every clone of one
 * repository maps to one ledger. SSH, scp-like, and HTTPS forms of the same
 * remote agree; credentials, ports, `.git`, and trailing slashes drop out.
 *
 * @param {string|null|undefined} url
 * @returns {string|null} null when the remote names no network host
 */
export function normalizeRemote(url) {
  const raw = String(url ?? "").trim();
  if (!raw) return null;
  let host;
  let pathname;
  const scp = /^(?:[^@/\s]+@)?([^:/\s]+):(?!\/)(\S+)$/.exec(raw);
  if (scp && !/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
    [, host, pathname] = scp;
  } else {
    let parsed;
    try {
      parsed = new URL(raw);
    } catch {
      return null;
    }
    if (parsed.protocol === "file:" || !parsed.hostname) return null;
    host = parsed.hostname;
    pathname = parsed.pathname;
  }
  // A one-letter "host" is a Windows drive (C:\repo), not a remote.
  if (host.length < 2) return null;
  const clean = pathname.replace(/^\/+/, "").replace(/\/+$/, "").replace(/\.git$/, "");
  return clean ? `${host.toLowerCase()}/${clean}` : null;
}

/**
 * Turn a repo key into one filesystem-safe directory name.
 *
 * @param {string} key e.g. "github.com/acme/widget" or "local:/abs/.git"
 * @returns {string}
 */
export function repoSlug(key) {
  return String(key)
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

/**
 * Clean a user-supplied claim pattern: POSIX separators, no `./`, no empty
 * or trailing segments. Throws when the pattern is empty or leaves the repo.
 *
 * @param {string} input
 * @returns {string}
 */
export function normalizePattern(input) {
  const raw = String(input ?? "")
    .trim()
    .replace(/\\/g, "/");
  if (raw.startsWith("/") || /^[A-Za-z]:/.test(raw)) {
    throw new Error(`pattern must be relative to the repo root: ${input}`);
  }
  const parts = raw.split("/").filter((p) => p !== "" && p !== ".");
  if (parts.includes("..")) throw new Error(`pattern must stay inside the repo: ${input}`);
  if (parts.length === 0) throw new Error(`pattern is empty: ${JSON.stringify(input)}`);
  return parts.join("/");
}

/**
 * True when edits to `rel` are never claimed and never denied.
 *
 * @param {string} rel repo-relative POSIX path
 * @param {string[]} [extra] the repo's own shared globs (`.dotbabel.json` fleet.shared)
 * @returns {boolean}
 */
export function isSharedPath(rel, extra = []) {
  return [...DEFAULT_SHARED_PATHS, ...extra].some((p) => anyPathMatches(p, [rel]));
}

/** The directory part of a pattern before its first glob character. */
function staticPrefix(pattern) {
  const at = pattern.search(GLOB_CHARS);
  if (at < 0) return pattern;
  const cut = pattern.slice(0, at).lastIndexOf("/");
  return cut < 0 ? "" : pattern.slice(0, cut);
}

/** True when `p` is `dir` or lies below it ("" is the repo root). */
function within(dir, p) {
  return dir === "" || p === dir || p.startsWith(`${dir}/`);
}

/**
 * True when two claim patterns can match a common path. Exact for two
 * literal paths and for a literal against a glob. Two globs are compared by
 * their static directory prefixes, which can report an overlap that no real
 * file has (`src/*.js` vs `src/*.css`): a false alarm costs a message, a miss
 * costs a conflict.
 *
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
export function patternsOverlap(a, b) {
  const aGlob = GLOB_CHARS.test(a);
  const bGlob = GLOB_CHARS.test(b);
  if (!aGlob && !bGlob) return within(a, b) || within(b, a);
  if (aGlob && bGlob) {
    const pa = staticPrefix(a);
    const pb = staticPrefix(b);
    return within(pa, pb) || within(pb, pa);
  }
  const [glob, literal] = aGlob ? [a, b] : [b, a];
  return anyPathMatches(glob, [literal]) || within(literal, staticPrefix(glob));
}

/** Claim order: earlier `claimedAt` first, owner key breaks a tie. */
function compareRefs(x, y) {
  const tx = Date.parse(x.claimedAt);
  const ty = Date.parse(y.claimedAt);
  if (tx !== ty) {
    if (Number.isNaN(tx)) return 1;
    if (Number.isNaN(ty)) return -1;
    return tx - ty;
  }
  return x.ownerKey < y.ownerKey ? -1 : x.ownerKey > y.ownerKey ? 1 : 0;
}

/**
 * @typedef {object} OwnerView
 * @property {string} key       pid + process start time
 * @property {string} name      the SendMessage address of the session
 * @property {string} status    busy / idle / waiting, from the registry
 * @property {boolean} alive
 * @property {boolean} [self]
 * @property {Array<object>} claims each claim carries `active` (its worktree still exists)
 */

/** Every active claim of `owner` that covers `rel`, with its sort key. */
function covering(owner, rel) {
  return owner.claims
    .filter((c) => c.active !== false && anyPathMatches(c.pattern, [rel]))
    .map((claim) => ({ owner, claim, ref: { claimedAt: claim.claimedAt, ownerKey: owner.key } }));
}

/**
 * Judge one edit. A live peer's active claim that covers `rel` blocks the
 * edit, unless this session holds an earlier claim that covers it too (the
 * tie-break both sides of a race compute the same way). A block is a deny
 * until the same owner has blocked this path for `escalateAfterMs`; after that
 * it is an ask, so the user decides.
 *
 * @param {object} args
 * @param {string} args.rel              repo-relative path being edited
 * @param {string} args.selfKey          owner key of the editing session
 * @param {OwnerView[]} args.owners      every owner in the repo's ledger, self included
 * @param {{owner: string, firstDeniedAt: string}|null} [args.denial] this session's earlier block on `rel`
 * @param {number} args.now              epoch ms
 * @param {number} args.escalateAfterMs  0 = never escalate
 * @returns {{action: "allow", claimNeeded: boolean}
 *   | {action: "deny", conflict: {owner: OwnerView, claim: object}, firstDeniedAt: string, escalateAt: string|null}
 *   | {action: "ask", conflict: {owner: OwnerView, claim: object}, since: string}}
 */
export function decideEdit({ rel, selfKey, owners, denial = null, now, escalateAfterMs }) {
  const live = owners.filter((o) => o.alive);
  const mine =
    live
      .filter((o) => o.key === selfKey)
      .flatMap((o) => covering(o, rel))
      .sort((x, y) => compareRefs(x.ref, y.ref))[0] ?? null;
  const blocking = live
    .filter((o) => o.key !== selfKey)
    .flatMap((o) => covering(o, rel))
    .filter((t) => mine === null || compareRefs(t.ref, mine.ref) < 0)
    .sort((x, y) => compareRefs(x.ref, y.ref));
  if (blocking.length === 0) return { action: "allow", claimNeeded: mine === null };

  const conflict = { owner: blocking[0].owner, claim: blocking[0].claim };
  const sameOwner =
    denial !== null && denial.owner === conflict.owner.key && !Number.isNaN(Date.parse(denial.firstDeniedAt));
  const first = sameOwner ? Date.parse(denial.firstDeniedAt) : now;
  if (escalateAfterMs > 0 && sameOwner && now - first >= escalateAfterMs) {
    return { action: "ask", conflict, since: denial.firstDeniedAt };
  }
  return {
    action: "deny",
    conflict,
    firstDeniedAt: new Date(first).toISOString(),
    escalateAt: escalateAfterMs > 0 ? new Date(first + escalateAfterMs).toISOString() : null,
  };
}

/**
 * Add `claim` to an owner record, replacing a claim with the same pattern.
 * Returns a new record; the input is not changed.
 *
 * @param {object} record owner record `{ schema, repo, owner, claims, updatedAt }`
 * @param {object} claim
 * @returns {object}
 */
export function addClaim(record, claim) {
  return {
    ...record,
    claims: [...record.claims.filter((c) => c.pattern !== claim.pattern), claim],
    updatedAt: claim.claimedAt,
  };
}

/**
 * Remove claims from an owner record. A pattern releases the claim with that
 * exact pattern, and every file claim (no glob) that the pattern covers. It
 * never releases a broader glob claim: `release docs/a.md` leaves `docs/**`.
 *
 * @param {object} record
 * @param {string[]|"all"} patterns
 * @returns {{record: object, removed: object[]}}
 */
export function releaseClaims(record, patterns) {
  const hits = (c) =>
    patterns === "all" ||
    patterns.some((p) => p === c.pattern || (!GLOB_CHARS.test(c.pattern) && anyPathMatches(p, [c.pattern])));
  return {
    record: { ...record, claims: record.claims.filter((c) => !hits(c)) },
    removed: record.claims.filter(hits),
  };
}
