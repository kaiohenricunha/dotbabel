/**
 * CPU lanes of `dotbabel fleet`: how lane state is read and shown.
 *
 * The lane itself — the layout, the flock queue, `taskset` — lives in
 * scripts/fleet-lane.sh, so a lane works without Node. The heavy-command
 * detector lives in heavy.mjs. This module reads the lane files and renders
 * `dotbabel fleet lanes`.
 */

import fs from "node:fs";
import path from "node:path";
import { formatAge } from "./format.mjs";
import { isOwnerAlive } from "./registry.mjs";

// --------------------------------------------------------------- state ----

/**
 * Count the CPUs in a taskset list such as "0-4" or "0,2,4-5". 0 when invalid.
 *
 * @param {string} list
 * @returns {number}
 */
export function cpuCount(list) {
  if (!list) return 0;
  let total = 0;
  for (const part of String(list).split(",")) {
    const range = /^(\d+)(?:-(\d+))?$/.exec(part);
    if (!range) return 0;
    const lo = Number(range[1]);
    const hi = range[2] === undefined ? lo : Number(range[2]);
    if (hi < lo) return 0;
    total += hi - lo + 1;
  }
  return total;
}

/**
 * Parse the output of `fleet-lane.sh --layout`.
 *
 * @param {string} text
 * @returns {{off: boolean, ncpu: number|null, lanes: Array<{index: number, cpus: string, width: number}>}}
 */
export function parseLayout(text) {
  const layout = { off: false, ncpu: null, lanes: [] };
  for (const line of String(text).split("\n")) {
    const f = line.trim().split(/\s+/);
    if (f[0] === "off") layout.off = true;
    else if (f[0] === "ncpu") layout.ncpu = Number(f[1]);
    else if (f[0] === "lane" && f.length === 3) {
      layout.lanes.push({ index: Number(f[1]), cpus: f[2], width: cpuCount(f[2]) });
    }
  }
  return layout;
}

/**
 * Parse the `key=value` lines of a lane holder or waiter file.
 *
 * @param {string} text
 * @returns {Record<string, string>}
 */
export function parseKeyValue(text) {
  const out = {};
  for (const line of String(text).split("\n")) {
    const eq = line.indexOf("=");
    if (eq > 0) out[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return out;
}

function readInfo(file, procOpts) {
  let info;
  try {
    info = parseKeyValue(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
  const owner = { pid: Number(info.pid), procStart: info.procstart || null };
  return isOwnerAlive(owner, procOpts) ? info : null;
}

/**
 * The live holder of each lane and the live waiters, from the lane directory.
 * A file whose process is gone (the script was killed) is ignored.
 *
 * @param {string} dir   <state>/lanes
 * @param {{lanes: Array<{index: number}>}} layout
 * @param {{procRoot?: string}} [procOpts]
 * @returns {{holders: Record<number, Record<string, string>>, waiters: Array<Record<string, string>>}}
 */
export function readLaneState(dir, layout, procOpts = {}) {
  const holders = {};
  for (const lane of layout.lanes) {
    const info = readInfo(path.join(dir, `lane-${lane.index}.holder`), procOpts);
    if (info) holders[lane.index] = info;
  }
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((n) => /^wait-\d+\.info$/.test(n));
  } catch {
    // No lane has run on this machine yet.
  }
  const waiters = names.map((n) => readInfo(path.join(dir, n), procOpts)).filter(Boolean);
  return { holders, waiters };
}

/** "15", "14-15", or "3, 7-8" for a sorted list of CPU ids. */
function cpuRanges(ids) {
  const parts = [];
  for (let i = 0; i < ids.length; ) {
    let j = i;
    while (j + 1 < ids.length && ids[j + 1] === ids[j] + 1) j += 1;
    parts.push(i === j ? `${ids[i]}` : `${ids[i]}-${ids[j]}`);
    i = j + 1;
  }
  return parts.join(", ");
}

/**
 * The human report of `dotbabel fleet lanes`.
 *
 * @param {object} args
 * @param {ReturnType<typeof parseLayout>} args.layout
 * @param {Record<number, Record<string, string>>} args.holders
 * @param {Array<Record<string, string>>} args.waiters
 * @param {number} args.now epoch ms
 * @returns {string}
 */
export function formatLanes({ layout, holders, waiters, now }) {
  if (layout.off) return "CPU lanes are off.";
  const count = layout.lanes.length;
  const used = new Set();
  for (const lane of layout.lanes) {
    for (const part of lane.cpus.split(",")) {
      const [lo, hi = lo] = part.split("-").map(Number);
      for (let c = lo; c <= hi; c += 1) used.add(c);
    }
  }
  const free = layout.ncpu ? [...Array(layout.ncpu).keys()].filter((c) => !used.has(c)) : [];
  const age = (started) => formatAge(now - Number(started) * 1000);
  const lines = [`CPU lanes: ${count} lane${count === 1 ? "" : "s"} on ${layout.ncpu ?? "?"} CPUs.`];
  if (free.length === 1) lines[0] += ` CPU ${free[0]} stays free.`;
  else if (free.length > 1) lines[0] += ` CPUs ${cpuRanges(free)} stay free.`;
  const width = Math.max(...layout.lanes.map((l) => l.cpus.length), 1);
  for (const lane of layout.lanes) {
    const h = holders[lane.index];
    const head = `  lane ${lane.index}  CPUs ${lane.cpus.padEnd(width)}`;
    lines.push(h ? `${head}  busy  ${h.label}  ${h.session || "-"}  ${age(h.started)}  ${h.cwd ?? ""}`.trimEnd() : `${head}  free`);
  }
  if (waiters.length > 0) {
    lines.push(waiters.length === 1 ? "1 command waits for a lane:" : `${waiters.length} commands wait for a lane:`);
    for (const w of waiters) lines.push(`  ${w.label}  ${w.session || "-"}  ${age(w.started)}`);
  }
  return lines.join("\n");
}
