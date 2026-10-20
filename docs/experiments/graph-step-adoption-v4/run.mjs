#!/usr/bin/env node
// lock, check, dry-run, send, evaluate for retry. Only send uses the network, with --consent-send and the key.
import fs from "node:fs";
import { parseArgs } from "node:util";
import { createLock, validateLock, requestPlan } from "./protocol.mjs";
import { evaluate } from "./analysis.mjs";
import { sendPlan } from "./send.mjs";

try {
  const { values: opts, positionals } = parseArgs({ allowPositionals: true, options: {
    ...Object.fromEntries(["dataset", "lock", "out", "answers", "consent-send"].map(k => [k, { type: "string" }])),
    resume: { type: "boolean" } } });
  const [command] = positionals;
  if (positionals.length !== 1 || !["lock", "check", "dry-run", "send", "evaluate"].includes(command)) throw new Error("expected lock, check, dry-run, send, or evaluate");
  let result;
  if (command === "lock") {
    if (!opts.dataset || !opts.out) throw new Error("lock needs --dataset --out");
    result = createLock(opts.dataset, opts.out);
  } else {
    if (!opts.lock) throw new Error("operation needs --lock");
    if (command === "check") {
      const { rows, binding, ...metadata } = validateLock(opts.lock); result = metadata;
    } else if (command === "evaluate") {
      const answers = opts.answers ? fs.readFileSync(opts.answers, "utf8").split("\n").filter(Boolean).map(JSON.parse) : [];
      result = evaluate(opts.lock, answers);
    } else if (command === "send") {
      if (!opts.out) throw new Error("send needs --out --consent-send <repositories_sha256>");
      result = await sendPlan(opts.lock, opts.out, { consent: opts["consent-send"], key: process.env.TYPESAFE_API_KEY, resume: opts.resume === true });
    } else {
      if (!opts.out) throw new Error("dry-run needs --out");
      const plan = requestPlan(opts.lock);
      fs.writeFileSync(opts.out, plan.map(r => JSON.stringify(r)).join("\n") + (plan.length ? "\n" : ""), { flag: "wx", mode: 0o600 });
      result = { dry_run: true, requests: plan.length, network_requests: 0 };
    }
  }
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  if (command === "send" && result.failed) process.exitCode = 1;
} catch (error) {
  // No dataset lines, adapter responses, configuration, or credentials are echoed.
  process.stderr.write("graph-step-adoption-v4: " + (error instanceof SyntaxError ? "invalid JSON data" : error.code ? String(error.code) : String(error.message).slice(0, 180)) + "\n");
  process.exitCode = 2;
}
