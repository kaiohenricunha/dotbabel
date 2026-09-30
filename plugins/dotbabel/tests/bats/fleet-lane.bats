#!/usr/bin/env bats
# Behavior tests for plugins/dotbabel/scripts/fleet-lane.sh, the CPU lane
# runner of `dotbabel fleet`: the lane layout, pinning, the wait for a free
# lane, pass-through of stdin / exit code / signals, and every fallback that
# runs the command directly.

load helpers

LANE="$REPO_ROOT/plugins/dotbabel/scripts/fleet-lane.sh"

setup() {
  WORK="$(mktemp -d)"
  export DOTBABEL_FLEET_STATE_DIR="$WORK/state"
  unset DOTBABEL_FLEET_LANES DOTBABEL_FLEET_LANE_COUNT DOTBABEL_FLEET_LANE_WIDTH DOTBABEL_FLEET_LEND DOTBABEL_FLEET_NCPU DOTBABEL_LANE DOTBABEL_LANE_CPUS PYTEST_XDIST_AUTO_NUM_WORKERS
}

teardown() {
  [ -n "${BG_PID:-}" ] && kill "$BG_PID" 2>/dev/null
  [ -n "${WORK:-}" ] && rm -rf "$WORK"
  return 0
}

needs_tools() {
  command -v flock >/dev/null && command -v taskset >/dev/null || skip "needs flock and taskset"
}

# Field 22 of /proc/<pid>/stat, counted after the last ") " of the name.
start_time() {
  awk '{ sub(/.*\) /, ""); print $20 }' "/proc/$1/stat"
}

# A waiter file as fleet-lane.sh writes it: the pid and start time of the waiting process.
waiter_file() { # <pid> <procstart>
  mkdir -p "$WORK/state/lanes"
  printf 'pid=%s\nprocstart=%s\nlabel=npm test\nsession=peer\n' "$1" "$2" >"$WORK/state/lanes/wait-$1.info"
}

# Wait up to ~5 s for a file to exist.
await_file() {
  for _ in $(seq 1 50); do [ -e "$1" ] && return 0; sleep 0.1; done
  return 1
}

# ---------------------------------------------------------------- layout ----

@test "layout: 16 CPUs make 3 lanes of 5 and keep the last CPU free" {
  DOTBABEL_FLEET_NCPU=16 run bash "$LANE" --layout
  [ "$status" -eq 0 ]
  [ "$output" = "$(printf 'ncpu 16\nlane 1 0-4\nlane 2 5-9\nlane 3 10-14')" ]
}

@test "layout: small machines get one lane, and no CPU is kept free below 6" {
  DOTBABEL_FLEET_NCPU=8 run bash "$LANE" --layout
  [ "$output" = "$(printf 'ncpu 8\nlane 1 0-6')" ]
  DOTBABEL_FLEET_NCPU=4 run bash "$LANE" --layout
  [ "$output" = "$(printf 'ncpu 4\nlane 1 0-3')" ]
}

@test "layout: the last lane takes the CPUs left over" {
  DOTBABEL_FLEET_NCPU=32 run bash "$LANE" --layout
  [ "${lines[0]}" = "ncpu 32" ]
  [ "${#lines[@]}" -eq 7 ]
  [ "${lines[6]}" = "lane 6 25-30" ]
}

@test "layout: DOTBABEL_FLEET_LANE_COUNT sets the count, DOTBABEL_FLEET_LANES sets explicit CPU lists" {
  DOTBABEL_FLEET_NCPU=16 DOTBABEL_FLEET_LANE_COUNT=2 run bash "$LANE" --layout
  [ "$output" = "$(printf 'ncpu 16\nlane 1 0-6\nlane 2 7-14')" ]
  DOTBABEL_FLEET_NCPU=16 DOTBABEL_FLEET_LANES='0-1;2,3' run bash "$LANE" --layout
  [ "$output" = "$(printf 'ncpu 16\nlane 1 0-1\nlane 2 2,3')" ]
}

@test "layout: an invalid DOTBABEL_FLEET_LANES falls back to the automatic layout" {
  DOTBABEL_FLEET_NCPU=16 DOTBABEL_FLEET_LANES='0-1;abc' run bash "$LANE" --layout
  [ "${lines[1]}" = "lane 1 0-4" ]
}

