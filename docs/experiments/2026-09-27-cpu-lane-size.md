# Experiment: CPU lane size — 2026-09-27

The `dotbabel fleet` CPU lanes give each heavy test run about 5 CPUs: `k = (usable + 2) / 5` lanes, and 1 CPU is reserved when a machine has 6 or more (`plugins/dotbabel/scripts/fleet-lane.sh:99-111`). Nobody measured the 5. This experiment measures which lane size finishes the most test runs per hour on one real machine. The limits are no test failures from load and a responsive host.

## Decision rule (locked before running)

1. Drop a layout that has a failure from load, meaning a failure that its solo run did not have. Also drop a layout whose `node -e 0` probe p95 is more than 3× the idle p95.
2. From the remaining layouts, pick the highest phase B jobs/hour. If two are within 5%, pick the one with fewer, larger lanes.
3. Convert the winner to CPUs per lane W, as `k = (usable + ⌊W/2⌋) / W`. W = 5 means no change.

## Environment

- **Machine:** i7-13620H hybrid CPU (6 P-cores with SMT, 4 E-cores). It runs WSL2 (kernel 6.6.87.2) with 16 vCPUs and 39 GB of RAM. WSL2 shows a fake 8×2 topology, so a `taskset` pin fixes vCPUs, not physical cores.
- **Run:** 2026-09-26 20:33 to 2026-09-27 02:39, detached, with all 3 fleet lanes held. The machine was on AC power, and no other test runs took place.
- **Suites, all offline:**

| Id  | Repo @ SHA            | Command                                                                         |
| --- | --------------------- | ------------------------------------------------------------------------------- |
| DV  | dotbabel @ 2bc2de8    | `npx vitest run` (141 files)                                                    |
| DB  | dotbabel              | `bash plugins/dotbabel/scripts/run-bats.sh` (75 files, `-j 8`)                  |
| DBJ | dotbabel              | the same, with `BATS_JOBS` = the lane's CPUs                                    |
| SV  | squadranks @ a4eb90a3 | `npx vitest run` (222 files)                                                    |
| SG  | squadranks `api/`     | `go test ./... -race -count=1`                                                  |
| MP  | moneyballer @ cbec9bc | `pytest elt/tests/ -m 'not real_api' --timeout=120 -n auto -p no:cacheprovider` |

- **Harness:** [`cpu-lane-size/bench.sh`](./cpu-lane-size/bench.sh) and [`cpu-lane-size/analyze.mjs`](./cpu-lane-size/analyze.mjs).
  - Each job runs in its own detached worktree (a "slot"), with `node_modules` hardlinked from the main checkout.
  - A job gets the same pin and environment that a lane gives: `taskset`, `DOTBABEL_LANE`, and `PYTEST_XDIST_AUTO_NUM_WORKERS`.
  - A probe records host responsiveness once per second: the time to start `node -e 0` and `bash -c :`, load1, and CPU PSI.
  - A 1-second, single-thread drift probe on the reserved CPU 15 runs before each trial.
- **Deviations from the plan:**
  - The budget rule applied, because the full grid would take about 6.5 hours. Phase A used N = 2, 3, 5, 6, 8, 15, with 2 repetitions, and phase B used 2 repetitions. The run still took 6 hours.
  - The idle guard before a trial is "less than 10% of all CPUs busy over 2 s", not load1 < 1.0. The 1-minute load average decays too slowly after each trial.
  - The pilot showed that the idle baseline had only 3 samples, so a 60-second idle window came first.

## Phase A: one suite alone (median wall time in seconds, 2 runs)

| CPUs | DV   | DB    | DBJ   | SV    | SG   | MP    |
| ---- | ---- | ----- | ----- | ----- | ---- | ----- |
| 2    | 78.5 | 137.9 | 345.7 | 232.0 | 47.6 | 653.0 |
| 3    | 43.9 | 127.6 | 184.0 | 140.9 | 31.9 | 501.6 |
| 5    | 32.5 | 102.3 | 122.9 | 87.3  | 30.4 | 311.8 |
| 6    | 28.4 | 96.1  | 107.7 | 89.7  | 29.6 | 311.9 |
| 8    | 25.7 | 100.4 | 94.1  | 87.4  | 28.3 | 228.4 |
| 15   | 23.7 | 97.4  | 79.6  | 82.2  | 24.6 | 187.0 |

