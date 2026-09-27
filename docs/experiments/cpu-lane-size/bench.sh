#!/usr/bin/env bash
# Benchmark the CPU lane size of `dotbabel fleet`: which CPUs-per-lane finishes
# the most test runs per hour on this machine, with no failures from load and a
# responsive host. See ../2026-09-27-cpu-lane-size.md for the method.
#
#   bench.sh setup      create the bench slots (detached worktrees of each repo)
#   bench.sh pilot      each suite at 5 and 15 CPUs, and 2 concurrent DV runs
#   bench.sh full       phase A (scaling) and phase B (fleet throughput)
#   bench.sh phase-a | phase-b
#   bench.sh teardown   remove the bench slots
#   bench.sh stop       end a detached run and every test it started
#
# While it runs, it holds every CPU lane of the fleet (queue.lock and each
# lane-N.lock), so other sessions' heavy test runs wait in the normal queue.
#
# Settings (environment):
#   BENCH_PROJECTS  parent of the repos      (default ~/projects/kaiohenricunha)
#   BENCH_OUT       JSONL results directory  (default ./results next to this file)
#   BENCH_LOGS      full test logs           (default /tmp/lane-bench-logs)
#   BENCH_NS        phase A CPU counts       (default "2 3 4 5 6 8 10 15")
#   BENCH_REPS_A    phase A repetitions      (default 3)
#   BENCH_REPS_B    phase B repetitions      (default 2)
#   BENCH_SEED      shuffle seed             (default 20260927)

set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECTS="${BENCH_PROJECTS:-$HOME/projects/kaiohenricunha}"
OUT="${BENCH_OUT:-$HERE/results}"
LOGS="${BENCH_LOGS:-/tmp/lane-bench-logs}"
NS="${BENCH_NS:-2 3 4 5 6 8 10 15}"
REPS_A="${BENCH_REPS_A:-3}"
REPS_B="${BENCH_REPS_B:-2}"
SEED="${BENCH_SEED:-20260927}"
LANES_DIR="${DOTBABEL_FLEET_STATE_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/dotbabel/fleet}/lanes"
FLEET_LANE="$PROJECTS/dotbabel/plugins/dotbabel/scripts/fleet-lane.sh"
DRIFT_CPU=15
IDLE_MAX_BUSY=10    # percent of all CPUs busy before a trial may start
IDLE_WAIT_S=600

SUITES=(DV DB SV SG MP)
declare -A REPO=([DV]=dotbabel [DB]=dotbabel [DBJ]=dotbabel [SV]=squadranks [SG]=squadranks [MP]=moneyballer)
# Phase B layouts: name → CPU lists joined by ";" ("unlaned": no pinning, 5 at once).
LAYOUT_NAMES=(5x3 4x4 3x5 2x7 1x15 unlaned)
declare -A LAYOUT=(
  [5x3]="0-2;3-5;6-8;9-11;12-14"
  [4x4]="0-3;4-7;8-11;12-14"
  [3x5]="0-4;5-9;10-14"
  [2x7]="0-7;8-14"
  [1x15]="0-14"
  [unlaned]="-;-;-;-;-"
)

mkdir -p "$OUT" "$LOGS"
TRIALS="$OUT/trials.jsonl"
PROBE="$OUT/probe.jsonl"
CURRENT="$OUT/.current"

log() { printf '%s %s\n' "$(date +%H:%M:%S)" "$*" >&2; }
now_ms() { date +%s%3N; }

sha_of() { git -C "$PROJECTS/$1" rev-parse origin/main; }
slot_dir() { # <suite> <n>
  local s="${1,,}"
  [ "$1" = DBJ ] && s=db
  echo "$PROJECTS/${REPO[$1]}/.claude/worktrees/bench-lanes-$s$2"
}

# ------------------------------------------------------------- slots ----

setup_slots() {
  local suite n dir repo main
  for suite in "${SUITES[@]}"; do
    repo=${REPO[$suite]}
    main="$PROJECTS/$repo"
    for n in 1 2; do
      dir=$(slot_dir "$suite" "$n")
      if [ ! -d "$dir" ]; then
        git -C "$main" worktree add -q --detach "$dir" "$(sha_of "$repo")" || return 1
      fi
      if [ -d "$main/node_modules" ] && [ ! -d "$dir/node_modules" ] && [ "$suite" != SG ] && [ "$suite" != MP ]; then
        # Hardlinks: no extra disk. Caches stay out, so no run writes into a shared file.
        cp -al "$main/node_modules" "$dir/node_modules" || return 1
        rm -rf "$dir/node_modules/.vite" "$dir/node_modules/.cache"
      fi
      log "slot $suite$n: $dir @ $(git -C "$dir" rev-parse --short HEAD)"
    done
  done
}

