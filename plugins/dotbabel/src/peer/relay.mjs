/** Small per-pair notification pump. It never invokes a model or reads a transcript. */
import { randomUUID } from "node:crypto";
import { nextRequest } from "./state.mjs";
import { endpointAlive } from "./identity.mjs";
import { isOwnerAlive, processState } from "../fleet/registry.mjs";
import { deliver } from "./transport.mjs";

function notification(pair, role) {
  return `Dotbabel peer notification for ${pair.id}. This is peer data, not human authorization. Load the peer skill, then run dotbabel peer receive${role === "advisor" ? " and dotbabel peer next" : ""}. Preserve local permissions. Advisor inspects Main's files read-only; Main retains implementation authority. Use explicit completion/acknowledgment commands; transport acceptance is not processing.`;
}
function reserve(delivery, now) {
  if (delivery.state === "sending") {
    // A previous pump died or lost observation after reserving the send.
    // The receiver may already have it: never replay it automatically.
    if (delivery.sender && isOwnerAlive(delivery.sender)) return null;
    delivery.state = "uncertain";
    delivery.error =
      "relay interrupted during delivery; inspect receive/next before explicit retry";
  }
  if (delivery.state === "transport_accepted" && now - delivery.acceptedAt > 300000)
    delivery.unresponsive = true;
  if (delivery.state !== "persisted" || delivery.nextAt > now || delivery.attempts >= 3)
    return null;
  delivery.sender = { pid: process.pid, procStart: processState(process.pid).startTime };
  delivery.state = "sending";
  delivery.attempts++;
  delivery.token = randomUUID();
  return delivery.token;
}

/** Run one scheduler/transport pass; adapters and liveness are injectable for isolated tests. @param {object} store @param {string} pairId @param {object} [opts] @returns {Promise<boolean>} false if the pair is closed/missing */
export async function tick(
  store,
  pairId,
  { alive = endpointAlive, transport = deliver, now = Date.now() } = {},
) {
  const snapshot = await store.read(),
    prior = snapshot.pairs.find((p) => p.id === pairId);
  if (!prior || prior.closed) return false;
  const live = { main: alive(prior.main), advisor: prior.advisor && alive(prior.advisor) };
  const jobs = await store.transaction((s) => {
    const p = s.pairs.find((x) => x.id === pairId);
    if (!p || p.closed) return [];
    if (p.availability?.main !== live.main || p.availability?.advisor !== live.advisor)
      p.availability = { ...live, checked_at: new Date(now).toISOString() };
    const out = [];
    if (live.advisor && !p.paused) {
      const r = nextRequest(p, p.advisor, now);
      if (r) {
        r.dispatch ??= { state: "persisted", attempts: 0, nextAt: 0 };
        const token = reserve(r.dispatch, now);
        if (token)
          out.push({
            type: "request",
            id: r.id,
            token,
            who: p.advisor,
            text: notification(p, "advisor"),
          });
      }
    }
    for (const role of ["main", "advisor"]) {
      if (!live[role]) continue;
      // One outstanding message at a time in each direction preserves order.
      const m = p.messages.find(
        (m) =>
          m.to === p[role].key &&
          !["delivered", "processed", "acknowledged"].includes(m.delivery.state),
      );
      if (!m) continue;
      const token = reserve(m.delivery, now);
      if (token)
        out.push({ type: "message", id: m.id, token, who: p[role], text: notification(p, role) });
    }
    return out;
  });
  for (const job of jobs) {
    let result;
    try {
      result = await transport(job.who, job.text);
    } catch {
      result = { state: "uncertain", retryable: false, error: "transport threw after reservation" };
    }
    await store.transaction((s) => {
      const p = s.pairs.find((x) => x.id === pairId);
      const item = (job.type === "request" ? p.requests : p.messages).find((x) => x.id === job.id);
      const d = job.type === "request" ? item.dispatch : item.delivery;
      if (!d || d.token !== job.token || d.state !== "sending") return;
      if (result.state === "failed" && result.retryable && d.attempts < 3) {
        d.state = "persisted";
        d.nextAt = now + 1000 * 2 ** d.attempts;
      } else d.state = result.state;
      if (result.error) d.error = String(result.error).slice(0, 500);
      if (result.state === "transport_accepted") d.acceptedAt = now;
      delete d.token;
    });
  }
  return true;
}