@test "layout: off prints off" {
  DOTBABEL_FLEET_LANES=off run bash "$LANE" --layout
  [ "$output" = "off" ]
}

@test "layout: DOTBABEL_FLEET_LANE_WIDTH sets the CPUs per lane and spreads the extra CPUs over the first lanes" {
  DOTBABEL_FLEET_NCPU=16 DOTBABEL_FLEET_LANE_WIDTH=4 run bash "$LANE" --layout
  [ "$output" = "$(printf 'ncpu 16\nlane 1 0-3\nlane 2 4-7\nlane 3 8-11\nlane 4 12-14')" ]
  DOTBABEL_FLEET_NCPU=16 DOTBABEL_FLEET_LANE_WIDTH=7 run bash "$LANE" --layout
  [ "$output" = "$(printf 'ncpu 16\nlane 1 0-7\nlane 2 8-14')" ]
  DOTBABEL_FLEET_NCPU=16 DOTBABEL_FLEET_LANE_WIDTH=x run bash "$LANE" --layout
  [ "$output" = "$(printf 'ncpu 16\nlane 1 0-4\nlane 2 5-9\nlane 3 10-14')" ]
}

@test "layout: with DOTBABEL_FLEET_LANE_WIDTH, 8 or more usable CPUs always get at least 2 lanes" {
  DOTBABEL_FLEET_NCPU=10 DOTBABEL_FLEET_LANE_WIDTH=7 run bash "$LANE" --layout
  [ "$output" = "$(printf 'ncpu 10\nlane 1 0-4\nlane 2 5-8')" ]
  DOTBABEL_FLEET_NCPU=8 DOTBABEL_FLEET_LANE_WIDTH=7 run bash "$LANE" --layout
  [ "$output" = "$(printf 'ncpu 8\nlane 1 0-6')" ]
}

# --------------------------------------------------------------- running ----

@test "runs the command pinned to its lane" {
  needs_tools
  DOTBABEL_FLEET_LANES=0 run bash "$LANE" -- nproc
  [ "$status" -eq 0 ]
  [ "$output" = "1" ]
}

@test "passes the exit code, stdout, and stdin through" {
  needs_tools
  DOTBABEL_FLEET_LANES=0 run bash "$LANE" -- bash -c 'echo out; exit 7'
  [ "$status" -eq 7 ]
  [ "$output" = "out" ]
  run bash -c 'printf hi | DOTBABEL_FLEET_LANES=0 bash "$1" -- cat' _ "$LANE"
  [ "$output" = "hi" ]
}

@test "exports the lane, its CPUs, and a pytest-xdist worker count" {
  needs_tools
  DOTBABEL_FLEET_LANES=0-1 run bash "$LANE" -- bash -c 'echo "$DOTBABEL_LANE $DOTBABEL_LANE_CPUS $PYTEST_XDIST_AUTO_NUM_WORKERS"'
  [ "$output" = "1 0-1 2" ]
}

@test "two commands on one lane run one after the other" {
  needs_tools
  job='echo "start $(date +%s%N)" >>"$1"; sleep 0.4; echo "end $(date +%s%N)" >>"$1"'
  DOTBABEL_FLEET_LANES=0 bash "$LANE" -- bash -c "$job" _ "$WORK/a.log" &
  a=$!
  DOTBABEL_FLEET_LANES=0 bash "$LANE" -- bash -c "$job" _ "$WORK/b.log" &
  b=$!
  wait "$a" "$b"
  read -r _ a_start < <(grep start "$WORK/a.log")
  read -r _ a_end < <(grep end "$WORK/a.log")
  read -r _ b_start < <(grep start "$WORK/b.log")
  read -r _ b_end < <(grep end "$WORK/b.log")
  # One interval ends before the other starts.
  [ "$a_end" -le "$b_start" ] || [ "$b_end" -le "$a_start" ]
}