teardown_slots() {
  local suite n dir
  for suite in "${SUITES[@]}"; do
    for n in 1 2; do
      dir=$(slot_dir "$suite" "$n")
      [ -d "$dir" ] || continue
      # Bench slots are disposable: only test output and hardlinked deps live there.
      git -C "$PROJECTS/${REPO[$suite]}" worktree remove --force "$dir" && log "removed $dir"
    done
    git -C "$PROJECTS/${REPO[$suite]}" worktree prune
  done
}

# ------------------------------------------------------------- lanes ----

HOLDERS=()
LOCK_FDS=()
reserve_lanes() {
  local count i fd
  count=$(bash "$FLEET_LANE" --layout 2>/dev/null | grep -c '^lane ')
  [ "$count" -gt 0 ] || count=3
  mkdir -p "$LANES_DIR"
  exec {QUEUE_FD}>>"$LANES_DIR/queue.lock"
  LOCK_FDS+=("$QUEUE_FD")
  log "waiting for the lane queue"
  flock "$QUEUE_FD"
  for ((i = 1; i <= count; i++)); do
    exec {fd}>>"$LANES_DIR/lane-$i.lock"
    LOCK_FDS+=("$fd")
    log "waiting for lane $i"
    flock "$fd"
    printf 'pid=%s\nprocstart=%s\nlabel=lane benchmark\nsession=benchmark\ncwd=%s\nstarted=%s\nlane=%s\ncpus=bench\n' \
      "$$" "$(awk '{ sub(/.*\) /, ""); print $20 }' /proc/$$/stat)" "$HERE" "$(date +%s)" "$i" >"$LANES_DIR/lane-$i.holder"
    HOLDERS+=("$LANES_DIR/lane-$i.holder")
  done
  log "holding $count lanes"
}

release_lanes() {
  rm -f "${HOLDERS[@]}" "$CURRENT"
  [ -n "${PROBE_PID:-}" ] && kill "$PROBE_PID" 2>/dev/null
  return 0
}

# ------------------------------------------------------------ probes ----

cpu_busy_pct() { # busy share of all CPUs over 2 s, from /proc/stat
  local a b
  read -r -a a < <(head -1 /proc/stat)
  sleep 2
  read -r -a b < <(head -1 /proc/stat)
  local idle=$(((b[4] + b[5]) - (a[4] + a[5]))) total=0 i
  for ((i = 1; i < ${#a[@]}; i++)); do total=$((total + b[i] - a[i])); done
  [ "$total" -gt 0 ] || { echo 0; return; }
  echo $((100 * (total - idle) / total))
}

wait_idle() {
  local start=$SECONDS busy
  while :; do
    busy=$(cpu_busy_pct)
    [ "$busy" -lt "$IDLE_MAX_BUSY" ] && break
    if ((SECONDS - start > IDLE_WAIT_S)); then
      log "host still ${busy}% busy after ${IDLE_WAIT_S}s; starting anyway"
      break
    fi
  done
  IDLE_WAITED=$((SECONDS - start))
  IDLE_BUSY=$busy
}

# Fixed single-thread work on the reserved CPU: its time tracks host speed.
drift_ms() {
  taskset -c "$DRIFT_CPU" node -e 'const t=process.hrtime.bigint();let x=0;for(let i=0;i<2.3e8;i++)x+=i;if(x<0)console.log(x);console.log(Number((process.hrtime.bigint()-t)/1000000n))'
}

start_probe() {
  (
    local t0 t1 t2 load psi
    while :; do
      t0=$(date +%s%N)
      node -e 0
      t1=$(date +%s%N)
      bash -c :
      t2=$(date +%s%N)
      read -r load _ </proc/loadavg
      psi=$(awk '/^some/{split($2,a,"=");split($5,b,"=");print a[2]" "b[2]}' /proc/pressure/cpu)
      printf '{"t":%s,"trial":"%s","load1":%s,"psi_avg10":%s,"psi_total":%s,"node_ms":%s,"bash_ms":%s}\n' \
        "$((t0 / 1000000))" "$(cat "$CURRENT" 2>/dev/null)" "$load" "${psi% *}" "${psi#* }" \
        "$(((t1 - t0) / 1000000))" "$(((t2 - t1) / 1000000))" >>"$PROBE"
      sleep 1
    done
  ) &
  PROBE_PID=$!
}

# ------------------------------------------------------------- suites ----

suite_cmd() { # <suite>
  case "$1" in
    DV | SV) echo "npx vitest run" ;;
    DB | DBJ) echo "bash plugins/dotbabel/scripts/run-bats.sh" ;;
    SG) echo "cd api && go test ./... -race -count=1" ;;
    MP) echo "$PROJECTS/moneyballer/.venv/bin/pytest elt/tests/ -q -m 'not real_api' --timeout=120 -n auto -p no:cacheprovider" ;;
  esac
}

