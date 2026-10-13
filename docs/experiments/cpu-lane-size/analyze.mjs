#!/usr/bin/env node
// Summarize a bench.sh run: phase A scaling, phase B fleet throughput, host
// responsiveness, and the lane-size decision from the rule fixed in the report.
//
//   node analyze.mjs [results-dir]    Markdown on stdout

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const dir = process.argv[2] ?? path.join(path.dirname(fileURLToPath(import.meta.url)), "results");
const readJsonl = (name) => {
  const file = path.join(dir, name);
  let text = "";
  if (fs.existsSync(file)) text = fs.readFileSync(file, "utf8");
  else if (fs.existsSync(`${file}.gz`)) text = zlib.gunzipSync(fs.readFileSync(`${file}.gz`)).toString("utf8");
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
};

const trials = readJsonl("trials.jsonl");
const probe = readJsonl("probe.jsonl");
const LAYOUT_WIDTH = { "5x3": 3, "4x4": 4, "3x5": 5, "2x7": 7, "1x15": 15 };
const JOBS_PER_LAYOUT = 10;
const DRIFT_TOLERANCE = 0.15;
const PROBE_FACTOR = 3;
const TIE = 0.05;

const quantile = (values, q) => {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (v.length === 0) return NaN;
  const i = (v.length - 1) * q;
  const lo = Math.floor(i);
  return v[lo] + (v[Math.ceil(i)] - v[lo]) * (i - lo);
};
const median = (values) => quantile(values, 0.5);
const fmt = (x, digits = 1) => (Number.isFinite(x) ? x.toFixed(digits) : "–");
const table = (head, rows) =>
  [`| ${head.join(" | ")} |`, `| ${head.map(() => "---").join(" | ")} |`, ...rows.map((r) => `| ${r.join(" | ")} |`)].join("\n");

const out = [];
const meta = trials.filter((t) => t.phase === "meta");
if (meta.length) {
  const m = meta[0];
  out.push(`Runs: ${meta.map((x) => x.cmd).join(", ")}. CPU: ${m.cpu}. Kernel: ${m.kernel}. Seed: ${m.seed}.`, "");
}

// Host speed: the drift probe before each trial.
const jobs = trials.filter((t) => ["P", "A", "B"].includes(t.phase));
const driftMedian = median(jobs.map((t) => t.drift_ms));
const drifted = (t) => Number.isFinite(t.drift_ms) && Math.abs(t.drift_ms - driftMedian) / driftMedian > DRIFT_TOLERANCE;
out.push(
  "## Host drift",
  "",
  `Drift probe median ${fmt(driftMedian, 0)} ms over ${jobs.length} trials; ${jobs.filter(drifted).length} trials are more than ${DRIFT_TOLERANCE * 100}% off (marked *).`,
  "",
);

// Responsiveness when no trial runs, and per window.
const quiet = probe.filter((p) => p.trial === "IDLE");
const idle = quiet.length > 0 ? quiet : probe.filter((p) => !p.trial);
const idleNodeP95 = quantile(idle.map((p) => p.node_ms), 0.95);
const window = (name) => probe.filter((p) => p.trial === name);
out.push(
  "## Idle host",
  "",
  `\`node -e 0\`: p50 ${fmt(quantile(idle.map((p) => p.node_ms), 0.5), 0)} ms, p95 ${fmt(idleNodeP95, 0)} ms (${idle.length} samples).`,
  "",
);

// Pilot.
const pilot = trials.filter((t) => t.phase === "P");
if (pilot.length) {
  out.push(
    "## Pilot",
    "",
    table(
      ["suite", "layout", "cpus", "wall s", "exit", "failures", "timeouts", "drift ms"],
      pilot.map((t) => [t.suite, t.layout, t.cpus, fmt(t.wall), t.exit, t.failures, t.timeouts, `${fmt(t.drift_ms, 0)}${drifted(t) ? "*" : ""}`]),
    ),
    "",
  );
}

// Phase A: each suite alone at N CPUs.
const solo = trials.filter((t) => t.phase === "A");
const soloFailures = {};
if (solo.length) {
  out.push("## Phase A: one suite alone", "");
  for (const suite of [...new Set(solo.map((t) => t.suite))].sort()) {
    const rows = solo.filter((t) => t.suite === suite);
    soloFailures[suite] = rows.reduce((n, t) => n + (t.failures || 0) + (t.exit !== 0 ? 1 : 0), 0);
    const widths = [...new Set(rows.map((t) => t.width))].sort((a, b) => a - b);
    const base = median(rows.filter((t) => t.width === widths[0]).map((t) => t.wall));
    out.push(
      `### ${suite}`,
      "",
      table(
        ["CPUs", "runs", "median wall s", "speedup", "efficiency", "CPU s", "failures"],
        widths.map((w) => {
          const at = rows.filter((t) => t.width === w);
          const wall = median(at.map((t) => t.wall));
          const speedup = base / wall;
          return [
            w,
            `${at.length}${at.some(drifted) ? "*" : ""}`,
            fmt(wall),
            fmt(speedup, 2),
            fmt((speedup * widths[0]) / w, 2),
            fmt(median(at.map((t) => t.user + t.sys))),
            at.reduce((n, t) => n + t.failures, 0),
          ];
        }),
      ),
      "",
    );
  }
}

