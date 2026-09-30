#!/usr/bin/env bash
# Benchmark the CPU lane size of `dotbabel fleet`: which CPUs-per-lane finishes
# the most test runs per hour on this machine, with no failures from load and a
# responsive host. See ../2026-09-27-cpu-lane-size.md for the method.
#
#   bench.sh setup      create the bench slots (detached worktrees of each repo)
#   bench.sh pilot      each suite at 5 and 15 CPUs, and 2 concurrent DV runs
#   bench.sh full       phase A (scaling) and phase B (fleet throughput)
#   bench.sh phase-a | phase-b
#   bench.sh phase-c    jobs arrive over time and queue for lanes (test 1)
#   bench.sh launch-c [HH:MM]  wait until HH:MM, then run phase-c in its own
#                       systemd user scope (phase C refuses to run outside one)
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
#   BENCH_REPS_C    phase C repetitions      (default 3)
#   BENCH_ARRIVAL_WINDOW_S / BENCH_ARRIVAL_MEAN_S  phase C arrivals (default 360 / 36)
#   BENCH_GATE_PCT / BENCH_TRIP_PCT  foreign CPU, % of all CPUs (default 6 / 12)
#   BENCH_TRIP_SAMPLES  seconds above the trip level that spoil a run (default 60)
#   BENCH_LAYOUTS_C / BENCH_MIX_C   phase C layouts and job mix (smoke tests)
#   BENCH_START_BY / BENCH_CUTOFF   launch-c: latest start, and no new run after (default 02:00 / 04:00)

set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECTS="${BENCH_PROJECTS:-$HOME/projects/kaiohenricunha}"
OUT="${BENCH_OUT:-$HERE/results}"
LOGS="${BENCH_LOGS:-/tmp/lane-bench-logs}"
NS="${BENCH_NS:-2 3 4 5 6 8 10 15}"
REPS_A="${BENCH_REPS_A:-3}"
REPS_B="${BENCH_REPS_B:-2}"
SEED="${BENCH_SEED:-20260927}"
REPS_C="${BENCH_REPS_C:-3}"
ARRIVAL_WINDOW_S="${BENCH_ARRIVAL_WINDOW_S:-360}"
ARRIVAL_MEAN_S="${BENCH_ARRIVAL_MEAN_S:-36}"
SLOTS="${BENCH_SLOTS:-2}"
# Foreign load: CPU used outside the benchmark's own cgroup. The layouts use
# CPUs 0-14 and keep CPU 15 free, so about 1 CPU of foreign load (6% of 16)
# fits on the free CPU; about 2 CPUs (12%) take time from the lanes.
GATE_PCT="${BENCH_GATE_PCT:-6}"
TRIP_PCT="${BENCH_TRIP_PCT:-12}"
TRIP_SAMPLES="${BENCH_TRIP_SAMPLES:-60}"
GATE_WINDOW_S="${BENCH_GATE_WINDOW_S:-30}"
GATE_WAIT_START_S="${BENCH_GATE_WAIT_START_S:-10800}"
GATE_WAIT_S="${BENCH_GATE_WAIT_S:-1800}"
MAX_REPS_C="${BENCH_MAX_REPS_C:-$((REPS_C + 2))}"
CLK_TCK=$(getconf CLK_TCK)
NCPU=$(getconf _NPROCESSORS_ONLN)
CGROUP_DIR=""
START_BY_EPOCH="${BENCH_START_BY_EPOCH:-0}"
CUTOFF_EPOCH="${BENCH_CUTOFF_EPOCH:-0}"
SELF="$HERE/bench.sh"
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
# Phase C: the layouts to compare, and the job mix (a pick is uniform over this list).
read -r -a LAYOUTS_C <<<"${BENCH_LAYOUTS_C:-3x5 2x7 4x4}"
MIX_C="${BENCH_MIX_C:-DV DV DV SV SV SG SG DB MP}"

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
    for ((n = 1; n <= SLOTS; n++)); do
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
    for n in 1 2 3 4 5 6; do
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

