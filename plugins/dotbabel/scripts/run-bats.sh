#!/usr/bin/env bash
# run-bats.sh — run the bats suite, in parallel when a backend is available.
#
# Usage:
#   run-bats.sh [target ...]
#
# Defaults to plugins/dotbabel/tests/bats/ when no target is given.
#
# bats parallelises only with GNU parallel or shenwei356/rush installed; with
# neither it errors out rather than falling back. This wrapper picks whichever
# is present and runs serially when none is, so the same command works on a
# developer machine, in CI, and in the local-attest matrix.
#
# Job count comes from BATS_JOBS, else the core count capped at 8 — past that
# the suite is bound by process startup rather than CPU.
#
# Measured on a 16-core WSL2 host, alternating runs in one window: ~125s
# serial, ~56s at -j 8. Measure in pairs like that if you re-benchmark — this
# host drifts about 2x between windows, enough to invent a speedup on its own.

set -euo pipefail

targets=("$@")
if [ ${#targets[@]} -eq 0 ]; then
  targets=("plugins/dotbabel/tests/bats/")
fi

jobs="${BATS_JOBS:-}"
if [ -z "$jobs" ]; then
  cores="$(getconf _NPROCESSORS_ONLN 2>/dev/null || echo 1)"
  jobs=$((cores > 8 ? 8 : cores))
fi

if [ "$jobs" -le 1 ]; then
  exec npx bats "${targets[@]}"
fi

if command -v parallel >/dev/null 2>&1; then
  exec npx bats -j "$jobs" "${targets[@]}"
fi

if command -v rush >/dev/null 2>&1; then
  exec npx bats -j "$jobs" --parallel-binary-name rush "${targets[@]}"
fi

echo "run-bats.sh: no GNU parallel or rush on PATH — running serially." >&2
exec npx bats "${targets[@]}"
