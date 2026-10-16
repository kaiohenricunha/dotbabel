/** Versioned peer domain state. All mutations run inside the repository transaction. */
import { randomBytes, randomUUID } from "node:crypto";

const KINDS = new Set([
  "finding",
  "question",
  "reply",
  "recommendation",
  "acknowledgment",
  "status",
]);
const TERMINAL = new Set(["completed", "failed", "cancelled"]);

/** Create an empty repository ledger. @param {string} repo @returns {object} */
export function createState(repo) {
  return { version: 1, repo, pairs: [] };
}

/** Validate bounded text without treating it as instructions. @param {unknown} body @returns {string} */
export function textBody(body) {
  if (
    typeof body !== "string" ||
    !body.trim() ||
    Buffer.byteLength(body) > 16384 ||
    body.includes("\0")
  )
    throw new Error("body must contain 1–16384 UTF-8 bytes without NUL");
  return body;
}

function open(pair) {
  if (!pair || pair.closed) throw new Error("pair is closed or missing");
}
function sameRepo(s, who) {
  if (s.repo !== who.repo) throw new Error("repository mismatch");
}
function member(pair, who) {
  open(pair);
  const role = ["main", "advisor"].find((r) => pair[r]?.key === who?.key);
  if (!role) throw new Error("session is not a member of this pair");
  return role;
}
function request(pair, id) {
  const r = pair.requests.find((x) => x.id === id);
  if (!r) throw new Error(`unknown request: ${id}`);
  return r;
}
function capacity(items) {
  if (items.length >= 10000)
    throw new Error("history limit reached (10000); unpair and create a new pair");
}
function dedup(items, key, match) {
  if (key === undefined) return null;
  if (typeof key !== "string" || !/^[\w.-]{1,128}$/.test(key))
    throw new Error("invalid deduplication key");
  const prior = items.find((x) => x.dedupe === key);
  if (prior && !match(prior)) throw new Error("deduplication key has different content");
  return prior;
}

/** Register this session as Main, idempotently. @param {object} s @param {object} who @param {object} opts @returns {object} */
export function registerMain(s, who, { now = Date.now(), alive }) {
  sameRepo(s, who);
  const existing = s.pairs.find(
    (p) => !p.closed && [p.main?.key, p.advisor?.key].includes(who.key),
  );
  if (existing) {
    if (existing.main.key !== who.key) throw new Error("session already paired as advisor");
    existing.main = who;
    if (!existing.advisor) existing.codeExpiresAt = now + 600000;
    return existing;
  }
  capacity(s.pairs);
  let code;
  do {
    code = randomBytes(4).toString("hex").toUpperCase();
  } while (s.pairs.some((p) => p.code === code));
  const pair = {
    id: `pair-${randomUUID()}`,
    code,
    codeExpiresAt: now + 600000,
    main: who,
    advisor: null,
    created_at: new Date(now).toISOString(),
    closed: false,
    paused: false,
    requests: [],
    messages: [],
    sequence: 0,
    relay: null,
  };
  if (!alive(who)) throw new Error("Main session unavailable");
  s.pairs.push(pair);
  return pair;
}

/** Connect an Advisor using a code or unique eligible Main. @param {object} s @param {object} who @param {string|null} code @param {object} opts @returns {object} */
export function pairAdvisor(s, who, code, { now = Date.now(), alive }) {
  sameRepo(s, who);
  const mine = s.pairs.find((p) => !p.closed && p.advisor?.key === who.key);
  if (mine && (!code || mine.code === code.toUpperCase())) {
    mine.advisor = who;
    return mine;
  }
  if (s.pairs.some((p) => !p.closed && [p.main?.key, p.advisor?.key].includes(who.key)))
    throw new Error("session already paired");
  const choices = s.pairs.filter(
    (p) =>
      !p.closed &&
      (code
        ? p.code === code.toUpperCase()
        : !p.advisor && p.codeExpiresAt >= now && alive(p.main)),
  );
  if (choices.length !== 1)
    throw new Error(
      choices.length
        ? "ambiguous Main discovery; select a pairing code"
        : "no eligible Main in this repository",
    );
  const p = choices[0];
  if (p.codeExpiresAt < now) throw new Error("pairing code expired; run peer main again");
  if (!alive(p.main)) throw new Error("Main unavailable");
  if (p.advisor)
    throw new Error("Advisor role occupied; use explicit reconnect after it terminates");
  if (p.main.key === who.key) throw new Error("Main cannot pair with itself");
  p.advisor = who;
  return p;
}