@test "a waiting command says that it waits, and for which lane holder" {
  needs_tools
  DOTBABEL_FLEET_LANES=0 bash "$LANE" --name "npm test" -- sleep 2 &
  BG_PID=$!
  await_file "$WORK/state/lanes/lane-1.holder"
  DOTBABEL_FLEET_LANES=0 run bash "$LANE" -- true
  [ "$status" -eq 0 ]
  [[ "$output" == *"busy"* ]]
  [[ "$output" == *"npm test"* ]]
}

@test "records a short holder label while it runs, never the command line" {
  needs_tools
  DOTBABEL_FLEET_LANES=0 bash "$LANE" --name "npm test" -- bash -c 'sleep 1' _ --token=SECRET123 2>/dev/null &
  BG_PID=$!
  await_file "$WORK/state/lanes/lane-1.holder"
  grep -q '^label=npm test$' "$WORK/state/lanes/lane-1.holder"
  run grep -rq SECRET123 "$WORK/state"
  [ "$status" -ne 0 ]
  wait "$BG_PID" || true
  [ ! -e "$WORK/state/lanes/lane-1.holder" ]
}

@test "forwards TERM to the command and exits with its status" {
  needs_tools
  DOTBABEL_FLEET_LANES=0 bash "$LANE" -- sleep 31.5 &
  BG_PID=$!
  await_file "$WORK/state/lanes/lane-1.holder"
  kill -TERM "$BG_PID"
  rc=0
  wait "$BG_PID" || rc=$?
  [ "$rc" -eq 143 ]
  run pgrep -fx "sleep 31.5"
  [ "$status" -ne 0 ]
}

# --------------------------------------------------------------- lending ----
#
# With DOTBABEL_FLEET_LEND=<n>, the command at the head of the queue may take up
# to n free lanes, but never the last free lane, and never while another
# command waits.

@test "lending: a lone command takes 2 of 3 free lanes and pins to their CPUs" {
  needs_tools
  DOTBABEL_FLEET_LANES='0;1;2' DOTBABEL_FLEET_LEND=2 run bash "$LANE" -- \
    bash -c 'echo "$DOTBABEL_LANE $DOTBABEL_LANE_CPUS $PYTEST_XDIST_AUTO_NUM_WORKERS $(nproc)"'
  [ "$status" -eq 0 ]
  [ "$output" = "1 0,1 2 2" ]
}

@test "lending: never takes the last free lane" {
  needs_tools
  DOTBABEL_FLEET_LANES='0;1' DOTBABEL_FLEET_LEND=2 run bash "$LANE" -- bash -c 'echo "$DOTBABEL_LANE_CPUS"'
  [ "$output" = "0" ]
}

@test "lending: 3 commands in a row on 4 lanes take 2, 1, and 1 lanes, and none waits" {
  needs_tools
  export DOTBABEL_FLEET_LANES='0;1;2;3' DOTBABEL_FLEET_LEND=2
  hold='echo "$DOTBABEL_LANE_CPUS" >"$1"; while [ ! -e "$2" ]; do sleep 0.05; done'
  bash "$LANE" -- bash -c "$hold" _ "$WORK/a" "$WORK/go" 2>"$WORK/a.err" &
  a=$!
  await_file "$WORK/a"
  bash "$LANE" -- bash -c "$hold" _ "$WORK/b" "$WORK/go" 2>"$WORK/b.err" &
  b=$!
  await_file "$WORK/b"
  bash "$LANE" -- bash -c "$hold" _ "$WORK/c" "$WORK/go" 2>"$WORK/c.err" &
  c=$!
  await_file "$WORK/c"
  touch "$WORK/go"
  wait "$a" "$b" "$c"
  [ "$(cat "$WORK/a")" = "0,1" ]
  [ "$(cat "$WORK/b")" = "2" ]
  [ "$(cat "$WORK/c")" = "3" ]
  run grep -l waits "$WORK/a.err" "$WORK/b.err" "$WORK/c.err"
  [ "$status" -ne 0 ]
}

@test "lending: no lending while another live command waits" {
  needs_tools
  sleep 30 &
  BG_PID=$!
  waiter_file "$BG_PID" "$(start_time "$BG_PID")"
  DOTBABEL_FLEET_LANES='0;1;2' DOTBABEL_FLEET_LEND=2 run bash "$LANE" -- bash -c 'echo "$DOTBABEL_LANE_CPUS"'
  [ "$output" = "0" ]
}