# The benchmark's own cgroup: a systemd user scope named lane-bench*.scope.
# Its cpu.stat counts every process of the run, also the ones that exited.
find_cgroup() {
  local cg
  cg=$(sed -n 's/^0:://p' /proc/self/cgroup)
  [[ ${cg##*/} == lane-bench*.scope ]] || return 1
  CGROUP_DIR="/sys/fs/cgroup$cg"
  [ -r "$CGROUP_DIR/cpu.stat" ]
}

# "<busy jiffies> <steal jiffies> <benchmark usage usec> <now usec>"
cpu_snap() {
  local _cpu user nice system _idle _iowait irq softirq steal _rest usage=0
  read -r _cpu user nice system _idle _iowait irq softirq steal _rest </proc/stat
  [ -n "$CGROUP_DIR" ] && usage=$(awk '/^usage_usec/{print $2}' "$CGROUP_DIR/cpu.stat" 2>/dev/null)
  echo "$((user + nice + system + irq + softirq)) $steal ${usage:-0} $(date +%s%6N)"
}

# CPU used outside the benchmark between two snapshots, and steal, in tenths
# of a percent of all CPUs: "<foreign> <steal>".
foreign_between() {
  local -a a b
  read -r -a a <<<"$1"
  read -r -a b <<<"$2"
  local cap=$((NCPU * (b[3] - a[3])))
  if [ "$cap" -le 0 ]; then
    echo "0 0"
    return
  fi
  local busy=$(((b[0] - a[0]) * 1000000 / CLK_TCK)) own=$((b[2] - a[2]))
  local foreign=$((busy - own))
  [ "$foreign" -gt 0 ] || foreign=0
  echo "$((foreign * 1000 / cap)) $(((b[1] - a[1]) * 1000000 / CLK_TCK * 1000 / cap))"
}

pct() { printf '%d.%d' "$(($1 / 10))" "$(($1 % 10))"; }

# Log what uses the CPU outside the benchmark, for the morning log.
report_foreign() {
  local own=" "
  [ -n "$CGROUP_DIR" ] && own=" $(tr '\n' ' ' <"$CGROUP_DIR/cgroup.procs") "
  top -b -n 2 -d 2 -o %CPU -w 200 |
    awk -v own="$own" '/^top -/{f++} f==2 && $1 ~ /^[0-9]+$/ && $9+0 >= 5 && index(own, " " $1 " ") == 0 {printf "  %s%% %s (pid %s)\n", $9, $12, $1}' |
    head -8 >&2
  timeout 20 docker stats --no-stream --format '  docker {{.Name}} {{.CPUPerc}}' 2>/dev/null | grep -v ' 0.00%' >&2
  return 0
}

# Start only on a quiet host: foreign CPU at or below GATE_PCT for a whole
# window. There is no "start anyway": after max_wait the run stops without data.
gate_quiet() { # <max wait s> <label> [<deadline epoch s>]
  local max=$1 label=$2 deadline=${3:-0} start=$SECONDS a b f st last_report=-300
  while :; do
    if [ "$deadline" -gt 0 ] && [ "$(date +%s)" -ge "$deadline" ]; then
      log "deadline $(date -d "@$deadline" +%H:%M) reached before $label; stopping without data"
      jq -cn --arg label "$label" --argjson t "$(now_ms)" '{phase:"C-abort",label:$label,reason:"deadline",t:$t}' >>"$TRIALS"
      return 1
    fi
    a=$(cpu_snap)
    sleep "$GATE_WINDOW_S"
    b=$(cpu_snap)
    read -r f st <<<"$(foreign_between "$a" "$b")"
    if [ "$f" -le $((GATE_PCT * 10)) ]; then
      log "quiet before $label: foreign $(pct "$f")%, steal $(pct "$st")%"
      return 0
    fi
    if ((SECONDS - last_report >= 300)); then
      log "waiting before $label: foreign $(pct "$f")% > ${GATE_PCT}%"
      report_foreign
      last_report=$SECONDS
    fi
    if ((SECONDS - start >= max)); then
      log "host not quiet before $label after ${max}s; stopping without data"
      report_foreign
      jq -cn --arg label "$label" --argjson foreign "$f" --argjson t "$(now_ms)" \
        '{phase:"C-abort",label:$label,foreign_permille:$foreign,t:$t}' >>"$TRIALS"
      return 1
    fi
  done
}

# Check the meter on the quiet host before any data: 3 busy processes in
# another scope must read as foreign (3 of the CPUs), and the same load in this
# scope must not. The permille thresholds allow for noise.
meter_selfcheck() {
  local a b base ext own st pid expected
  local -a busy=()
  a=$(cpu_snap)
  sleep 5
  b=$(cpu_snap)
  read -r base st <<<"$(foreign_between "$a" "$b")"
  systemd-run --user --scope --quiet --unit="lane-foreign-check-$$" -- \
    bash -c 'for j in 1 2 3; do timeout 5 yes >/dev/null & done; wait' &
  pid=$!
  a=$(cpu_snap)
  sleep 5
  b=$(cpu_snap)
  wait "$pid"
  read -r ext st <<<"$(foreign_between "$a" "$b")"
  for _ in 1 2 3; do
    timeout 5 yes >/dev/null &
    busy+=("$!")
  done
  a=$(cpu_snap)
  sleep 5
  b=$(cpu_snap)
  wait "${busy[@]}"
  read -r own st <<<"$(foreign_between "$a" "$b")"
  expected=$((3 * 1000 / NCPU))
  jq -cn --argjson base "$base" --argjson ext "$ext" --argjson own "$own" --argjson expected "$expected" \
    '{phase:"C-meter",base_permille:$base,outside_permille:$ext,inside_permille:$own,expected_step:$expected}' >>"$TRIALS"
  log "meter check: base $(pct "$base")%, 3 CPUs outside $(pct "$ext")%, 3 CPUs inside $(pct "$own")% (step should be $(pct "$expected")%)"
  ((ext - base >= expected * 2 / 3 && own - base <= expected / 3))
}

start_probe() {
  (
    local t0 t1 t2 load psi prev cur f st
    prev=$(cpu_snap)
    while :; do
      t0=$(date +%s%N)
      node -e 0
      t1=$(date +%s%N)
      bash -c :
      t2=$(date +%s%N)
      read -r load _ </proc/loadavg
      psi=$(awk '/^some/{split($2,a,"=");split($5,b,"=");print a[2]" "b[2]}' /proc/pressure/cpu)
      cur=$(cpu_snap)
      read -r f st <<<"$(foreign_between "$prev" "$cur")"
      prev=$cur
      printf '{"t":%s,"trial":"%s","load1":%s,"psi_avg10":%s,"psi_total":%s,"node_ms":%s,"bash_ms":%s,"foreign_pct":%s,"steal_pct":%s}\n' \
        "$((t0 / 1000000))" "$(cat "$CURRENT" 2>/dev/null)" "$load" "${psi% *}" "${psi#* }" \
        "$(((t1 - t0) / 1000000))" "$(((t2 - t1) / 1000000))" "$(pct "$f")" "$(pct "$st")" >>"$PROBE"
      sleep 1
    done
  ) &
  PROBE_PID=$!
}

# ------------------------------------------------------------- suites ----

suite_cmd() { # <suite>
  case "$1" in
    # One DV test is flaky under CPU load on main (a 20-25 ms budget runs out
    # before its child starts; fix pending on feat/model-intelligence-p08a-models-dev).
    # A random failure would count against one layout, so phase C leaves it out.
    DV) echo "npx vitest run --exclude '**/model-intelligence-adapter-claude.test.mjs'" ;;
    SV) echo "npx vitest run" ;;
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

# ------------------------------------------------------------ phase C ----
#
# Jobs arrive as a seeded Poisson stream and go through the real
# fleet-lane.sh (its FIFO queue, taskset, and env), with a private state
# directory and the layout under test. The arrival schedule of a repetition
# is the same for every layout.

schedule_c() { # <seed> → "<ms offset> <suite>" lines
  awk -v seed="$1" -v mean="$ARRIVAL_MEAN_S" -v win="$ARRIVAL_WINDOW_S" -v mix="$MIX_C" 'BEGIN {
    srand(seed); n = split(mix, m, " "); t = 0
    while (t <= win) {
      printf "%d %s\n", t * 1000, m[int(rand() * n) + 1]
      t += -mean * log(1 - rand())
    }
  }'
}

# Inside the lane: take a free slot of the suite, run it, give the slot back.
lane_job() { # <suite> <id>
  local suite=$1 id=$2 n dir rc
  local locks="$LOGS/slot-locks"
  mkdir -p "$locks"
  local waited=0
  while :; do
    for ((n = 1; n <= SLOTS; n++)); do mkdir "$locks/$suite-$n" 2>/dev/null && break 2; done
    sleep 0.2
    waited=$((waited + 1))
    if [ "$waited" -ge 3000 ]; then # 10 minutes: every slot is stuck, so the job fails instead of holding a lane
      log "$id: no free $suite slot after 600s"
      return 70
    fi
  done
  printf '%s %s %s %s\n' "$(now_ms)" "${DOTBABEL_LANE:-}" "${DOTBABEL_LANE_CPUS:-}" "$n" >"$LOGS/$id.start"
  dir=$(slot_dir "$suite" "$n")
  (cd "$dir" && /usr/bin/time -o "$LOGS/$id.time" -f '%e %U %S %M' bash -c "$(suite_cmd "$suite")") >"$LOGS/$id.log" 2>&1
  rc=$?
  rmdir "$locks/$suite-$n"
  return "$rc"
}

arrival_job() { # <layout> <rep> <attempt> <pos> <suite> <private state dir>
  local layout=$1 rep=$2 attempt=$3 pos=$4 suite=$5 priv=$6 id arrive rc end
  id="C-$layout-r$rep-a$attempt-q$pos-$suite"
  arrive=$(now_ms)
  for fd in "${LOCK_FDS[@]}"; do eval "exec $fd>&-"; done
  env -u DOTBABEL_LANE -u DOTBABEL_LANE_CPUS DOTBABEL_FLEET_STATE_DIR="$priv" \
    DOTBABEL_FLEET_LANES="${LAYOUT[$layout]}" DOTBABEL_LANE_SESSION=bench \
    bash "$FLEET_LANE" --name "$suite" -- bash "$SELF" _lane-job "$suite" "$id" 2>>"$LOGS/$id.queue"
  rc=$?
  end=$(now_ms)
  local start lane cpus slot wall user sys rss
  read -r start lane cpus slot <"$LOGS/$id.start" 2>/dev/null || true
  read -r wall user sys rss < <(tail -1 "$LOGS/$id.time" 2>/dev/null) || true
  jq -cn --arg layout "$layout" --argjson rep "$rep" --argjson attempt "$attempt" --argjson pos "$pos" --arg suite "$suite" \
    --argjson arrive "$arrive" --argjson start "${start:-null}" --argjson end "$end" \
    --argjson lane "${lane:-null}" --arg cpus "${cpus:-}" --argjson slot "${slot:-null}" --argjson rc "$rc" \
    --argjson wall "${wall:-null}" --argjson user "${user:-null}" --argjson sys "${sys:-null}" \
    --argjson rss "${rss:-null}" --argjson failures "$(failures_of "$suite" "$LOGS/$id.log")" \
    --argjson timeouts "$(timeouts_of "$LOGS/$id.log")" --argjson drift "${DRIFT:-null}" \
    '{phase:"C",layout:$layout,rep:$rep,attempt:$attempt,pos:$pos,suite:$suite,arrive:$arrive,start:$start,end:$end,
      lane:$lane,cpus:$cpus,slot:$slot,exit:$rc,wall:$wall,user:$user,sys:$sys,maxrss_kb:$rss,
      failures:$failures,timeouts:$timeouts,drift_ms:$drift}' >>"$TRIALS"
  log "$id wait=$(( (${start:-$end} - arrive) / 1000 ))s exit=$rc wall=${wall:-?}s"
}