SG is flat after 3 CPUs, and SV and DB are flat after 5. DV and MP keep gaining up to 15 CPUs.

## Phase B: 10 jobs (2 of each suite) through each layout, 2 runs

| Layout      | Makespan s | Jobs/h | Mean turnaround s | Failures (from load) | `node -e 0` p95 ms | PSI median / p95 | Max load |
| ----------- | ---------- | ------ | ----------------- | -------------------- | ------------------ | ---------------- | -------- |
| unlaned     | 897        | 40.1   | 473               | 1 (1)                | 450                | 60.9 / 87.8      | 58.0     |
| 1×15        | 940        | 38.3   | 410               | 1 (0)                | 124                | 3.6 / 24.6       | 21.6     |
| 2×7         | 949        | 38.0   | 457               | 0                    | 121                | 9.2 / 21.4       | 19.5     |
| 4×4         | 962        | 37.4   | 467               | 0                    | 106                | 8.4 / 45.4       | 28.8     |
| 3×5 (today) | 1000       | 36.0   | 539               | 0                    | 105                | 10.5 / 35.2      | 23.4     |
| 5×3         | 1121       | 32.1   | 546               | 0                    | 101                | 6.5 / 40.8       | 29.6     |

The idle `node -e 0` p95 was 22 ms (59 samples).

The two failures:

- **unlaned:** SG `TestResultSync_RunLoop_TransitionsBetweenIntervals` failed. It is a timing test, and it failed at load 58. This is a failure from load.
- **1×15:** SV `e2e-seed-residue.test.mjs` failed. It is a live check against the repository, and in this layout no other job ran at the same time. This is not a failure from load.

## Findings

1. **Lanes are worth their cost.** Without lanes, 5 suites at once finish 5% more jobs per hour. But the host is 4× slower to start a process (450 ms p95), CPU pressure has a median of 61%, the load goes to 58, and a timing test fails. With any lane layout, the p95 stays at 101–124 ms, and no test fails from load.
2. **Fewer, larger lanes do slightly better than today's 3×5.** 1×15, 2×7, and 4×4 are within 2.5% of each other. Today's 3×5 is 6% slower than the best, and 5×3 is 16% slower. Responsiveness is the same for every lane layout.
3. **Lanes do not isolate runs completely.** In the pilot, two DV runs on separate 5-CPU lanes took 33 s each, against 24 s for one run alone. They share memory bandwidth and the Windows scheduler on the hybrid CPU.
4. **Keep bats at `-j 8`.** The default (`-j 8` from `getconf`) is faster than `BATS_JOBS` = the lane's CPUs at every width up to 6: 102 s against 123 s at 5 CPUs. `run-bats.sh` needs no change.
5. **The host was slower overnight for multi-core work.** DV at 15 CPUs took 23–24 s, against 10.8 s in the daytime pilot. The single-thread drift probe changed only 8% (median 1101 ms), and 11 of 192 trials were more than 15% off (max 2.8 s). The comparisons stay fair because the layouts were interleaved, but absolute times are high.

## Decision

**Under the locked rule, no layout qualifies.** The responsiveness limit (3 × 22 ms = 66 ms) is below what any CPU-bound test load gives on this machine. Every lane layout had a p95 of 101–124 ms.

**Recommendation (post-hoc, for the user to decide).** Two lanes of 7–8 CPUs (W = 7, `k = (usable + 3) / 7`, which gives lanes 0-6 and 7-14 on this machine) would do this:

- It finishes 5% more jobs per hour than 3×5, with the same responsiveness and no failures from load.
- A lone run is faster: DV 25.7 s instead of 32.5 s, MP 228 s instead of 312 s, and SG 28 s instead of 30 s.

The throughput gain is close to the noise of 2 repetitions on a host that drifts. A 1-hour daytime run of only 3×5 against 2×7, with 3 repetitions, would confirm it before the formula changes.

## Reproduce

