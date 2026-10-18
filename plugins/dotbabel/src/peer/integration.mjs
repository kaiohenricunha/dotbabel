/** Shared native integration plumbing. Native adapters supply identity and queue admission, not model decisions. */
import { openNativeEndpoint } from "./native.mjs";
import { invokePeer, peerCommand, coordinatePeer } from "./cli.mjs";
import { PeerStore } from "./store.mjs";
import { repository, peerRoot } from "./identity.mjs";
import { peerHook } from "./hooks.mjs";
import { validateNativeId } from "./native-registry.mjs";

/** Native tool schema; actor IDs and repositories always come from the SDK, never tool input. */
export const PEER_TOOL = Object.freeze({
  name: "dotbabel_peer",
  description:
    "Persistent Main/Advisor coordination. Load the peer skill. Pass the arguments after 'dotbabel peer'. Use ['--help'] for full syntax. Register ['main'] or ['advisor','CODE']; inspect ['receive'] and ['next']. Complete work with ['complete','REQUEST_ID','--lease','TOKEN','--result','Evidence and result']. Send ['send','main','finding','--kind','finding','--request','REQUEST_ID']; reply with --kind reply --reply-to MESSAGE_ID. ACK only after processing: ['ack','MESSAGE_ID','--processed']. Continue FIFO; respect forward:never. No shell text, actor identity, setup, or repository override.",
  parameters: {
    type: "object",
    properties: {
      argv: {
        type: "array",
        items: { type: "string", maxLength: 16384 },
        minItems: 1,
        maxItems: 128,
      },
    },
    required: ["argv"],
    additionalProperties: false,
  },
});

/** Bind actual native session IDs to one plugin location and native queue API. @param {object} options @returns {object} */
export function createNativeIntegration({
  harness,
  worktree,
  notify,
  version = null,
  env = process.env,
}) {
  const repo = repository(worktree),
    store = new PeerStore(peerRoot(env), repo.key);
  const bindings = new Map(),
    reminders = new Map();
  let closed = false;
  function pairFor(state, sessionId) {
    const key = `${harness}:${sessionId}`;
    return state.pairs.find((p) => !p.closed && [p.main?.key, p.advisor?.key].includes(key));
  }
  async function ensure(sessionId) {
    validateNativeId(harness, sessionId);
    if (closed) throw new Error("native integration is closed");
    if (!bindings.has(sessionId)) {
      const opening = openNativeEndpoint({
        harness,
        sessionId,
        worktree: repo.worktree,
        version,
        env,
        notify: (text) => notify(sessionId, text),
      })
        .then(async (endpoint) => {
          try {
            await store.transaction((s) => {
              const pair = pairFor(s, sessionId);
              if (pair) peerHook(pair, endpoint.who, { hook_event_name: "SessionStart" });
            });
          } catch (error) {
            await endpoint.close();
            throw error;
          }
          return endpoint;
        })
        .catch((err) => {
          bindings.delete(sessionId);
          throw err;
        });
      bindings.set(sessionId, opening);
    }
    return bindings.get(sessionId);
  }
  async function hook(sessionId, input) {
    if (!pairFor(await store.read(), sessionId)) return null;
    const endpoint = await ensure(sessionId);
    return store.transaction((s) => {
      const pair = pairFor(s, sessionId);
      return pair ? peerHook(pair, endpoint.who, input) : null;
    });
  }
  return {
    async pairedSessions() {
      const sessions = (await store.read()).pairs
        .filter((p) => !p.closed)
        .flatMap((p) => [p.main, p.advisor])
        .filter((who) => who?.harness === harness && who.worktree === repo.worktree)
        .map((who) => who.sessionId);
      return [...new Set(sessions)];
    },
    async invoke(sessionId, argv) {
      return invokePeer((await ensure(sessionId)).who, argv, env);
    },
    async coordinate(sessionId, input) {
      if (!peerCommand(input)) return null;
      return coordinatePeer(store, (await ensure(sessionId)).who, input, env);
    },
    hook,
    async context(sessionId) {
      const result = await hook(sessionId, { hook_event_name: "SessionStart" });
      return result?.hookSpecificOutput?.additionalContext ?? null;
    },
    async idle(sessionId) {
      const active = pairFor(await store.read(), sessionId)?.requests.find(
        (r) => r.state === "running",
      );
      const result = await hook(sessionId, {
        hook_event_name: "Stop",
        stop_hook_active: Boolean(active?.lease && reminders.get(sessionId) === active.lease),
      });
      if (result?.decision !== "block") {
        reminders.delete(sessionId);
        return null;
      }
      const running = pairFor(await store.read(), sessionId)?.requests.find(
        (r) => r.state === "running",
      );
      reminders.set(sessionId, running?.lease);
      return result.reason;
    },
    async closeSession(sessionId) {
      const binding = bindings.get(sessionId);
      bindings.delete(sessionId);
      reminders.delete(sessionId);
      if (binding) await (await binding).close();
    },
    async close() {
      closed = true;
      const pending = [...bindings.values()];
      bindings.clear();
      reminders.clear();
      const results = await Promise.allSettled(
        pending.map(async (binding) => (await binding).close()),
      );
      const errors = results
        .filter((result) => result.status === "rejected")
        .map((result) => result.reason);
      if (errors.length) throw new AggregateError(errors, "native endpoint cleanup failed");
    },
  };
}