failures_of() { # <suite> <log>
  local n
  case "$1" in
    DV | SV) n=$(grep -aoE 'Tests +[0-9]+ failed' "$2" | grep -oE '[0-9]+' | tail -1) ;;
    DB | DBJ) n=$(grep -ac '^not ok' "$2") ;;
    SG) n=$(grep -acE '^\s*--- FAIL' "$2") ;;
    MP) n=$(grep -aoE '[0-9]+ failed' "$2" | grep -oE '[0-9]+' | tail -1) ;;
  esac
  echo "${n:-0}"
}

timeouts_of() { grep -acE 'Test timed out|Timeout >|panic: test timed out|Failed: Timeout' "$1"; }

# run_job <phase> <layout> <lane> <cpus|-> <suite> <rep> <slot> <queue_pos> <drift>
run_job() {
  local phase=$1 layout=$2 lane=$3 cpus=$4 suite=$5 rep=$6 slot=$7 pos=$8 drift=$9
  local dir id logf tfile start end rc width=0 part
  dir=$(slot_dir "$suite" "$slot")
  id="$phase-$layout-r$rep-$suite-q$pos-$(now_ms)"
  logf="$LOGS/$id.log"
  tfile="$LOGS/$id.time"
  local -a pin=() envs=()
  if [ "$cpus" != - ]; then
    for part in ${cpus//,/ }; do
      if [[ $part == *-* ]]; then width=$((width + ${part#*-} - ${part%-*} + 1)); else width=$((width + 1)); fi
    done
    pin=(taskset -c "$cpus")
    envs=(DOTBABEL_LANE=bench "DOTBABEL_LANE_CPUS=$cpus" "PYTEST_XDIST_AUTO_NUM_WORKERS=$width")
    [ "$suite" = DBJ ] && envs+=("BATS_JOBS=$width")
  fi
  start=$(now_ms)
  # The test run must not inherit the lane locks: they belong to this script.
  (for fd in "${LOCK_FDS[@]}"; do eval "exec $fd>&-"; done
    cd "$dir" && env "${envs[@]}" "${pin[@]}" /usr/bin/time -o "$tfile" -f '%e %U %S %M' bash -c "$(suite_cmd "$suite")") >"$logf" 2>&1
  rc=$?
  end=$(now_ms)
  local wall user sys rss
  # A failed run's time file starts with a status line; the numbers are last.
  read -r wall user sys rss < <(tail -1 "$tfile" 2>/dev/null) || true
  jq -cn --arg phase "$phase" --arg layout "$layout" --argjson lane "$lane" --arg cpus "$cpus" \
    --argjson width "$width" --arg suite "$suite" --argjson rep "$rep" --argjson slot "$slot" \
    --argjson pos "$pos" --argjson start "$start" --argjson end "$end" --argjson rc "$rc" \
    --argjson wall "${wall:-null}" --argjson user "${user:-null}" --argjson sys "${sys:-null}" \
    --argjson rss "${rss:-null}" --argjson failures "$(failures_of "$suite" "$logf")" \
    --argjson timeouts "$(timeouts_of "$logf")" --argjson drift "${drift:-null}" \
    --argjson idle_busy "${IDLE_BUSY:-null}" --argjson idle_waited "${IDLE_WAITED:-null}" \
    --arg sha "$(git -C "$dir" rev-parse --short HEAD)" --arg log "$logf" \
    '{phase:$phase,layout:$layout,lane:$lane,cpus:$cpus,width:$width,suite:$suite,rep:$rep,slot:$slot,
      pos:$pos,start:$start,end:$end,exit:$rc,wall:$wall,user:$user,sys:$sys,maxrss_kb:$rss,
      failures:$failures,timeouts:$timeouts,drift_ms:$drift,idle_busy:$idle_busy,
      idle_waited_s:$idle_waited,sha:$sha,log:$log}' >>"$TRIALS"
  log "$id exit=$rc wall=${wall:-?}s failures=$(failures_of "$suite" "$logf")"
}

# Deterministic shuffle of stdin lines.
shuffle() { awk -v seed="$1" 'BEGIN{srand(seed)} {print rand() "\t" $0}' | sort -k1,1 | cut -f2-; }

# A trial starts on an idle host, after a drift sample.
prepare() {
  wait_idle
  DRIFT=$(drift_ms)
}

# ------------------------------------------------------------- phases ----

phase_a() {
  local rep suite n
  for ((rep = 1; rep <= REPS_A; rep++)); do
    while read -r suite n; do
      prepare
      echo "A-$suite-$n-r$rep" >"$CURRENT"
      run_job A "solo" 1 "0-$((n - 1))" "$suite" "$rep" 1 0 "$DRIFT"
      : >"$CURRENT"
    done < <(for suite in "${SUITES[@]}" DBJ; do for n in $NS; do echo "$suite $n"; done; done | shuffle "$((SEED + rep))")
  done
}

# One layout run: every lane pulls the next job from one shared queue.
run_layout() { # <layout> <rep>
  local layout=$1 rep=$2 queue counter lanes i
  queue="$LOGS/queue-$layout-r$rep"
  counter="$queue.next"
  printf '%s\n' DV DV DB DB SV SV SG SG MP MP | shuffle "$SEED" >"$queue"
  echo 0 >"$counter"
  IFS=';' read -r -a lanes <<<"${LAYOUT[$layout]}"
  echo "B-$layout-r$rep" >"$CURRENT"
  local t0
  t0=$(now_ms)
  local -a workers=()
  for ((i = 0; i < ${#lanes[@]}; i++)); do
    (
      local pos suite slot
      while :; do
        pos=$(flock "$counter" bash -c 'n=$(cat "$1"); echo $((n + 1)) >"$1"; echo "$n"' _ "$counter")
        suite=$(sed -n "$((pos + 1))p" "$queue")
        [ -n "$suite" ] || break
        # The first job of a suite runs in slot 1, the second in slot 2.
        slot=$(head -n "$((pos + 1))" "$queue" | grep -cx "$suite")
        run_job B "$layout" "$((i + 1))" "${lanes[$i]}" "$suite" "$rep" "$slot" "$pos" "$DRIFT"
      done
    ) &
    workers+=("$!")
  done
  wait "${workers[@]}"
  jq -cn --arg layout "$layout" --argjson rep "$rep" --argjson t0 "$t0" --argjson t1 "$(now_ms)" \
    '{phase:"B-layout",layout:$layout,rep:$rep,start:$t0,end:$t1}' >>"$TRIALS"
  : >"$CURRENT"
  log "layout $layout r$rep done in $((($(now_ms) - t0) / 1000))s"
}

phase_b() {
  local rep layout
  for ((rep = 1; rep <= REPS_B; rep++)); do
    while read -r layout; do
      prepare
      run_layout "$layout" "$rep"
    done < <(printf '%s\n' "${LAYOUT_NAMES[@]}" | shuffle "$((SEED + 100 + rep))")
  done
}

pilot() {
  local suite
  for suite in "${SUITES[@]}"; do
    prepare
    echo "P-$suite-5" >"$CURRENT"
    run_job P solo 1 0-4 "$suite" 1 1 0 "$DRIFT"
    prepare
    echo "P-$suite-15" >"$CURRENT"
    run_job P solo 1 0-14 "$suite" 1 1 0 "$DRIFT"
  done
  prepare
  echo "P-DV-concurrent" >"$CURRENT"
  run_job P pair 1 0-4 DV 1 1 0 "$DRIFT" &
  local first=$!
  run_job P pair 2 5-9 DV 1 2 1 "$DRIFT" &
  wait "$first" "$!"
  : >"$CURRENT"
}

# --------------------------------------------------------------- main ----

main() {
  local cmd="${1:-}"
  case "$cmd" in
    setup) setup_slots ;;
    teardown) teardown_slots ;;
    stop)
      # The run is a process-group leader (setsid): end it and every test it started.
      local pid
      pid=$(cat "$OUT/bench.pid" 2>/dev/null) && kill -TERM -- "-$(ps -o pgid= -p "$pid" | tr -d ' ')"
      ;;
    pilot | full | phase-a | phase-b)
      echo "$$" >"$OUT/bench.pid"
      trap 'release_lanes' EXIT
      trap 'exit 130' INT TERM HUP
      setup_slots || exit 2
      reserve_lanes
      start_probe
      # A quiet minute first: the responsiveness baseline for the decision rule.
      echo IDLE >"$CURRENT"
      sleep 60
      : >"$CURRENT"
      jq -cn --arg cmd "$cmd" --argjson t "$(now_ms)" --arg host "$(uname -r)" \
        --arg cpu "$(lscpu | sed -n 's/^Model name: *//p')" --arg ns "$NS" \
        --argjson ra "$REPS_A" --argjson rb "$REPS_B" --argjson seed "$SEED" \
        '{phase:"meta",cmd:$cmd,start:$t,kernel:$host,cpu:$cpu,ns:$ns,reps_a:$ra,reps_b:$rb,seed:$seed}' >>"$TRIALS"
      case "$cmd" in
        pilot) pilot ;;
        full) phase_a && phase_b ;;
        phase-a) phase_a ;;
        phase-b) phase_b ;;
      esac
      log "$cmd done"
      ;;
    *)
      sed -n '2,12p' "${BASH_SOURCE[0]}"
      exit 64
      ;;
  esac
}

main "$@"
