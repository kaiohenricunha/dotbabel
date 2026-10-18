#!/usr/bin/env node
// Offline preparation and evaluation only. There is deliberately no send operation.
import fs from "node:fs";
import { parseArgs } from "node:util";
import { createLock, validateLock, requestPlan } from "./protocol.mjs";
import { evaluate } from "./analysis.mjs";

try {
  const { values: opts, positionals } = parseArgs({ allowPositionals: true, options: Object.fromEntries(
    ["dataset", "lock", "out", "answers", "consent-public-repo"].map(k => [k, { type: "string" }])) });
  const [command] = positionals;
  if (positionals.length !== 1 || !["lock", "check", "dry-run", "evaluate"].includes(command)) throw new Error("expected lock, check, dry-run, or evaluate");
  let result;
  if (command === "lock") {
    if (!opts.dataset || !opts.out) throw new Error("lock needs --dataset --out --consent-public-repo");
    result = createLock(opts.dataset, opts.out, { repo: opts["consent-public-repo"] });
  } else {
    if (!opts.lock) throw new Error("operation needs --lock");
    if (command === "check") {
      const { rows, binding, ...metadata } = validateLock(opts.lock); result = metadata;
    } else if (command === "evaluate") {
      const answers = opts.answers ? fs.readFileSync(opts.answers, "utf8").split("\n").filter(Boolean).map(JSON.parse) : [];
      result = evaluate(opts.lock, answers);
    } else {
      if (!opts.out) throw new Error("dry-run needs --out --consent-public-repo");
      const plan = requestPlan(opts.lock, opts["consent-public-repo"]);
      fs.writeFileSync(opts.out, plan.map(JSON.stringify).join("\n") + (plan.length ? "\n" : ""), { flag: "wx", mode: 0o600 });
      result = { dry_run: true, requests: plan.length, network_requests: 0, adoption_eligible: false };
    }
  }
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
} catch (error) {
  // No dataset lines, adapter responses, configuration, or credentials are echoed.
  process.stderr.write("graph-step-adoption-v2: " + (error instanceof SyntaxError ? "invalid JSON data" : error.code ? String(error.code) : String(error.message).slice(0, 180)) + "\n");
  process.exitCode = 2;
}