// Phase B: a queue of jobs through each layout.
const runs = trials.filter((t) => t.phase === "B-layout");
const layoutRows = [];
if (runs.length) {
  for (const layout of [...new Set(runs.map((r) => r.layout))]) {
    const reps = runs.filter((r) => r.layout === layout);
    const makespans = reps.map((r) => (r.end - r.start) / 1000);
    const jobsIn = trials.filter((t) => t.phase === "B" && t.layout === layout);
    // A layout with one lane runs one job at a time: its failures cannot come from load.
    const concurrent = layout === "unlaned" || (LAYOUT_WIDTH[layout] ?? 0) < 15;
    const loadFailures = concurrent
      ? jobsIn.filter((t) => (t.failures > 0 || t.exit !== 0) && !soloFailures[t.suite]).length
      : 0;
    const samples = reps.flatMap((r) => window(`B-${layout}-r${r.rep}`));
    layoutRows.push({
      layout,
      width: LAYOUT_WIDTH[layout] ?? null,
      makespan: median(makespans),
      perHour: (JOBS_PER_LAYOUT * 3600) / median(makespans),
      turnaround: median(jobsIn.map((t) => (t.end - reps.find((r) => r.rep === t.rep).start) / 1000)),
      failures: jobsIn.reduce((n, t) => n + t.failures, 0),
      loadFailures,
      timeouts: jobsIn.reduce((n, t) => n + t.timeouts, 0),
      nodeP95: quantile(samples.map((p) => p.node_ms), 0.95),
      psiMedian: median(samples.map((p) => p.psi_avg10)),
      psiP95: quantile(samples.map((p) => p.psi_avg10), 0.95),
      loadMax: Math.max(...samples.map((p) => p.load1)),
      reps: reps.length,
    });
  }
  out.push(
    "## Phase B: 10 jobs through each layout",
    "",
    table(
      ["layout", "reps", "makespan s", "jobs/h", "turnaround s", "failures", "from load", "timeouts", "node p95 ms", "PSI median", "PSI p95", "max load"],
      layoutRows.map((r) => [
        r.layout,
        r.reps,
        fmt(r.makespan, 0),
        fmt(r.perHour),
        fmt(r.turnaround, 0),
        r.failures,
        r.loadFailures,
        r.timeouts,
        fmt(r.nodeP95, 0),
        fmt(r.psiMedian),
        fmt(r.psiP95),
        fmt(r.loadMax),
      ]),
    ),
    "",
  );

  // The decision rule, as written in the report before the run.
  const limit = PROBE_FACTOR * idleNodeP95;
  const eligible = layoutRows.filter((r) => r.width && r.loadFailures === 0 && r.timeouts === 0 && !(r.nodeP95 > limit));
  out.push("## Decision", "");
  if (eligible.length === 0) {
    out.push("No layout passes the failure and responsiveness limits.");
  } else {
    const best = Math.max(...eligible.map((r) => r.perHour));
    const winner = eligible.filter((r) => r.perHour >= best * (1 - TIE)).sort((a, b) => b.width - a.width)[0];
    out.push(
      `Eligible: ${eligible.map((r) => r.layout).join(", ")} (node p95 limit ${fmt(limit, 0)} ms).`,
      `Winner: **${winner.layout}**, ${winner.width} CPUs per lane, ${fmt(winner.perHour)} jobs/h (best ${fmt(best)}; ties within ${TIE * 100}% go to larger lanes).`,
    );
    const gains = [...new Set(solo.map((t) => t.suite))].sort().map((suite) => {
      const at = (w) => median(solo.filter((t) => t.suite === suite && t.width === w).map((t) => t.wall));
      return `${suite} ${fmt(at(winner.width) / at(15), 2)}x`;
    });
    out.push(`A lone run at 15 CPUs against ${winner.width}: ${gains.join(", ")} faster.`);
  }
  out.push("");
}

