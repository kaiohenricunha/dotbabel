#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { constants } from "node:os";
import { fileURLToPath } from "node:url";

const usage = "Usage: node codex-yolo.mjs --for <1m..24h> [--merge|--no-merge] <scope>";
const args = process.argv.slice(2);
if (args.length === 1 && ["--help", "-h"].includes(args[0])) {
  console.log(
    `${usage}\nStart a new Codex session with Full access and the yolo skill.\n` +
      "Full access removes filesystem and network sandbox restrictions and shell approval prompts.\n" +
      "The scope timer ends task authorization; it does not restore runtime permissions.\n" +
      "Use $yolo off inside an existing session to cancel its task authorization.",
  );
  process.exit(0);
}

function invalid(reason) {
  console.error(`${reason}\n${usage}`);
  process.exit(64);
}

let duration;
let merge;
const scope = [];
for (let index = 0; index < args.length; index++) {
  const arg = args[index];
  if (arg === "--for") {
    if (duration !== undefined) invalid("Use --for only once.");
    duration = args[++index];
  } else if (arg === "--merge" || arg === "--no-merge") {
    if (merge && merge !== arg) invalid("Conflicting merge flags.");
    merge = arg;
  } else if (arg.startsWith("--")) {
    invalid(`Unknown flag: ${arg}`);
  } else {
    scope.push(arg);
  }
}

const match = /^(\d{1,5})(h|m)$/.exec(duration ?? "");
const minutes = match ? Number(match[1]) * (match[2] === "h" ? 60 : 1) : 0;
if (minutes < 1 || minutes > 1440) invalid("--for needs a positive lifetime of at most 24h.");
const task = scope.join(" ").trim();
if (!task || task === "off") invalid("A new session needs an explicit task scope.");

const skill = fileURLToPath(new URL("../SKILL.md", import.meta.url));
const invocation = [`$yolo --for ${duration}`, merge, task].filter(Boolean).join(" ");
const prompt = `${invocation}\n\nRead and follow the yolo skill at ${JSON.stringify(skill)}.`;
const result = spawnSync(
  "codex",
  ["--sandbox", "danger-full-access", "--ask-for-approval", "never", prompt],
  { stdio: "inherit" },
);
if (result.error) {
  console.error(`Cannot start codex: ${result.error.message}`);
  process.exit(result.error.code === "ENOENT" ? 127 : 1);
}
process.exit(result.status ?? 128 + (constants.signals[result.signal] ?? 0));
