/** Deterministic peer command surface. Models interpret meaning; this module owns state changes. */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { parse } from "../lib/argv.mjs";
import { isOwnerAlive, processState } from "../fleet/registry.mjs";
import { PeerStore } from "./store.mjs";
import { repository, currentSession, endpointAlive, peerRoot } from "./identity.mjs";
import * as domain from "./state.mjs";
import { tick } from "./relay.mjs";
import { setupHooks } from "./setup.mjs";
import { peerHook } from "./hooks.mjs";
import { literalWords } from "./shell.mjs";

const BIN = fileURLToPath(new URL("../../bin/dotbabel-peer.mjs", import.meta.url));
const USAGE = `dotbabel peer — persistent local Main/Advisor collaboration

Usage:
  dotbabel peer setup --harness both         one-time hook installation; restart/review trust
  dotbabel peer setup --harness opencode|copilot|antigravity [--repo-root PATH]
  dotbabel peer launch main|advisor CODE --harness antigravity
  dotbabel peer launch main|advisor --pair ID [--conversation UUID] --harness antigravity
  dotbabel peer main                         register current session; show pairing code
  dotbabel peer advisor [CODE]               pair with a Main in this repository
  dotbabel peer ask TEXT [--pair ID]          durably enqueue while Advisor is busy
  dotbabel peer send main|advisor TEXT       message the paired session
  dotbabel peer queue|history|status         inspect current state
  dotbabel peer receive                      read peer messages (records delivery)
  dotbabel peer ack MESSAGE [--processed]    acknowledge recipient processing
  dotbabel peer next                         claim/resume Advisor's one active task
  dotbabel peer complete|fail REQUEST --lease TOKEN --result TEXT
  dotbabel peer wait REQUEST --lease TOKEN --result TEXT --reply-to MESSAGE
  dotbabel peer cancel|retry REQUEST         cancel or retry (maximum 3 attempts)
  dotbabel peer priority REQUEST --priority N
  dotbabel peer retry-delivery ID            explicitly retry uncertain/failed delivery
  dotbabel peer pause|resume                 control Advisor scheduling
  dotbabel peer reconnect main|advisor --pair ID
  dotbabel peer unpair                       close pairing, preserve history
  dotbabel peer inspect                     Main worktree path and read-only inspection instructions
  dotbabel peer input --pair ID              independent line-oriented submission pane
  dotbabel peer relay --pair ID            foreground notification pump / recovery
  dotbabel peer hook EVENT                   lifecycle hook (JSON on stdin)

Options: --json --pair ID --dedupe KEY --parent REQUEST --forward actionable|never|explicit
         --priority -100..100 --kind TYPE --reply-to MESSAGE --request REQUEST
         --repo-root PATH --lease TOKEN --result TEXT --processed

Claude: /peer main, /peer advisor CODE. Codex: $peer main, $peer advisor CODE.
No urgent steering is claimed; delivery acceptance is separate from model acknowledgment.
State: DOTBABEL_PEER_STATE_DIR or $XDG_STATE_HOME/dotbabel/peer (private).
Exit codes: 0 ok, 1 operation refused, 2 environment error, 64 usage error.
`;
const FLAGS = Object.fromEntries(
  [
    "harness",
    "conversation",
    "pair",
    "dedupe",
    "parent",
    "forward",
    "priority",
    "kind",
    "reply-to",
    "request",
    "repo-root",
    "lease",
    "result",
  ].map((k) => [k, { type: "string" }]),
);
FLAGS.processed = { type: "boolean" };
const COMMANDS = new Set([
  "setup",
  "launch",
  "main",
  "advisor",
  "ask",
  "send",
  "queue",
  "history",
  "status",
  "receive",
  "ack",
  "next",
  "complete",
  "fail",
  "wait",
  "cancel",
  "retry",
  "priority",
  "retry-delivery",
  "pause",
  "resume",
  "reconnect",
  "unpair",
  "inspect",
  "input",
  "relay",
  "hook",
]);
const EXTERNAL = new Set([
  "ask",
  "queue",
  "history",
  "status",
  "pause",
  "resume",
  "cancel",
  "priority",
  "retry",
  "retry-delivery",
  "input",
  "relay",
]);
function usage(message) {
  const e = new Error(message);
  e.exitCode = 64;
  throw e;
}
function environment(operation) {
  try {
    return operation();
  } catch (err) {
    err.exitCode = 2;
    throw err;
  }
}
function pairFor(s, id, who, allowClosed = false) {
  const found = s.pairs.filter(
    (p) =>
      (allowClosed || !p.closed) &&
      (id ? p.id === id : [p.main?.key, p.advisor?.key].includes(who?.key)),
  );
  if (found.length !== 1) throw new Error("no unique pair; use --pair ID from peer status");
  if (who && ![found[0].main?.key, found[0].advisor?.key].includes(who.key))
    throw new Error("session is not a member of the selected pair");
  return found[0];
}
function launchRelay(store, p, env) {
  if (env.DOTBABEL_PEER_NO_RELAY === "1" || p.closed || !p.advisor) return;
  if (p.relay && isOwnerAlive(p.relay)) return;
  const child = spawn(
    process.versions.bun ? "node" : process.execPath,
    [BIN, "relay", "--pair", p.id, "--repo-root", p.main.worktree],
    { env, detached: true, stdio: "ignore" },
  );
  child.on("error", () => {
    /* Status exposes missing relay; foreground relay provides diagnostics. */
  });
  child.unref();
}
async function pump(store, pairId) {
  const owner = { pid: process.pid, procStart: processState(process.pid).startTime };
  const claimed = await store.transaction((s) => {
    const p = pairFor(s, pairId, null);
    if (p.relay && isOwnerAlive(p.relay) && p.relay.pid !== process.pid) return false;
    p.relay = owner;
    return true;
  });
  if (!claimed) return;
  let stopped = false;
  const stop = () => {
    stopped = true;
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  try {
    while (!stopped) {
      if (!(await tick(store, pairId))) break;
      const p = (await store.read()).pairs.find((p) => p.id === pairId);
      if (!endpointAlive(p.main) && !endpointAlive(p.advisor)) break;
      await delay(1000);
    }
  } finally {
    process.removeListener("SIGTERM", stop);
    process.removeListener("SIGINT", stop);
    await store.transaction((s) => {
      const p = s.pairs.find((p) => p.id === pairId);
      if (p?.relay?.pid === process.pid) p.relay = null;
    });
  }
}
function context(p, who, env = process.env) {
  if (!p.main || repository(p.main.worktree).key !== p.main.repo)
    throw new Error("Main worktree is unavailable or changed repository");
  return {
    main_worktree: p.main.worktree,
    main_alive: endpointAlive(p.main, { env }),
    advisor_worktree: p.advisor?.worktree ?? null,
    shared_worktree: p.main.worktree === who?.worktree,
    instructions:
      "Read files directly in main_worktree, including uncommitted and untracked changes. Use git -C MAIN diff/status. Re-read evidence before sending findings. Do not write or apply patches there.",
  };
}
async function execute(store, command, args, flags, who, env = process.env) {
  const alive = (endpoint) => endpointAlive(endpoint, { env });
  return store.transaction((s) => {
    if (command === "main") return domain.registerMain(s, who, { alive });
    if (command === "advisor") return domain.pairAdvisor(s, who, args[0] ?? null, { alive });
    if (command === "reconnect") return domain.reconnect(s, flags.pair, args[0], who, { alive });
    const p = pairFor(s, flags.pair, who, command === "history");
    switch (command) {
      case "ask":
        return domain.enqueue(p, args.join(" "), {
          dedupe: flags.dedupe,
          parentId: flags.parent,
          priority: flags.priority === undefined ? 0 : Number(flags.priority),
          forward: flags.forward ?? "actionable",
        });
      case "send":
        return domain.sendMessage(p, who, args[0], args.slice(1).join(" "), {
          kind: flags.kind,
          replyTo: flags["reply-to"],
          requestId: flags.request,
          dedupe: flags.dedupe,
        });
      case "queue":
        return p.requests;
      case "history":
        return { requests: p.requests, messages: p.messages };
      case "receive":
        return domain.receiveMessages(p, who);
      case "ack":
        return domain.acknowledge(p, who, args[0], flags.processed ? "processed" : "acknowledged");
      case "next": {
        const r = domain.nextRequest(p, who);
        if (r) r.dispatch = { ...r.dispatch, state: "processed" };
        return r ? { ...r, ...context(p, who, env) } : null;
      }
      case "complete":
      case "fail":
      case "wait":
        return domain.finishRequest(
          p,
          who,
          args[0],
          flags.lease,
          { complete: "completed", fail: "failed", wait: "waiting_for_peer" }[command],
          flags.result,
          flags["reply-to"],
        );
      case "cancel":
      case "retry":
      case "priority":
        return domain.changeRequest(p, args[0], command, Number(flags.priority));
      case "retry-delivery": {
        const m = p.messages.find((m) => m.id === args[0]),
          r = p.requests.find((r) => r.id === args[0]),
          d = m?.delivery ?? r?.dispatch;
        if (
          !d ||
          !["failed", "uncertain", "transport_accepted"].includes(d.state) ||
          d.attempts >= 3
        )
          throw new Error("delivery is not retryable or exceeded 3 attempts");
        Object.assign(d, { state: "persisted", nextAt: 0 });
        return d;
      }
      case "pause":
        p.paused = true;
        return { id: p.id, paused: true };
      case "resume":
        p.paused = false;
        return { id: p.id, paused: false };
      case "unpair":
        domain.unpair(s, p.id, who);
        return { id: p.id, closed: true };
      case "inspect":
        return context(p, who, env);
      case "status":
        return {
          id: p.id,
          code: p.code,
          codeExpiresAt: p.codeExpiresAt,
          main: p.main,
          advisor: p.advisor,
          paused: p.paused,
          closed: p.closed,
          relay: p.relay,
          queue: Object.fromEntries(
            ["queued", "running", "waiting_for_peer", "completed", "failed", "cancelled"].map(
              (state) => [state, p.requests.filter((r) => r.state === state).map((r) => r.id)],
            ),
          ),
          deliveries: p.messages
            .slice(-50)
            .map((m) => ({ id: m.id, from: m.from, to: m.to, delivery: m.delivery })),
          main_alive: alive(p.main),
          advisor_alive: alive(p.advisor),
          relay_alive: Boolean(p.relay && isOwnerAlive(p.relay)),
          protection:
            "Advisor skill is read-only; PreToolUse enforcement requires installed peer hooks",
          codex_liveness:
            "process incarnation plus SessionEnd hook; a shared daemon can outlive its thread",
        };
      default:
        throw new Error("unimplemented peer operation");
    }
  });
}

/** Execute a scoped operation for a verified native integration, without process-global output capture. @param {object} who @param {string[]} argv @param {NodeJS.ProcessEnv} [env] @returns {Promise<object|null>} */
export async function invokePeer(who, argv, env = process.env) {
  if (
    !Array.isArray(argv) ||
    argv.length > 128 ||
    argv.some((a) => typeof a !== "string" || Buffer.byteLength(a) > 16384)
  )
    throw new Error("peer integration arguments must be a bounded string array");
  if (!endpointAlive(who, { env }))
    throw new Error("peer integration identity is not registered or live");
  const parsed = parse(argv, FLAGS),
    [command, ...args] = parsed.positional;
  if (parsed.help && argv.length === 1) return { usage: USAGE };
  if (
    parsed.help ||
    parsed.version ||
    parsed.flags["repo-root"] ||
    parsed.flags.harness ||
    parsed.flags.conversation ||
    ["setup", "launch", "hook", "relay", "input"].includes(command)
  )
    throw new Error("operation is unavailable through a scoped peer integration");
  validateArgs(command, args, parsed.flags);
  const store = new PeerStore(peerRoot(env), who.repo);
  const result = await execute(store, command, args, parsed.flags, who, env);
  const pair = ["main", "advisor", "reconnect"].includes(command)
    ? result
    : pairFor(await store.read(), parsed.flags.pair, who, ["history", "unpair"].includes(command));
  launchRelay(store, pair, env);
  return result;
}
function validateArgs(command, args, flags) {
  if (!COMMANDS.has(command)) usage("unknown peer operation; run dotbabel peer --help");
  if (flags.harness && !["setup", "launch", "hook"].includes(command))
    usage(
      "--harness selects setup, launch, or a native hook protocol; it cannot replace session identity",
    );
  if (flags.conversation && command !== "launch")
    usage("--conversation is available only for managed native launch");
  const maximum = ["ask", "send"].includes(command)
    ? Infinity
    : command === "launch"
      ? 2
      : [
            "advisor",
            "ack",
            "complete",
            "fail",
            "wait",
            "cancel",
            "retry",
            "priority",
            "retry-delivery",
            "reconnect",
            "hook",
          ].includes(command)
        ? 1
        : 0;
  if (args.length > maximum) usage(`too many arguments for ${command}`);
  if (
    [
      "ask",
      "send",
      "ack",
      "complete",
      "fail",
      "wait",
      "cancel",
      "retry",
      "priority",
      "retry-delivery",
      "reconnect",
      "hook",
    ].includes(command) &&
    !args.length
  )
    usage(`${command} requires an argument`);
  if (command === "send" && args.length < 2) usage("send requires a role and message");
  if (["complete", "fail", "wait"].includes(command) && (!flags.lease || !flags.result))
    usage("completion requires --lease and --result");
  if (["reconnect", "input", "relay"].includes(command) && !flags.pair)
    usage(`${command} requires --pair ID`);
}
function print(value, json, command) {
  if (json || !["main", "advisor"].includes(command)) {
    process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
    return;
  }
  const who = value[command === "main" ? "main" : "advisor"];
  process.stdout.write(
    `${command === "main" ? "Main session registered." : "Advisor connected to Main."}\nHarness: ${who.harness}\nRepository: ${who.repo}\nPair: ${value.id}\n${command === "main" ? `Pairing code: ${value.code} (expires in 10 minutes)\nWaiting for advisor...` : `Queue: ${value.requests.filter((r) => r.state === "queued").length}\nReady to receive requests.`}\n`,
  );
}

// This reviewed hook capability executes only internal peer state operations. It
// never runs model-supplied shell text on the host. The replacement only prints
// the result; unrelated commands retain their normal permission checks.
/** Parse only a literal, scoped peer operation from a trusted native tool hook. @param {object} input @returns {string[]|null} */
export function peerCommand(input) {
  if (input.hook_event_name !== "PreToolUse" || !["Bash", "exec_command"].includes(input.tool_name))
    return null;
  const words = literalWords(input.tool_input?.command ?? input.tool_input?.cmd);
  if (!words) return null;
  const bin = path.basename(words[0]);
  let argv;
  if (bin === "dotbabel" && words[1] === "peer") argv = words.slice(2);
  else if (bin === "node" && words[1] === BIN) argv = words.slice(2);
  else if (
    bin === "node" &&
    words[1] === path.join(path.dirname(BIN), "dotbabel.mjs") &&
    words[2] === "peer"
  )
    argv = words.slice(3);
  else return null;
  if (argv.length === 1 && ["--help", "-h"].includes(argv[0])) return argv;
  if (!COMMANDS.has(argv[0]) || ["setup", "launch", "input", "relay", "hook"].includes(argv[0]))
    return null;
  return argv;
}

/** Coordinate on behalf of an identity supplied by the native hook, replacing only harmless result printing. @param {object} store @param {object} who @param {object} input @param {NodeJS.ProcessEnv} env @returns {Promise<object|null>} */
export async function coordinatePeer(store, who, input, env) {
  const argv = peerCommand(input);
  if (!argv) return null;
  const existing = (await store.read()).pairs.find(
    (p) => !p.closed && [p.main?.key, p.advisor?.key].includes(who.key),
  );
  const guard = existing && peerHook(existing, who, input);
  if (guard) return guard;
  let value,
    code = 0;
  try {
    const parsed = parse(argv, FLAGS),
      [op, ...args] = parsed.positional;
    if (parsed.help && argv.length === 1) value = { usage: USAGE };
    else {
      validateArgs(op, args, parsed.flags);
      if (parsed.help || parsed.version || parsed.flags["repo-root"])
        usage("trusted peer coordination requires a literal operation in the current repository");
      value = await execute(store, op, args, parsed.flags, who, env);
      const pair = ["main", "advisor", "reconnect"].includes(op)
        ? value
        : pairFor(await store.read(), parsed.flags.pair, who, ["history", "unpair"].includes(op));
      launchRelay(store, pair, env);
    }
  } catch (err) {
    code = err.exitCode === 64 || err.code === "USAGE_UNKNOWN_FLAG" ? 64 : 1;
    value = {
      error: { code: code === 64 ? "PEER_USAGE" : "PEER_OPERATION", message: err.message },
    };
  }
  let quoted = `'${JSON.stringify(value).replaceAll("'", "'\\''")}'`;
  if (Buffer.byteLength(quoted) > 24576)
    quoted = `'${JSON.stringify({
      output: "read_ledger",
      ledger: store.file,
      command: argv[0],
      exit_code: code,
      pair_id: value?.main ? value.id : (existing?.id ?? null),
      result_id: value?.id ?? null,
      lease: value?.lease ?? null,
    }).replaceAll("'", "'\\''")}'`;
  const resultCommand = `printf '%s\\n' ${quoted}; exit ${code}`;
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "allow",
      permissionDecisionReason:
        "The installed peer hook handles this scoped coordination operation; the shell prints its result only.",
      updatedInput: {
        ...input.tool_input,
        command: resultCommand,
        ...(typeof input.tool_input.cmd === "string" ? { cmd: resultCommand } : {}),
      },
    },
  };
}

