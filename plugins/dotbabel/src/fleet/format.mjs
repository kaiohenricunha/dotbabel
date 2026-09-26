/**
 * The text `dotbabel fleet` shows. The deny and ask reasons and the
 * SessionStart context are read by a model in another session, so each one
 * says who holds the path and what to do next, in short plain sentences.
 */

/** How many claims per owner the SessionStart context lists before "+N more". */
const CONTEXT_CLAIMS_PER_OWNER = 8;

/**
 * Render a duration the way a status line would: "just now", "12m", "3h 5m", "2d".
 *
 * @param {number} ms
 * @returns {string}
 */
export function formatAge(ms) {
  if (!Number.isFinite(ms) || ms < 60_000) return "just now";
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return minutes % 60 ? `${hours}h ${minutes % 60}m` : `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

/** Local wall-clock HH:MM of an ISO timestamp. */
function clock(isoTime) {
  return new Date(isoTime).toTimeString().slice(0, 5);
}

/** Quote a pattern for a shell command only when it needs it. */
function shellArg(value) {
  return /^[\w./@%+=:,-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}

/** "docs/hooks.md (auto, branch feat/x, 12m ago), note: ..." */
function describeClaim(claim, now) {
  const parts = [claim.source ?? "auto"];
  if (claim.branch) parts.push(`branch ${claim.branch}`);
  const age = formatAge(now - Date.parse(claim.claimedAt));
  parts.push(age === "just now" ? age : `${age} ago`);
  const note = claim.note ? `, note: "${claim.note}"` : "";
  return `${claim.pattern} (${parts.join(", ")})${note}`;
}

/**
 * The reason a blocked session reads when the edit guard denies its edit.
 *
 * @param {object} args
 * @param {string} args.rel         the path the session tried to edit
 * @param {string} args.repoKey
 * @param {{owner: {name: string}, claim: object}} args.conflict
 * @param {string} args.cli         how to run the fleet CLI, e.g. "dotbabel fleet"
 * @param {string|null} args.escalateAt ISO time after which the next attempt asks the user
 * @param {number} args.now
 * @returns {string}
 */
export function formatDenyReason({ rel, repoKey, conflict, cli, escalateAt, now }) {
  const owner = `"${conflict.owner.name}"`;
  const lines = [
    `dotbabel fleet: the live Claude Code session ${owner} claims ${rel} in ${repoKey}.`,
    `Claim: ${describeClaim(conflict.claim, now)}.`,
    "This edit is blocked so that two sessions do not change the same file.",
    "Do this:",
    `1. SendMessage ${owner}. Tell it what you must change in ${rel}, and ask it to release the claim when that is safe. The owner releases with: ${cli} release ${shellArg(conflict.claim.pattern)}`,
    "2. Continue with other work while you wait for the answer.",
    "Do not change this file with Bash or another tool, and do not delete the claim.",
  ];
  if (escalateAt) {
    lines.push(`If the claim is still there at ${clock(escalateAt)}, your next attempt goes to your user for a decision.`);
  }
  return lines.join("\n");
}

/**
 * The reason the user reads when a block has lasted past the escalation window.
 *
 * @param {object} args
 * @param {string} args.rel
 * @param {{owner: {name: string}, claim: object}} args.conflict
 * @param {string} args.since ISO time of the first block
 * @param {number} args.now
 * @returns {string}
 */
export function formatAskReason({ rel, conflict, since, now }) {
  return [
    `dotbabel fleet: the live Claude Code session "${conflict.owner.name}" claims ${rel}, and it did not release the claim in the ${formatAge(now - Date.parse(since))} since this session was first blocked.`,
    `Claim: ${describeClaim(conflict.claim, now)}.`,
    "Approve this edit only if you know that the two sessions will not conflict.",
  ].join("\n");
}

/** Owners that hold at least one active claim, each with only those claims. */
function withActiveClaims(owners) {
  return owners
    .filter((o) => o.alive !== false)
    .map((o) => ({ ...o, claims: o.claims.filter((c) => c.active !== false) }))
    .filter((o) => o.claims.length > 0);
}

/**
 * The context a session gets at SessionStart: who holds what in this repo.
 * Empty when nobody holds a claim, so a quiet repo costs no context.
 *
 * @param {object} args
 * @param {string} args.repoKey
 * @param {Array<object>} args.owners owner views; `self` marks this session
 * @param {string} args.cli
 * @returns {string}
 */
export function formatSessionContext({ repoKey, owners, cli }) {
  const holders = withActiveClaims(owners);
  if (holders.length === 0) return "";
  const lines = [`dotbabel fleet: live claims in ${repoKey}.`];
  for (const o of holders) {
    const shown = o.claims.slice(0, CONTEXT_CLAIMS_PER_OWNER).map((c) => c.pattern);
    const more = o.claims.length - shown.length;
    const list = shown.join(", ") + (more > 0 ? `, +${more} more` : "");
    const branches = [...new Set(o.claims.map((c) => c.branch).filter(Boolean))];
    const where = branches.length ? `, branch ${branches.join(", ")}` : "";
    const who = o.self ? "this session" : `"${o.name}" (${o.status ?? "unknown"}${where})`;
    lines.push(`- ${who}: ${list}`);
  }
  lines.push(
    "An edit to a path that another live session claims is blocked. To change such a path, SendMessage its owner first.",
    `Your first edit to a file claims it for this session. Before large work, claim the scope: ${cli} claim '<glob>' --note '<intent>'. When your work lands, release your claims: ${cli} release --all`,
  );
  return lines.join("\n");
}

/**
 * The human board: every owner in the repo and its claims.
 *
 * @param {object} args
 * @param {string} args.repoKey
 * @param {Array<object>} args.owners owner views; `self` marks the caller
 * @param {number} args.removed claim records of exited sessions removed on this read
 * @param {number} args.now
 * @returns {string}
 */
export function formatBoard({ repoKey, owners, removed, now }) {
  const holders = owners.filter((o) => o.claims.length > 0);
  const lines = [];
  if (holders.length === 0) {
    lines.push(`${repoKey}: no claims.`);
  } else {
    lines.push(
      holders.length === 1 ? `${repoKey}: 1 session holds claims.` : `${repoKey}: ${holders.length} sessions hold claims.`,
    );
    const width = Math.max(...holders.flatMap((o) => o.claims.map((c) => c.pattern.length)));
    for (const o of holders) {
      const state = o.alive === false ? "exited" : (o.status ?? "unknown");
      lines.push(`  ${o.name} (${o.self ? `you, ${state}` : state})`);
      for (const c of o.claims) {
        const cols = [c.pattern.padEnd(width), c.source ?? "auto", formatAge(now - Date.parse(c.claimedAt))];
        if (c.branch) cols.push(c.branch);
        if (c.note) cols.push(`"${c.note}"`);
        if (c.active === false) cols.push("(worktree removed)");
        lines.push(`    ${cols.join("  ")}`);
      }
    }
  }
  if (removed > 0) {
    lines.push(
      removed === 1
        ? "Removed 1 claim record of an exited session."
        : `Removed ${removed} claim records of exited sessions.`,
    );
  }
  return lines.join("\n");
}
