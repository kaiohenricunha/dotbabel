import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { it, expect } from "vitest";

const SKILL = fs.readFileSync(
  fileURLToPath(new URL("../../../../skills/peer/SKILL.md", import.meta.url)),
  "utf8",
);
const BIN = fileURLToPath(new URL("../../bin/dotbabel-peer.mjs", import.meta.url));
const help = spawnSync(process.execPath, [BIN, "--help"], { encoding: "utf8" }).stdout;
const commands = new Set(
  [...help.matchAll(/^ {2}dotbabel peer ([a-z|-]+)/gm)].flatMap((m) => m[1].split("|")),
);

it("lists only real peer commands in the argument hint, including unpair", () => {
  const words = SKILL.match(/^argument-hint: "(.*)"$/m)[1]
    .split("|")
    .map((part) => part.trim().split(" ")[0]);
  expect(words).toContain("unpair");
  for (const word of words) expect(commands, word).toContain(word);
});

it("tells either role how to end the pairing and keep its history", () => {
  const section = SKILL.split(/^## /m).find((s) => s.startsWith("End the pairing"));
  expect(section).toBeDefined();
  // After an unpair, status finds no open pair, so it cannot be the recovery step.
  const noPair = section.split(/(?<=\.)\s/).find((s) => s.includes("no unique pair"));
  expect(noPair).not.toContain("status");
  for (const command of [
    "dotbabel peer unpair",
    "refuses `unpair` from the Advisor",
    "! dotbabel peer unpair",
    "unpair from Main before you close it",
    "dotbabel peer reconnect main --pair PAIR_ID",
    "no unique pair",
    "dotbabel peer archive --pair PAIR_ID",
    "dotbabel peer history --pair PAIR_ID",
  ])
    expect(section).toContain(command);
});