@test "lending: a waiter file of a process that is gone does not stop lending" {
  needs_tools
  gone=$(bash -c 'echo $$')
  waiter_file "$gone" 12345
  waiter_file "$$" 1 # a live pid with another start time: the pid was reused
  DOTBABEL_FLEET_LANES='0;1;2' DOTBABEL_FLEET_LEND=2 run bash "$LANE" -- bash -c 'echo "$DOTBABEL_LANE_CPUS"'
  [ "$output" = "0,1" ]
}

@test "lending: a background process left by a lent command holds none of its lanes" {
  needs_tools
  export DOTBABEL_FLEET_LANES='0;1;2' DOTBABEL_FLEET_LEND=2
  bash "$LANE" -- bash -c 'sleep 30 >/dev/null 2>&1 & echo $! >"$1"' _ "$WORK/left.pid"
  BG_PID=$(cat "$WORK/left.pid")
  run timeout 5 bash "$LANE" -- bash -c 'echo "$DOTBABEL_LANE_CPUS"'
  [ "$status" -eq 0 ]
  [ "${lines[-1]}" = "0,1" ]
  [[ "$output" != *waits* ]]
}

@test "lending: every holder file goes away after a normal exit and after TERM" {
  needs_tools
  export DOTBABEL_FLEET_LANES='0;1;2' DOTBABEL_FLEET_LEND=2
  bash "$LANE" -- true
  run compgen -G "$WORK/state/lanes/lane-*.holder"
  [ "$status" -ne 0 ]
  bash "$LANE" --name "npm test" -- sleep 31.7 &
  BG_PID=$!
  await_file "$WORK/state/lanes/lane-2.holder"
  grep -q '^label=npm test$' "$WORK/state/lanes/lane-1.holder"
  kill -TERM "$BG_PID"
  rc=0
  wait "$BG_PID" || rc=$?
  [ "$rc" -eq 143 ]
  run compgen -G "$WORK/state/lanes/lane-*.holder"
  [ "$status" -ne 0 ]
}

@test "lending: an unset or invalid DOTBABEL_FLEET_LEND lends nothing" {
  needs_tools
  for v in "" x 0 -1 1; do
    DOTBABEL_FLEET_LANES='0;1;2' DOTBABEL_FLEET_LEND="$v" run bash "$LANE" -- bash -c 'echo "$DOTBABEL_LANE_CPUS"'
    [ "$output" = "0" ]
  done
}

# ------------------------------------------------------------- fallbacks ----

@test "runs directly inside a lane, so nested calls never wait for themselves" {
  needs_tools
  DOTBABEL_FLEET_LANES=0 bash "$LANE" -- sleep 2 &
  BG_PID=$!
  await_file "$WORK/state/lanes/lane-1.holder"
  DOTBABEL_LANE=1 DOTBABEL_FLEET_LANES=0 run timeout 1 bash "$LANE" -- echo nested
  [ "$status" -eq 0 ]
  [ "$output" = "nested" ]
}

@test "runs directly when lanes are off or the kill-switch file exists" {
  needs_tools
  [ "$(nproc)" -gt 1 ] || skip "needs more than one CPU"
  DOTBABEL_FLEET_LANES=off run bash "$LANE" -- nproc
  [ "$output" -gt 1 ]
  mkdir -p "$WORK/state" && touch "$WORK/state/lanes.off"
  DOTBABEL_FLEET_LANES=0 run bash "$LANE" -- nproc
  [ "$output" -gt 1 ]
}

@test "runs directly when flock or taskset is missing" {
  mkdir -p "$WORK/bin"
  for tool in bash echo nproc getconf mkdir mv rm cat sed awk date sleep; do
    ln -s "$(type -P "$tool")" "$WORK/bin/$tool"
  done
  DOTBABEL_FLEET_LANES=0 run env PATH="$WORK/bin" "$(command -v bash)" "$LANE" -- echo direct
  [ "$status" -eq 0 ]
  [ "$output" = "direct" ]
}

@test "exits 64 without a command" {
  run bash "$LANE" --
  [ "$status" -eq 64 ]
  run bash "$LANE" --name
  [ "$status" -eq 64 ]
}