/** Replace a terminated endpoint, preserving queue and history. @param {object} s @param {string} id @param {string} role @param {object} who @param {object} opts @returns {object} */
export function reconnect(s, id, role, who, { alive }) {
  sameRepo(s, who);
  const p = s.pairs.find((x) => x.id === id);
  open(p);
  if (!["main", "advisor"].includes(role)) throw new Error("role must be main or advisor");
  if (
    s.pairs.some((x) => !x.closed && x.id !== id && [x.main?.key, x.advisor?.key].includes(who.key))
  )
    throw new Error("session already paired elsewhere");
  if (
    p[role] &&
    (p[role].key !== who.key || p[role].pid !== who.pid || p[role].procStart !== who.procStart) &&
    alive(p[role])
  )
    throw new Error("previous peer is still alive");
  if (p[role === "main" ? "advisor" : "main"]?.key === who.key)
    throw new Error("one session cannot own both roles");
  const old = p[role]?.key;
  p.previous_members ??= { main: [], advisor: [] };
  if (old && old !== who.key && !p.previous_members[role].includes(old))
    p.previous_members[role].push(old);
  p[role] = who;
  for (const m of p.messages) {
    if (m.to === old && m.delivery.state !== "acknowledged") {
      m.original_to ??= m.to;
      m.to = who.key;
      m.delivery = { state: "persisted", attempts: 0, nextAt: 0 };
    }
  }
  if (role === "advisor") recoverRequests(p, "Advisor reconnected");
  return p;
}

/** Close a pair without deleting its history. @param {object} pstate @param {string} id @param {object} who @returns {void} */
export function unpair(pstate, id, who) {
  const p = pstate.pairs.find((x) => x.id === id);
  member(p, who);
  p.closed = true;
  for (const r of p.requests)
    if (!TERMINAL.has(r.state)) {
      r.state = "cancelled";
      r.lease = null;
    }
}

/** Persist a new FIFO request, optionally linked to an earlier request. @param {object} p @param {string} body @param {object} [opts] @returns {object} */
export function enqueue(
  p,
  body,
  { dedupe, parentId, priority = 0, forward = "actionable", now = Date.now() } = {},
) {
  open(p);
  textBody(body);
  if (!["actionable", "never", "explicit"].includes(forward))
    throw new Error("invalid forwarding policy");
  if (!Number.isInteger(priority) || Math.abs(priority) > 100)
    throw new Error("priority must be an integer from -100 to 100");
  if (parentId) request(p, parentId);
  const prior = dedup(
    p.requests,
    dedupe,
    (r) => r.body === body && r.parent_id === (parentId ?? null) && r.forward === forward,
  );
  if (prior) return prior;
  capacity(p.requests);
  const r = {
    id: `adv-${randomUUID()}`,
    seq: ++p.sequence,
    body,
    parent_id: parentId ?? null,
    priority,
    forward,
    dedupe,
    state: "queued",
    attempts: 0,
    lease: null,
    result: null,
    created_at: new Date(now).toISOString(),
  };
  p.requests.push(r);
  return r;
}

/** Claim the next task; a second claim returns the current task. @param {object} p @param {object} who @param {number} [now] @returns {object|null} */
export function nextRequest(p, who, now = Date.now()) {
  if (member(p, who) !== "advisor") throw new Error("only Advisor can claim work");
  const running = p.requests.find((r) => r.state === "running");
  if (running) return running;
  if (p.paused) return null;
  const r = p.requests
    .filter((r) => r.state === "queued")
    .sort((a, b) => b.priority - a.priority || a.seq - b.seq)[0];
  if (!r) return null;
  delete r.dispatch;
  r.state = "running";
  r.attempts++;
  r.lease = randomUUID();
  r.started_at = new Date(now).toISOString();
  return r;
}

/** Complete, fail, or suspend an owned investigation with a fenced lease. @param {object} p @param {object} who @param {string} id @param {string} lease @param {string} state @param {string} result @param {string} [waitingOn] @returns {object} */
export function finishRequest(p, who, id, lease, state, result, waitingOn) {
  if (member(p, who) !== "advisor") throw new Error("only Advisor can finish work");
  const r = request(p, id);
  if (r.state !== "running") throw new Error("request is not running");
  if (r.lease !== lease) throw new Error("stale request lease");
  if (!["completed", "failed", "waiting_for_peer"].includes(state))
    throw new Error("invalid terminal/waiting state");
  textBody(result);
  if (
    state === "waiting_for_peer" &&
    !p.messages.some(
      (m) => m.id === waitingOn && m.from === who.key && m.to === p.main.key && m.request_id === id,
    )
  )
    throw new Error("waiting requires a correlated question to Main");
  r.outcomes ??= [];
  r.outcomes.push({ state, result, at: new Date().toISOString(), attempt: r.attempts });
  r.state = state;
  r.result = result;
  r.waiting_on = waitingOn ?? null;
  r.lease = null;
  r.finished_at = new Date().toISOString();
  return r;
}