// Phase C: jobs arrive over time and queue for lanes. Only clean runs count,
// and only repetitions in which every layout has a clean run, so the layouts
// stay paired on the same arrival schedules.
const cLayoutRuns = trials.filter((t) => t.phase === "C-layout");
const cleanRun = new Map();
for (const r of cLayoutRuns) if (r.contaminated === false) cleanRun.set(`${r.layout}|${r.rep}`, r);
const cLayouts = [...new Set(cLayoutRuns.map((r) => r.layout))];
const dropped = new Set(trials.filter((t) => t.phase === "C-rep-dropped").map((t) => t.rep));
const cleanReps = [...new Set(cLayoutRuns.map((r) => r.rep))].filter(
  (rep) => !dropped.has(rep) && cLayouts.every((l) => cleanRun.has(`${l}|${rep}`)),
);
if (cLayoutRuns.length) {
  out.push(
    "## Phase C runs",
    "",
    table(
      ["run", "jobs", "foreign mean %", "foreign max %", "s over trip", "contaminated", "used"],
      cLayoutRuns.map((r) => [
        `${r.layout} r${r.rep} a${r.attempt ?? 1}`,
        r.jobs,
        fmt(r.foreign?.mean),
        fmt(r.foreign?.max),
        r.foreign?.over_trip_s ?? "–",
        r.contaminated ?? "–",
        cleanReps.includes(r.rep) && cleanRun.get(`${r.layout}|${r.rep}`) === r ? "yes" : "no",
      ]),
    ),
    "",
    `Clean paired repetitions: ${cleanReps.length} (${cleanReps.join(", ") || "none"}).`,
    "",
  );
}
for (const a of trials.filter((t) => t.phase === "C-abort")) {
  out.push(`Stopped without data before ${a.label}: foreign load ${fmt(a.foreign_permille / 10)}% did not go down.`, "");
}
const arrivals = trials.filter((t) => {
  if (t.phase !== "C") return false;
  const run = cleanRun.get(`${t.layout}|${t.rep}`);
  return run && cleanReps.includes(t.rep) && (t.attempt ?? 1) === (run.attempt ?? 1);
});
if (arrivals.length) {
  const SHORT = new Set(["DV", "SG"]);
  const cRuns = cLayoutRuns.filter((r) => cleanReps.includes(r.rep) && cleanRun.get(`${r.layout}|${r.rep}`) === r);
  const stats = {};
  for (const layout of [...new Set(arrivals.map((t) => t.layout))]) {
    const rows = arrivals.filter((t) => t.layout === layout);
    const wait = rows.map((t) => ((t.start ?? t.end) - t.arrive) / 1000);
    const turn = rows.map((t) => (t.end - t.arrive) / 1000);
    const shortTurn = rows.filter((t) => SHORT.has(t.suite)).map((t) => (t.end - t.arrive) / 1000);
    const samples = cleanReps.flatMap((rep) => window(`C-${layout}-r${rep}-a${cleanRun.get(`${layout}|${rep}`).attempt ?? 1}`));
    stats[layout] = {
      jobs: rows.length,
      meanTurn: turn.reduce((s, x) => s + x, 0) / turn.length,
      p95Turn: quantile(turn, 0.95),
      p50Wait: quantile(wait, 0.5),
      p95Wait: quantile(wait, 0.95),
      shortP95: quantile(shortTurn, 0.95),
      failures: rows.reduce((n, t) => n + (t.failures || 0) + (t.exit !== 0 && !t.failures ? 1 : 0), 0),
      nodeP95: quantile(samples.map((p) => p.node_ms), 0.95),
      span: median(cRuns.filter((r) => r.layout === layout).map((r) => (r.end - r.start) / 1000)),
    };
  }
  out.push(
    "## Phase C: jobs arrive over time",
    "",
    table(
      ["layout", "jobs", "mean turnaround s", "p95 turnaround s", "p50 wait s", "p95 wait s", "short p95 s", "failures", "node p95 ms", "median run s"],
      Object.entries(stats).map(([k, s]) => [k, s.jobs, fmt(s.meanTurn), fmt(s.p95Turn), fmt(s.p50Wait), fmt(s.p95Wait), fmt(s.shortP95), s.failures, fmt(s.nodeP95, 0), fmt(s.span, 0)]),
    ),
    "",
  );
  // Locked rule: a layout replaces 3x5 only when it wins clearly and costs nothing else.
  const base = stats["3x5"];
  if (cleanReps.length < 2) {
    out.push("## Phase C decision", "", `No decision: ${cleanReps.length} clean paired repetitions, and the rule needs at least 2.`, "");
  } else if (base) {
    const winners = Object.entries(stats)
      .filter(([k]) => k !== "3x5")
      .filter(([, s]) => s.meanTurn <= base.meanTurn * 0.95)
      .filter(([, s]) => s.shortP95 <= base.shortP95 * 1.2)
      .filter(([, s]) => s.failures <= base.failures)
      .filter(([, s]) => !(s.nodeP95 > base.nodeP95 * 1.5))
      .sort((x, y) => x[1].meanTurn - y[1].meanTurn);
    out.push(
      "## Phase C decision",
      "",
      winners.length
        ? `**${winners[0][0]}** replaces 3x5: mean turnaround ${fmt(winners[0][1].meanTurn)} s against ${fmt(base.meanTurn)} s (${fmt((1 - winners[0][1].meanTurn / base.meanTurn) * 100)}% lower).`
        : `No layout beats 3x5 by the locked rule, so 3x5 stays (mean turnaround ${fmt(base.meanTurn)} s).`,
      "",
    );
  }
}

process.stdout.write(`${out.join("\n")}\n`);