```bash
cd docs/experiments/cpu-lane-size
bash bench.sh setup
BENCH_NS="2 3 5 6 8 15" BENCH_REPS_A=2 BENCH_REPS_B=2 setsid nohup bash bench.sh full > /tmp/lane-bench-logs/full.out 2>&1 &
node analyze.mjs results
bash bench.sh teardown
```

`results/trials.jsonl` has one row per trial, and `results/probe.jsonl.gz` has the host probe. The pilot data is in `results/pilot/`.

## Test 1: jobs that arrive over time (2026-09-28)

Phases A and B give all jobs at once. Sessions do not work that way: they start test runs at random times, so a short run can wait behind a long one. Test 1 measures that wait.

**Method.**

- Each repetition sends a seeded Poisson stream of jobs, for 6 minutes with a mean gap of 36 s, through the real `fleet-lane.sh`, with its FIFO queue, `taskset`, and environment. The jobs use a private state directory, and the benchmark holds the real lanes.
- Every layout gets the same schedule in a repetition. The 3 repetitions had 14, 7, and 12 jobs, with the mix DV×3, SV×2, SG×2, DB×1, and MP×1.
- The layouts are 3×5 (today), 2×7, and 4×4, in interleaved order.
- The DV suite leaves out `model-intelligence-adapter-claude.test.mjs`. That test fails about half the time under load (fixed later on main in #435), and a random failure would count against one layout.

**Load control (added after an invalid first attempt).** The first attempt, on 2026-09-27 05:49, was stopped after 2 of 9 runs. Other sessions ran Docker, compiles, and eslint outside the lanes, the load reached 45, and the same jobs ran 4–5 times slower in one layout. Its data is in `results/arrivals-invalid/`, and nothing here uses it. The second attempt adds these controls:

- The run is a systemd user scope, and foreign CPU is the busy time in `/proc/stat` minus the scope's `cpu.stat` usage.
- A run starts only when foreign CPU stays at or below 6% (about the 1 free CPU) for 30 s. There is no "start anyway".
- A self-check runs before any data. 3 busy CPUs in another scope must read as foreign, and inside the benchmark's own scope they must not.
- A run with 60 s above 12% foreign load (about 2 CPUs) is repeated once. A second failure drops the repetition for all layouts.

**Run.** It ran on 2026-09-28 from 21:53 to 00:13. The gate waited 11 minutes, until 2 busy squadranks sessions went quiet.

- The meter check passed: a base of 2.9%, +20.1% for 3 CPUs outside (18.7% expected), and +5.3% for 3 CPUs inside (limit 6.2%).
- All 9 runs were clean on the first attempt. Foreign load averaged 2.5–4.2%, and the most time any run spent above the trip level was 22 s.

| Layout      | Jobs | Mean turnaround s | p95 turnaround s | p50 wait s | p95 wait s | Short-job (DV, SG) p95 s | Failures | `node -e 0` p95 ms |
| ----------- | ---- | ----------------- | ---------------- | ---------- | ---------- | ------------------------ | -------- | ------------------ |
| 2×7         | 33   | 374.3             | 634.9            | 206.2      | 546.9      | 614.5                    | 1        | 140                |
| 3×5 (today) | 33   | 399.8             | 717.6            | 88.8       | 530.9      | 629.7                    | 1        | 137                |
| 4×4         | 33   | 410.4             | 726.8            | 4.8        | 457.6      | 582.9                    | 0        | 127                |

2×7 has the lowest mean turnaround in every repetition: 484, 140, and 382 s, against 511, 158, and 410 s for 3×5. With 2 lanes, jobs wait longer for a lane (p50 206 s against 89 s), but each job finishes sooner, so the total time is lower.

The failures:

- **2×7:** SV `e2e-seed-residue.test.mjs (live)`, a live check against the repository. It also failed with no other job running in phase B.
- **3×5:** DB `forwards TERM to the command and exits with its status`, a timing-sensitive signal test.

### Test 1 decision (rule locked before the run)

A layout replaces 3×5 only if all of these are true:

- its mean turnaround is at least 5% lower
- its short-job p95 is no more than 20% worse
- it has no more failures
- its `node -e 0` p95 is no more than 1.5×

**2×7 passes all four:** 6.4% lower mean turnaround, a better short-job p95, 1 failure against 1, and 140 ms against 137 ms. 4×4 does not pass. On this machine, the data supports 7 CPUs per lane: `k = (usable + 3) / 7`, which gives lanes 0-6 and 7-14.

The margin (6.4%) is just above the 5% limit, and only a 16-CPU machine was measured. With `W = 7`, a 10-CPU machine would get 1 lane of 9, and that is not measured. So a formula change needs its own decision, and it may need a floor of 2 lanes.

Reproduce: `BENCH_OUT=$PWD/results/arrivals BENCH_REPS_C=3 systemd-run --user --scope --unit=lane-bench-launch-$(date +%s) -- setsid nohup bash bench.sh launch-c 23:00 &`, then `node analyze.mjs results/arrivals`.

## Night test 2: lending, and 4 layouts (2026-09-30)

**Question.** Does lane lending pay off, and does 2×7 still win when 4×4 is compared too? This test ran before scoped attests existed, so it uses the same full-suite job mix and the same arrival schedules as test 1.

**Method.** The method is the same as test 1, with four layouts: 3×5, 2×7, 4×4, and 4×4 with `DOTBABEL_FLEET_LEND=2` (#441). Lending never takes the last free lane, and it never lends while another command waits. Each layout had 3 repetitions. The locked rule was the same as test 1, and the PR (#441) and the schedule message stated it before the run.

**Run.** It ran on 2026-09-30 from 23:01 to 04:18. The meter check passed: a base of 1.7%, +19.4% for 3 CPUs outside (18.7% expected), and +0.9% inside.

- Foreign load was higher than in test 1: 5.0–5.8% on average, against 2.5–4.2%. Every run took about 60% longer than in test 1.
- Two runs were contaminated (4×4 and 4×4-lend in repetition 1). Both were clean when repeated.
- The 04:00 cutoff stopped the test before 4×4 ran in repetition 3. So the paired analysis uses repetitions 1 and 2 only. The partial repetition 3 is shown below, but it is not part of the decision.

| Layout       | Jobs | Mean turnaround s | p95 turnaround s | p50 wait s | Short-job p95 s | Failures | `node -e 0` p95 ms |
| ------------ | ---- | ----------------- | ---------------- | ---------- | --------------- | -------- | ------------------ |
| 2×7          | 21   | 497.0             | 835.9            | 268.2      | 807.1           | 1        | 178                |
| 3×5 (today)  | 21   | 648.8             | 1155.6           | 103.0      | 1024.1          | 0        | 183                |
| 4×4          | 21   | 686.6             | 1090.2           | 31.0       | 1033.6          | 1        | 153                |
| 4×4 + lend 2 | 21   | 692.6             | 1183.3           | 146.4      | 1010.5          | 0        | 160                |

Mean turnaround for each repetition, in seconds:

| Layout       | Repetition 1 | Repetition 2 | Repetition 3 (partial, not used) |
| ------------ | ------------ | ------------ | -------------------------------- |
| 2×7          | 600          | 290          | 677                              |
| 3×5          | 812          | 321          | 771                              |
| 4×4          | 849          | 359          | not run                          |
| 4×4 + lend 2 | 869          | 337          | 720                              |

The failures were all timing-sensitive tests:

- **2×7:** moneyballer `test_circuit_breaker.py:114`.
- **4×4:** squadranks vitest `check-betting-vocabulary.test.mjs` timed out at 15 s.
- **4×4, contaminated attempt (not used):** squadranks Go `TestStripOperators_LongInputIsLinear`.

**Result under the locked rule: 3×5 stays.** 2×7 had 23% lower mean turnaround and a better short-job p95, but it had 1 failure against 0 for 3×5. The rule allows no more failures. Lending gave no gain under this load: 693 s with lending against 687 s for plain 4×4.

**The user's decision (2026-10-02).** The user chose 2×7 as the new default on the evidence of both nights. 2×7 had the lowest mean turnaround in all 5 complete paired repetitions: 6.4% lower in test 1 and 23% lower here. The benchmark rule did not select 2×7 in this test; the change is the user's decision. The user also asked for session-aware lending, so that a session that runs alone can use more than one lane.
