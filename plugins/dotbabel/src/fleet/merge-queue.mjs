/** Pure reservation queue ordering. A hook never waits for its turn. */
export const RESERVATION_MS = 10 * 60_000;

/** Order entries by task dependencies, then arrival; cycles retain arrival order.
 * @param {object[]} entries
 * @param {object[]} tasks
 * @returns {object[]}
 */
export function orderQueue(entries, tasks = []) {
  const bySlug = new Map(tasks.map((t) => [t.slug, t]));
  const ancestors = (branch) => {
    const seen = new Set();
    const pending = tasks.filter((t) => t.branch === branch && t.status !== "closed").flatMap((t) => t.depends_on);
    while (pending.length) {
      const slug = pending.pop();
      if (seen.has(slug)) continue;
      seen.add(slug);
      const task = bySlug.get(slug);
      if (task?.status !== "closed") pending.push(...(task?.depends_on ?? []));
    }
    return seen;
  };
  const dependencies = new Map(entries.map((e) => [e.owner.key, ancestors(e.branch)]));
  const waits = (a, b) => a.branch !== b.branch && tasks.some((t) => t.branch === b.branch && t.status !== "closed" && dependencies.get(a.owner.key).has(t.slug));
  const pending = [...entries].sort((a, b) => Date.parse(a.joinedAt) - Date.parse(b.joinedAt));
  const result = [];
  while (pending.length) {
    const next = pending.findIndex((e) => !pending.some((other) => other !== e && waits(e, other)));
    result.push(...pending.splice(next < 0 ? 0 : next, 1));
  }
  return result;
}

/** Remove dead or expired entries and reserve the free head.
 * @param {object[]} entries
 * @param {{now: number, held: boolean, isAlive: Function, tasks?: object[]}} opts
 * @returns {object[]}
 */
export function reserveQueue(entries, { now, held, isAlive, tasks = [] }) {
  const live = entries.filter((e) => e && typeof e.owner?.key === "string" && Number.isFinite(Date.parse(e.joinedAt)) && isAlive(e.owner) && (!e.reservedUntil || Date.parse(e.reservedUntil) > now));
  // An existing reservation remains binding until expiry or leave.
  const reserved = !held && live.find((e) => e.reservedUntil);
  const waiting = live.filter((e) => e !== reserved);
  const queue = tasks.length ? orderQueue(waiting, tasks) : waiting;
  if (reserved) queue.unshift(reserved);
  return queue.map((e, i) => ({ ...e, reservedUntil: !held && i === 0 ? e.reservedUntil ?? new Date(now + RESERVATION_MS).toISOString() : null }));
}