/** Recover interrupted investigations with a bounded attempt count. @param {object} p @param {string} reason @returns {void} */
export function recoverRequests(p, reason) {
  for (const r of p.requests.filter((r) => r.state === "running")) {
    r.state = r.attempts >= 3 ? "failed" : "queued";
    r.lease = null;
    r.recovery = reason;
  }
}

/** Cancel, prioritize, or explicitly retry a request. @param {object} p @param {string} id @param {string} action @param {number} [priority] @returns {object} */
export function changeRequest(p, id, action, priority) {
  open(p);
  const r = request(p, id);
  if (action === "cancel" && !TERMINAL.has(r.state)) {
    r.state = "cancelled";
    r.lease = null;
  } else if (
    action === "priority" &&
    Number.isInteger(priority) &&
    Math.abs(priority) <= 100 &&
    r.state === "queued"
  )
    r.priority = priority;
  else if (
    action === "retry" &&
    ["failed", "waiting_for_peer"].includes(r.state) &&
    r.attempts < 3
  ) {
    r.state = "queued";
    r.lease = null;
  } else throw new Error("invalid request operation or request state");
  return r;
}

/** Persist a bounded, correlated message addressed to the other role. @param {object} p @param {object} who @param {string} role @param {string} body @param {object} [opts] @returns {object} */
export function sendMessage(
  p,
  who,
  role,
  body,
  { kind = "status", replyTo, requestId, dedupe, now = Date.now() } = {},
) {
  const sender = member(p, who);
  textBody(body);
  if (!KINDS.has(kind)) throw new Error("invalid message kind");
  if (sender === role || !["main", "advisor"].includes(role) || !p[role])
    throw new Error("recipient unavailable or invalid");
  const parent = replyTo
    ? p.messages.find(
        (m) =>
          m.id === replyTo &&
          m.to === who.key &&
          (m.from === p[role].key || p.previous_members?.[role]?.includes(m.from)),
      )
    : null;
  if (replyTo && !parent) throw new Error("invalid reply correlation");
  if (parent && parent.depth >= 6) throw new Error("automatic reply depth limit (6)");
  const reqId = requestId ?? parent?.request_id ?? null;
  if (reqId) {
    const r = request(p, reqId);
    if (sender === "advisor" && r.forward === "never")
      throw new Error("forwarding suppressed for this request");
  }
  const prior = dedup(
    p.messages,
    dedupe,
    (m) =>
      m.from === who.key &&
      m.to === p[role].key &&
      m.body === body &&
      m.kind === kind &&
      m.reply_to === (replyTo ?? null) &&
      m.request_id === reqId,
  );
  if (prior) return prior;
  capacity(p.messages);
  if (
    p.messages.filter((m) => m.from === who.key && now - Date.parse(m.created_at) < 60000).length >=
    30
  )
    throw new Error("message rate limit (30/minute)");
  const m = {
    version: 1,
    id: `msg-${randomUUID()}`,
    pair_id: p.id,
    seq: ++p.sequence,
    from: who.key,
    to: p[role].key,
    kind,
    reply_to: replyTo ?? null,
    request_id: reqId,
    body,
    created_at: new Date(now).toISOString(),
    depth: parent ? parent.depth + 1 : 0,
    dedupe,
    delivery: { state: "persisted", attempts: 0, nextAt: 0 },
  };
  p.messages.push(m);
  if (parent && reqId) {
    const r = request(p, reqId);
    if (r.state === "waiting_for_peer" && r.waiting_on === parent.id) {
      r.state = "queued";
      r.waiting_on = null;
    }
  }
  return m;
}

/** Read pending messages, recording delivery separately from processing. @param {object} p @param {object} who @returns {object[]} */
export function receiveMessages(p, who) {
  member(p, who);
  const messages = p.messages.filter(
    (m) => m.to === who.key && !["processed", "acknowledged"].includes(m.delivery.state),
  );
  for (const m of messages) {
    m.delivery.state = "delivered";
    m.delivery.delivered_at ??= new Date().toISOString();
  }
  return messages;
}

/** Explicit recipient processing or acknowledgment. @param {object} p @param {object} who @param {string} id @param {string} [state] @returns {object} */
export function acknowledge(p, who, id, state = "acknowledged") {
  member(p, who);
  const m = p.messages.find((x) => x.id === id && x.to === who.key);
  if (!m || !["processed", "acknowledged"].includes(state))
    throw new Error("invalid acknowledgment");
  if (m.delivery.state !== "acknowledged") m.delivery.state = state;
  m.delivery[`${state}_at`] = new Date().toISOString();
  return m;
}
