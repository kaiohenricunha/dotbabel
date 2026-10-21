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
  expect(section).not.toContain("peer status");
  for (const command of [
    "dotbabel peer unpair",
    "no unique pair",
    "dotbabel peer archive --pair PAIR_ID",
    "dotbabel peer history --pair PAIR_ID",
  ])
    expect(section).toContain(command);
});
