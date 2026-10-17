#!/usr/bin/env node
/** JSON stdin/stdout interface to bounded decisions. Adapter failures exit 0. */
import { parse, helpText } from "../src/lib/argv.mjs";
import { version } from "../src/index.mjs";
import { decide, validateDecisionInput } from "../src/decider.mjs";
import { deciderContext, decisionAttemptCap } from "../src/decider-config.mjs";
import { DECISION_STEPS } from "../src/decision-value.mjs";
import { jevAdapter } from "../src/jev-adapter.mjs";

const META = { name: "dotbabel-decide", synopsis: "dotbabel decide --step review-triage|retry|dispatch [--base-ref <ref>] < input.json", description: "Read one step input and print one JSON decision. No network unless the committed repository config consents to Jev.", flags: { step: { type: "string" }, "base-ref": { type: "string" } } };
let exitCode = 0;
try {
  const args = parse(process.argv.slice(2), META.flags);
  if (args.help) process.stdout.write(helpText(META));
  else if (args.version) process.stdout.write(`${version}\n`);
  else {
    exitCode = 64;
    if (!DECISION_STEPS.includes(args.flags.step) || args.positional.length) throw new Error("unknown or missing decision step");
    exitCode = 2;
    const context = deciderContext();
    exitCode = 64;
    let raw = "";
    process.stdin.setEncoding("utf8");
    for await (const chunk of process.stdin) {
      raw += chunk;
      if (Buffer.byteLength(raw) > 65536) throw new Error("decision input exceeds 64 KiB");
    }
    let input;
    try { input = JSON.parse(raw); } catch { throw new Error("decision input must be JSON"); }
    validateDecisionInput(args.flags.step, input);
    exitCode = 2;
    const maxAttempts = args.flags.step === "retry" ? decisionAttemptCap(context.root, input?.phase, args.flags["base-ref"]) : 3;
    exitCode = 64;
    const result = await decide(args.flags.step, input, { config: context.config, consent: context.consentSteps.includes(args.flags.step), key: context.key, adapter: jevAdapter(context.key), maxAttempts });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    exitCode = 0;
  }
} catch (err) {
  // Errors contain only our fixed diagnostics; never serialize vendor errors or input.
  const message = err.code?.startsWith("USAGE") ? "invalid arguments" : err.message;
  process.stderr.write(`dotbabel decide: ${String(message).split(process.env.TYPESAFE_API_KEY || "\0").join("<redacted>")}\n`);
  if (!exitCode) exitCode = 64;
}
process.exitCode = exitCode;