/** Run the peer CLI with common Dotbabel flags and stable exit categories. @param {string[]} argv @param {NodeJS.ProcessEnv} [env] @returns {Promise<number>} */
export async function runPeer(argv, env = process.env) {
  let parsed;
  try {
    parsed = parse(argv, FLAGS);
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    return 64;
  }
  if (parsed.help || (!parsed.positional.length && !parsed.version)) {
    process.stdout.write(USAGE);
    return 0;
  }
  if (parsed.version) {
    process.stdout.write("1.0.0\n");
    return 0;
  }
  const [command, ...args] = parsed.positional,
    flags = parsed.flags;
  try {
    validateArgs(command, args, flags);
    if (command === "setup") {
      if (!flags.harness)
        usage("setup requires --harness claude|codex|both|opencode|copilot|antigravity");
      if (
        !["claude", "codex", "both", "opencode", "copilot", "antigravity"].includes(flags.harness)
      )
        usage("unknown setup harness");
      print(
        environment(() => setupHooks(flags.harness, env, flags["repo-root"] || process.cwd())),
        parsed.json,
        command,
      );
      return 0;
    }
    if (command === "launch") {
      if (
        flags.harness !== "antigravity" ||
        !["main", "advisor"].includes(args[0]) ||
        (flags.pair
          ? args.length !== 1
          : args[0] === "advisor"
            ? args.length !== 2
            : args.length !== 1) ||
        (flags.conversation && !flags.pair)
      )
        usage("launch requires main|advisor CODE --harness antigravity");
      const { startAntigravityPeer } = await import("./integrations/antigravity.mjs");
      const repo = environment(() => repository(flags["repo-root"] || process.cwd()));
      const bridge = startAntigravityPeer({
        worktree: repo.worktree,
        role: args[0],
        code: args[1],
        pair: flags.pair,
        conversation: flags.conversation,
        env,
        onEvent: (event) => process.stdout.write(JSON.stringify(event) + "\n"),
      });
      const stop = () => {
        void bridge.close();
      };
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
      let lines;
      try {
        await bridge.ready;
        lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
        const submit = (async () => {
          for await (const line of lines) {
            if (line.trim() === ".quit") break;
            if (line.trim()) await bridge.send(line);
          }
          bridge.end();
        })();
        await Promise.race([bridge.done, submit.then(() => bridge.done)]);
      } finally {
        lines?.close();
        await bridge.close();
        process.removeListener("SIGINT", stop);
        process.removeListener("SIGTERM", stop);
      }
      return 0;
    }
    let input;
    if (command === "hook") {
      const text = fs.readFileSync(0, "utf8");
      if (Buffer.byteLength(text) > 65536) throw new Error("hook input too large");
      input = JSON.parse(text);
      input.hook_event_name = args[0];
      if (flags.harness === "antigravity") {
        const { antigravityHook } = await import("./integrations/antigravity.mjs");
        process.stdout.write(JSON.stringify(await antigravityHook(args[0], input, { env })) + "\n");
        return 0;
      }
    }
    const repo = environment(() => repository(flags["repo-root"] || input?.cwd || process.cwd())),
      store = environment(() => new PeerStore(peerRoot(env), repo.key));
    if (command === "relay") {
      const p = pairFor(await store.read(), flags.pair, null);
      await pump(store, p.id);
      return 0;
    }
    let who = null;
    try {
      who = currentSession(repo, {
        env,
        sessionId: input?.session_id || env.DOTBABEL_PEER_HOOK_SESSION,
      });
    } catch (err) {
      if (!flags.pair || !EXTERNAL.has(command)) {
        err.exitCode = 2;
        throw err;
      }
    }
    if (command === "hook") {
      const coordination = await coordinatePeer(store, who, input, env);
      if (coordination) {
        process.stdout.write(JSON.stringify(coordination) + "\n");
        return 0;
      }
      const p = (await store.read()).pairs.find(
        (p) => !p.closed && [p.main?.key, p.advisor?.key].includes(who.key),
      );
      if (!p) return 0;
      const result = await store.transaction((s) => peerHook(pairFor(s, p.id, who), who, input));
      if (result) process.stdout.write(JSON.stringify(result) + "\n");
      if (!["SessionEnd", "PreToolUse"].includes(args[0])) launchRelay(store, p, env);
      return 0;
    }
    if (command === "input") {
      const p = pairFor(await store.read(), flags.pair, who);
      launchRelay(store, p, env);
      process.stdout.write(
        `Advisor input ${p.id}: one investigation per line; .queue, .pause, .resume, .quit\n`,
      );
      const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
      for await (const line of lines) {
        if (line.trim() === ".quit") break;
        if (!line.trim()) continue;
        const op =
          { ".queue": "queue", ".pause": "pause", ".resume": "resume" }[line.trim()] ?? "ask";
        try {
          print(await execute(store, op, op === "ask" ? [line] : [], flags, who, env), true, op);
        } catch (err) {
          process.stderr.write(err.message + "\n");
        }
      }
      return 0;
    }
    const result = await execute(store, command, args, flags, who, env);
    print(result, parsed.json, command);
    const p =
      command === "main" || command === "advisor" || command === "reconnect"
        ? result
        : pairFor(
            await store.read(),
            flags.pair,
            who,
            command === "history" || command === "unpair",
          );
    launchRelay(store, p, env);
    return 0;
  } catch (err) {
    if (command === "hook" && flags.harness === "antigravity" && args[0] === "PreToolUse") {
      process.stdout.write(
        JSON.stringify({
          decision: "deny",
          reason:
            "Dotbabel cannot verify the peer role. Inspect peer setup and status before retrying.",
        }) + "\n",
      );
      return 0;
    }
    if (parsed.json)
      process.stdout.write(
        JSON.stringify({
          error: {
            code:
              err.exitCode === 64
                ? "PEER_USAGE"
                : err.exitCode === 2
                  ? "PEER_ENVIRONMENT"
                  : "PEER_OPERATION",
            message: err.message,
          },
        }) + "\n",
      );
    else process.stderr.write(`dotbabel peer: ${err.message}\n`);
    return err.exitCode ?? 1;
  }
}