run_layout_c() { # <layout> <rep> <attempt>
  local layout=$1 rep=$2 attempt=$3 priv t0 ms suite pos=0 tag
  tag="C-$layout-r$rep-a$attempt"
  priv="$LOGS/state-$tag"
  rm -rf "$priv"
  mkdir -p "$priv"
  local -a jobs_c=()
  echo "$tag" >"$CURRENT"
  t0=$(now_ms)
  while read -r ms suite; do
    local wait_ms=$((t0 + ms - $(now_ms)))
    [ "$wait_ms" -gt 0 ] && sleep "$((wait_ms / 1000)).$(printf '%03d' $((wait_ms % 1000)))"
    arrival_job "$layout" "$rep" "$attempt" "$pos" "$suite" "$priv" &
    jobs_c+=("$!")
    pos=$((pos + 1))
  done < <(schedule_c "$((SEED + 200 + rep))")
  wait "${jobs_c[@]}"
  local t1
  t1=$(now_ms)
  : >"$CURRENT"
  sleep 2 # let the probe write its last sample of this run
  # Foreign load during the run, from the probe's once-per-second samples.
  local foreign
  foreign=$(jq -sc --arg tag "$tag" --argjson trip "$TRIP_PCT" \
    '[.[] | select(.trial == $tag) | .foreign_pct // empty] |
     {samples: length, over_trip_s: (map(select(. > $trip)) | length),
      mean: (if length > 0 then add / length else 0 end), max: (max // 0)}' "$PROBE")
  LAST_CONTAMINATED=false
  [ "$(jq -r .over_trip_s <<<"$foreign")" -ge "$TRIP_SAMPLES" ] && LAST_CONTAMINATED=true
  jq -cn --arg layout "$layout" --argjson rep "$rep" --argjson attempt "$attempt" --argjson t0 "$t0" \
    --argjson t1 "$t1" --argjson n "$pos" --argjson foreign "$foreign" --argjson contaminated "$LAST_CONTAMINATED" \
    --argjson reserved "$RESERVED" \
    '{phase:"C-layout",layout:$layout,rep:$rep,attempt:$attempt,start:$t0,end:$t1,jobs:$n,
      foreign:$foreign,contaminated:$contaminated,lanes_reserved:$reserved}' >>"$TRIALS"
  log "phase C $tag: $pos jobs in $(((t1 - t0) / 1000))s; foreign $foreign; contaminated=$LAST_CONTAMINATED"
}

# A contaminated run is repeated once on a quiet host with the same
# schedule. If it is contaminated again, the whole repetition is dropped for
# every layout, so that the layouts stay paired, and a new repetition starts.
phase_c() {
  local rep=0 clean=0 layout attempt ok
  if ! meter_selfcheck; then
    log "the foreign-load meter failed its check; stopping without data"
    return 4
  fi
  while ((clean < REPS_C && rep < MAX_REPS_C)); do
    rep=$((rep + 1))
    ok=1
    while read -r layout; do
      for attempt in 1 2; do
        if [ "$CUTOFF_EPOCH" -gt 0 ] && [ "$(date +%s)" -ge "$CUTOFF_EPOCH" ]; then
          log "cutoff $(date -d "@$CUTOFF_EPOCH" +%H:%M) reached: no new runs"
          jq -cn --argjson t "$(now_ms)" '{phase:"C-abort",label:"cutoff",reason:"cutoff",t:$t}' >>"$TRIALS"
          log "phase C: $clean clean repetitions of $rep (stopped at the cutoff)"
          return 5
        fi
        gate_quiet "$GATE_WAIT_S" "C-$layout-r$rep-a$attempt" "$CUTOFF_EPOCH" || return 3
        DRIFT=$(drift_ms)
        run_layout_c "$layout" "$rep" "$attempt"
        [ "$LAST_CONTAMINATED" = false ] && break
      done
      if [ "$LAST_CONTAMINATED" = true ]; then
        ok=0
        jq -cn --argjson rep "$rep" --arg layout "$layout" '{phase:"C-rep-dropped",rep:$rep,layout:$layout}' >>"$TRIALS"
        log "repetition $rep dropped: $layout was contaminated twice"
        break
      fi
    done < <(printf '%s\n' "${LAYOUTS_C[@]}" | shuffle "$((SEED + 300 + rep))")
    ((ok)) && clean=$((clean + 1))
  done
  log "phase C: $clean clean repetitions of $rep"
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
    _lane-job) lane_job "$2" "$3" ;;
    launch-c)
      local at="${2:-now}" target start_by cutoff day
      target=$(date +%s)
      [ "$at" = now ] || target=$(date -d "$at" +%s) || exit 64
      if [ "$target" -lt $(($(date +%s) - 60)) ]; then
        log "start time $at is in the past"
        exit 64
      fi
      # The latest start and the cutoff are the next such times after the target.
      day=$(date -d "@$target" +%F)
      start_by=$(date -d "$day ${BENCH_START_BY:-02:00}" +%s)
      [ "$start_by" -gt "$target" ] || start_by=$((start_by + 86400))
      cutoff=$(date -d "$day ${BENCH_CUTOFF:-04:00}" +%s)
      [ "$cutoff" -gt "$target" ] || cutoff=$((cutoff + 86400))
      log "phase C starts at $(date -d "@$target" '+%F %H:%M'); latest start $(date -d "@$start_by" +%H:%M); no new run after $(date -d "@$cutoff" +%H:%M)"
      # Wall clock, not sleep: the monotonic clock stops while the laptop sleeps.
      while [ "$(date +%s)" -lt "$target" ]; do sleep 30; done
      if [ "$(date +%s)" -ge "$start_by" ]; then
        log "missed the start window (now $(date +%H:%M)); not starting"
        exit 6
      fi
      export BENCH_START_BY_EPOCH=$start_by BENCH_CUTOFF_EPOCH=$cutoff
      exec systemd-run --user --scope --quiet --unit="lane-bench-c-$(date +%s)" -- bash "$SELF" phase-c
      ;;
    stop)
      # A phase C run owns a scope: stopping it ends every process of the run.
      if systemctl --user list-units --plain --no-legend 'lane-bench-c-*.scope' | grep -q .; then
        systemctl --user stop 'lane-bench-c-*.scope'
      else
        # Other runs are process-group leaders (setsid): end each and every test it started.
        local pid
        pid=$(cat "$OUT/bench.pid" 2>/dev/null) && kill -TERM -- "-$(ps -o pgid= -p "$pid" | tr -d ' ')"
      fi
      pkill -f 'bench.sh launch-c' 2>/dev/null
      return 0
      ;;
    pilot | full | phase-a | phase-b | phase-c)
      if [ "$cmd" = phase-c ]; then
        SLOTS=4
        if ! find_cgroup; then
          log "phase C must run in its own lane-bench*.scope, so foreign load can be measured: use bench.sh launch-c"
          exit 2
        fi
      fi
      echo "$$" >"$OUT/bench.pid"
      trap 'release_lanes' EXIT
      trap 'exit 130' INT TERM HUP
      setup_slots || exit 2
      # Phase C waits for a quiet host BEFORE it takes the lanes, so a long
      # wait does not block the other sessions' test runs.
      if [ "$cmd" = phase-c ] && ! gate_quiet "$GATE_WAIT_START_S" "phase C" "$START_BY_EPOCH"; then
        log "phase-c stopped (exit 3)"
        exit 3
      fi
      RESERVED=true
      if [ "${BENCH_NO_RESERVE:-}" = 1 ]; then
        RESERVED=false
        log "NOT holding the fleet lanes (BENCH_NO_RESERVE=1, smoke tests only)"
      else
        reserve_lanes
      fi
      # Slot locks of a run that was stopped mid-job would make jobs idle in a lane.
      rm -rf "$LOGS/slot-locks"
      start_probe
      # A quiet minute first: the responsiveness baseline for the decision rule.
      echo IDLE >"$CURRENT"
      sleep "${BENCH_IDLE_S:-60}"
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
        phase-c)
          phase_c || {
            rc=$?
            log "phase-c stopped (exit $rc)"
            exit "$rc"
          }
          ;;
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
