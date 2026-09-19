# Landing-flow timing

Measured 2026-09-19 on the machine this repository is developed on (WSL2, 16 cores, Node 22.22.2),
after P-G1 and P-G2 shipped. The point is to replace two claims that had been made without
measurement: that `/merge-pr` "spent several more minutes" re-running validation, and that
attesting once and reusing the evidence made the landing flow meaningfully faster.

## Method

- **Historical matrix timings.** Every `local-attest` comment on the last 60 merged pull requests,
  parsed for per-leg durations: 35 runs before the `quality` leg existed, 3 after.
- **Controlled per-step timings.** A fresh detached worktree at `origin/main`, each step run 3
  times sequentially, medians reported. `quality` was run against the diff of #401 (base
  `9fab044`), which touches `plugins/dotbabel/src/**` and `bin/**` — both `critical_paths`.
- **Reuse.** `quality check --profile pr` with and without `--reuse`, interleaved in the same
  window, with the run manifest re-recorded before each reusing run exactly as a real `test` leg
  would have just done.

Load was **not** controlled. Two blocks of the same command differed by up to ~50%
(`npm test`: 9.3–13.5s, then 14.5–16.4s), and the reuse block ran at a load average of 12–18 on 16
cores because an unrelated project was running `pytest-xdist`. Ratios and differences are
therefore more trustworthy than absolute times.

## Results

### Matrix legs (medians, seconds)

| Leg                      | Before the quality leg (n=35) | After (n=3) |
| ------------------------ | ----------------------------- | ----------- |
| lint                     | 16                            | 20          |
| test                     | 18                            | 20          |
| bats                     | 150 (range 59–388)            | 99          |
| quality                  | —                             | 50          |
| dogfood                  | 6                             | 8           |
| **total excluding bats** | **42**                        | **108**     |

`bats` is common to every version of the flow and has the widest variance, so comparisons below
exclude it. Three post-change samples is a small n and is stated as such.

### Steps of the old `merge-pr`, taken literally

| Step                                   | Seconds          |
| -------------------------------------- | ---------------- |
| `git worktree add`                     | 0.1              |
| `npm ci` (warm cache)                  | 3.1              |
| `npm test`                             | 10.3             |
| `dotbabel quality check --profile pr`  | 52.9 (42.0–58.2) |
| two `pr-stack gate --gate merge` calls | ~4               |
| **total**                              | **~72**          |

The new `merge-pr` on an attested pull request is the two gate calls: **~4s**.

### Inside the `pr` quality profile

| Tool                                         | Seconds |
| -------------------------------------------- | ------- |
| `npm run lint`                               | 18.5    |
| `npm test`                                   | 15.7    |
| `npm run coverage` (`vitest run --coverage`) | 15.9    |
| compile checks and static rules              | ~3      |

`npm test -- --coverage`, which the matrix's `test` leg runs, is the same command as
`npm run coverage`. So of a 53s `quality` leg, about **50s repeated work the `lint` and `test`
legs had just done**.

### Conductor `pre-pr` narrowing

`--profile fast` 34.2s against `--profile pr` 52.9s: **19s saved**, not the whole `pr` profile,
because this repository's `critical_paths` escalate the test plan into `fast` (REL-12). A diff
touching no critical path would save more.

### Reuse (`quality check --reuse`), same diff, interleaved

|       | Without reuse | With reuse |
| ----- | ------------- | ---------- |
| Run 1 | 96.0s         | 1.1s       |
| Run 2 | 97.0s         | 0.9s       |
| Run 3 | 92.3s         | 0.8s       |

Rule verdicts were **identical in 3 of 3 pairs**: reuse changes who computes an answer, not the
answer. (Under load, unloaded the same leg is ~53s.)

A first attempt at this measurement produced 39.5s rather than ~1s. That was correct behaviour,
not a defect: the no-reuse runs interleaved with it had rewritten `coverage/lcov.info`, so the
recorded hash no longer matched and the reader refused with `REPORT_CHANGED` and ran coverage
itself.

## Per pull request, excluding the review fleet and bats

|                  | Old      | As shipped in P-G1/P-G2 | With reuse (P-G4)   |
| ---------------- | -------- | ----------------------- | ------------------- |
| `pre-pr` quality | 52.9     | 34.2                    | 34.2                |
| attest matrix    | 42       | 42 + 52.9               | 42 + ~1             |
| `merge-pr`       | ~72      | ~4                      | ~4                  |
| **total**        | **~167** | **~133 (−34s, 20%)**    | **~81 (−86s, 51%)** |

## What this does and does not show

- The literal `merge-pr` text costs ~72s, **not** "several minutes". That figure only reproduces
  if the agent also ran `bats` and `validate-settings` at merge time (`bats` median 150s, up to
  388s), which "run the full project test suite" invites. Which of those the Model Intelligence
  runs actually did is not recoverable from here.
- P-G1 and P-G2 as shipped saved about 34s per pull request. The `quality` leg then took back ~53s
  of it by repeating work already done, which is what P-G4 removes.
- Dependency installation, called out earlier as a defect of the old `merge-pr`, costs 3s with a
  warm cache. It was a correctness gap (the step was missing), not a time cost.
- Review-fleet time is excluded and unchanged; on a protected-path pull request it is minutes and
  dominates the conductor.

## Found while measuring

`dotbabel quality check --json` **piped** truncates at ~64 KiB (65,727 of 224,778 bytes) and exits
2; redirected to a file it is complete and exits 0. CI redirects, so it never surfaced. Not fixed
here.
