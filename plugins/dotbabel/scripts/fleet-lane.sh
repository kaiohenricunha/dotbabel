#!/usr/bin/env bash
# fleet-lane.sh — run one command in a CPU lane of `dotbabel fleet`.
#
# Usage:
#   fleet-lane.sh [--name <label>] -- <command> [args...]
#   fleet-lane.sh --layout
#
# A lane is a fixed set of CPUs. The online CPUs are split into lanes of about
# 7, and the last CPU stays free for shells, editors, and the Claude Code
# sessions themselves (a machine with fewer than 6 CPUs keeps none free). A
# command waits in a queue until a lane is free, then runs under
# `taskset -c <lane CPUs>`. Tools that size their worker pool from the CPUs
# they may use — Node's os.availableParallelism() (vitest, jest), Go's
# GOMAXPROCS, nproc — then start one worker per lane CPU. pytest-xdist counts
# CPUs through psutil, which ignores the pinning, so the lane also exports
# PYTEST_XDIST_AUTO_NUM_WORKERS.
#
# The lock is flock(1) on <state>/lanes/lane-<n>.lock. This script holds it,
# not the command, so the lane frees the moment the command exits, even when
# the command leaves a background process behind. The kernel drops the lock
# when this script dies, so a crash never loses a lane. Waiters queue on
# <state>/lanes/queue.lock, so the first to wait is the first to get a lane.
#
# Lending: the command at the head of the queue may take more than one free
# lane and run on all their CPUs. With DOTBABEL_FLEET_LEND=auto (the default),
# it takes every free lane when no other Claude Code session is busy and no
# command waits; otherwise one lane. With a number n, it takes up to n lanes,
# never the last free lane, and only one while another command waits. A lent
# lane frees when the command ends.
#
# While the command runs, lane-<n>.holder records the --name label (such as
# "npm test"), the Claude Code session name, and the working directory. It
# never records the command line, because commands can carry secrets.
#
# The command runs directly, with no lane, when:
#   - DOTBABEL_LANE is set (this is already inside a lane),
#   - DOTBABEL_FLEET_LANES=off, or the kill-switch file <state>/lanes.off exists,
#   - flock or taskset is missing, or bash is older than 4.
#
# Settings:
#   DOTBABEL_FLEET_LANES       "off", or explicit lanes as CPU lists joined by ";" ("0-4;5-9")
#   DOTBABEL_FLEET_LANE_COUNT  the number of lanes in the automatic layout
#   DOTBABEL_FLEET_LANE_WIDTH  CPUs per lane in the automatic layout (default 7): round(usable /
#                              width) lanes, at least 2 from 8 usable CPUs, extra CPUs on the first lanes
#   DOTBABEL_FLEET_LEND        auto (default), or the most lanes one command may take, or 1 for none
#   DOTBABEL_FLEET_NCPU        the CPU count for the automatic layout (default: online CPUs)
#   DOTBABEL_FLEET_STATE_DIR   the state root (default $XDG_STATE_HOME/dotbabel/fleet)
#
# Exit: the command's status (128+N when signal N ends it); 64 on bad usage.

set -u

state="${DOTBABEL_FLEET_STATE_DIR:-${XDG_STATE_HOME:-${HOME:-}/.local/state}/dotbabel/fleet}"

name=""
layout_only=0
while [ $# -gt 0 ]; do
  case "$1" in
    --layout)
      layout_only=1
      shift
      ;;
    --name)
      if [ $# -lt 2 ]; then
        echo "fleet-lane: --name needs a value" >&2
        exit 64
      fi
      name=$2
      shift 2
      ;;
    --)
      shift
      break
      ;;
    *) break ;;
  esac
done

# One CPU list per lane, as "lane <n> <cpus>", after an "ncpu <n>" line.
print_layout() {
  local spec="${DOTBABEL_FLEET_LANES:-}" n="${DOTBABEL_FLEET_NCPU:-}"
  if [ "$spec" = off ]; then
    echo off
    return
  fi
  [[ $n =~ ^[1-9][0-9]*$ ]] || n=$(getconf _NPROCESSORS_ONLN 2>/dev/null)
  [[ $n =~ ^[1-9][0-9]*$ ]] || n=1
  echo "ncpu $n"

  if [ -n "$spec" ]; then
    local parts part id ok=1 i=0
    IFS=';' read -r -a parts <<<"$spec"
    [ "${#parts[@]}" -gt 0 ] || ok=0
    for part in "${parts[@]}"; do
      if [[ $part =~ ^[0-9]+(-[0-9]+)?(,[0-9]+(-[0-9]+)?)*$ ]]; then
        for id in ${part//[,-]/ }; do [ "$id" -lt "$n" ] || ok=0; done
      else
        ok=0
      fi
    done
    if [ "$ok" = 1 ]; then
      for part in "${parts[@]}"; do
        i=$((i + 1))
        echo "lane $i $part"
      done
      return
    fi
  fi

  local reserve=0 usable k w s e
  [ "$n" -ge 6 ] && reserve=1
  usable=$((n - reserve))
  # Lanes of about 7 CPUs: the lane size benchmark (docs/experiments/
  # 2026-09-27-cpu-lane-size.md) found 2 lanes of 7-8 faster than 3 of 5 on 16 CPUs.
  local width="${DOTBABEL_FLEET_LANE_WIDTH:-7}"
  [[ $width =~ ^[1-9][0-9]*$ ]] || width=7
  k="${DOTBABEL_FLEET_LANE_COUNT:-}"
  if ! [[ $k =~ ^[1-9][0-9]*$ ]]; then
    k=$(((usable + width / 2) / width))
    [ "$usable" -ge 8 ] && [ "$k" -lt 2 ] && k=2
  fi
  [ "$k" -ge 1 ] || k=1
  [ "$k" -le "$usable" ] || k=$usable
  # The CPUs left over go one each to the first lanes.
  local extra=$((usable % k))
  w=$((usable / k))
  s=0
  for ((i = 0; i < k; i++)); do
    e=$((s + w - 1))
    [ "$i" -lt "$extra" ] && e=$((e + 1))
    if [ "$s" -eq "$e" ]; then echo "lane $((i + 1)) $s"; else echo "lane $((i + 1)) $s-$e"; fi
    s=$((e + 1))
  done
}

if [ "$layout_only" = 1 ]; then
  print_layout
  exit 0
fi

if [ $# -eq 0 ]; then
  echo "fleet-lane: no command given. Usage: fleet-lane.sh [--name <label>] -- <command> [args...]" >&2
  exit 64
fi
[ -n "$name" ] || name=${1##*/}
name=${name//$'\n'/ }

direct() { exec "$@"; }

[ -z "${DOTBABEL_LANE:-}" ] || direct "$@"
[ "${DOTBABEL_FLEET_LANES:-}" != off ] || direct "$@"
[ ! -e "$state/lanes.off" ] || direct "$@"
((BASH_VERSINFO[0] >= 4)) || direct "$@"
command -v flock >/dev/null 2>&1 && command -v taskset >/dev/null 2>&1 || direct "$@"
dir="$state/lanes"
mkdir -p "$dir" 2>/dev/null || direct "$@"

lanes=()
while read -r kind _ cpus; do
  [ "$kind" = lane ] && lanes+=("$cpus")
done < <(print_layout)
[ "${#lanes[@]}" -gt 0 ] || direct "$@"

# Who runs this: the Claude Code session in ~/.claude/sessions/<pid>.json of
# the nearest ancestor that has one. Auto lending needs its pid even when
# DOTBABEL_LANE_SESSION already names it.
registry="${CLAUDE_CONFIG_DIR:-${HOME:-}/.claude}/sessions"
session="${DOTBABEL_LANE_SESSION:-}"
self_pid=""
p=$PPID
for _ in 1 2 3 4; do
  if [ -r "$registry/$p.json" ]; then
    self_pid=$p
    [ -n "$session" ] || session=$(sed -n 's/.*"name":"\([^"]*\)".*/\1/p' "$registry/$p.json")
    break
  fi
  p=$(awk '{ sub(/.*\) /, ""); print $2 }' "/proc/$p/stat" 2>/dev/null) || break
  [ -n "$p" ] && [ "$p" -gt 1 ] || break
done
session=${session//$'\n'/ }
self_start=$(awk '{ sub(/.*\) /, ""); print $20 }' "/proc/$$/stat" 2>/dev/null)

# write_info <file> [<lane> <cpus>] — atomic key=value record for `dotbabel fleet lanes`.
write_info() {
  local tmp="$1.$$.tmp"
  {
    printf 'pid=%s\nprocstart=%s\nlabel=%s\nsession=%s\ncwd=%s\nstarted=%s\n' \
      "$$" "$self_start" "$name" "$session" "${PWD//$'\n'/ }" "$(date +%s)"
    [ $# -ge 3 ] && printf 'lane=%s\ncpus=%s\n' "$2" "$3"
  } >"$tmp" 2>/dev/null && mv -f "$tmp" "$1" 2>/dev/null
}

waiter="$dir/wait-$$.info"
holders=()
waiting=0
cleanup() { rm -f "$waiter" "${holders[@]}"; }
trap 'cleanup; exit 130' INT
trap 'cleanup; exit 143' TERM
trap 'cleanup; exit 129' HUP

announce() {
  local busy="" i label sess f
  for ((i = 1; i <= ${#lanes[@]}; i++)); do
    f="$dir/lane-$i.holder"
    [ -r "$f" ] || continue
    label=$(sed -n 's/^label=//p' "$f")
    sess=$(sed -n 's/^session=//p' "$f")
    busy+="${busy:+; }lane $i: ${label:-?}${sess:+ ($sess)}"
  done
  echo "dotbabel fleet: \"$name\" waits for a free CPU lane (${#lanes[@]} in all${busy:+; busy now: $busy})." >&2
  write_info "$waiter"
  waiting=1
}

exec {queue}>>"$dir/queue.lock" || direct "$@"
if ! flock -n "$queue"; then
  announce
  # Wait in the background, so a signal can still end this script at once.
  flock "$queue" &
  wait $! || {
    cleanup
    exit 1
  }
fi

held=()     # the lane numbers (0-based) this script holds
held_fds=() # their lock descriptors

# take_lane <i>: lock lane i if it is free.
take_lane() {
  local fd
  exec {fd}>>"$dir/lane-$(($1 + 1)).lock" || return 1
  if flock -n "$fd"; then
    held+=("$1")
    held_fds+=("$fd")
    return 0
  fi
  exec {fd}>&-
  return 1
}

# True when another live command waits: its waiter file names a process
# that still runs with the same start time.
others_wait() {
  local f pid start now
  for f in "$dir"/wait-*.info; do
    [ -e "$f" ] && [ "$f" != "$waiter" ] || continue
    pid=$(sed -n 's/^pid=//p' "$f")
    start=$(sed -n 's/^procstart=//p' "$f")
    [[ $pid =~ ^[0-9]+$ ]] || continue
    now=$(awk '{ sub(/.*\) /, ""); print $20 }' "/proc/$pid/stat" 2>/dev/null) || continue
    [ -n "$now" ] && [ "$now" = "$start" ] && return 0
  done
  return 1
}

# True when another live Claude Code session is busy (status "busy" in its
# registry entry, a live pid with the same start time). A session that this
# script could not find is not excluded, so then every busy session counts.
other_busy() {
  local f pid start now
  while IFS= read -r f; do
    pid=$(sed -n 's/.*"pid": *\([0-9][0-9]*\).*/\1/p' "$f")
    start=$(sed -n 's/.*"procStart": *"\([0-9]*\)".*/\1/p' "$f")
    [ -n "$pid" ] && [ "$pid" != "$self_pid" ] || continue
    now=$(awk '{ sub(/.*\) /, ""); print $20 }' "/proc/$pid/stat" 2>/dev/null) || continue
    [ -n "$now" ] && [ "$now" = "$start" ] && return 0
  done < <(grep -lE '"status": *"busy"' "$registry"/*.json 2>/dev/null)
  return 1
}

while [ "${#held[@]}" -eq 0 ]; do
  for ((i = 0; i < ${#lanes[@]}; i++)); do
    take_lane "$i" && break
  done
  if [ "${#held[@]}" -eq 0 ]; then
    [ "$waiting" = 1 ] || announce
    sleep 0.5
  fi
done

# Lending. This script still holds the queue lock, so no other command can
# take a lane while it counts the free ones.
# auto (the default): every free lane, the last one too, when no other
# session is busy and no command waits; otherwise one lane. A number n: up to
# n lanes, never the last free lane. Anything else: one lane.
lend="${DOTBABEL_FLEET_LEND:-auto}"
keep=1
if [ "$lend" = auto ]; then
  if others_wait || other_busy; then
    lend=1
  else
    lend=${#lanes[@]}
    keep=0
  fi
fi
[[ $lend =~ ^[1-9][0-9]*$ ]] || lend=1
if [ "$lend" -gt 1 ] && ! others_wait; then
  spare=()
  spare_fds=()
  for ((i = 0; i < ${#lanes[@]}; i++)); do
    [ "$i" -eq "${held[0]}" ] && continue
    exec {fd}>>"$dir/lane-$((i + 1)).lock" || continue
    if flock -n "$fd"; then
      spare+=("$i")
      spare_fds+=("$fd")
    else
      exec {fd}>&-
    fi
  done
  # A number keeps at least one free lane for the next command.
  take=$((lend - 1))
  [ "$take" -le $((${#spare[@]} - keep)) ] || take=$((${#spare[@]} - keep))
  for ((j = 0; j < ${#spare[@]}; j++)); do
    fd=${spare_fds[j]}
    if [ "$j" -lt "$take" ]; then
      held+=("${spare[j]}")
      held_fds+=("$fd")
    else
      exec {fd}>&-
    fi
  done
fi
flock -u "$queue"
exec {queue}>&-
rm -f "$waiter"

parts=()
for i in "${held[@]}"; do parts+=("${lanes[$i]}"); done
cpus=$(
  IFS=,
  echo "${parts[*]}"
)
index=$((held[0] + 1))
for i in "${held[@]}"; do
  holders+=("$dir/lane-$((i + 1)).holder")
  write_info "$dir/lane-$((i + 1)).holder" "$((i + 1))" "$cpus"
done

width=0
for part in ${cpus//,/ }; do
  if [[ $part == *-* ]]; then width=$((width + ${part#*-} - ${part%-*} + 1)); else width=$((width + 1)); fi
done
export DOTBABEL_LANE="$index" DOTBABEL_LANE_CPUS="$cpus"
user_workers="${PYTEST_XDIST_AUTO_NUM_WORKERS:-}"
if ! [[ $user_workers =~ ^[1-9][0-9]*$ ]] || [ "$user_workers" -gt "$width" ]; then
  export PYTEST_XDIST_AUTO_NUM_WORKERS="$width"
fi

# The command must not inherit the locks: the lanes belong to this script.
(
  for fd in "${held_fds[@]}"; do exec {fd}>&-; done
  exec taskset -c "$cpus" "$@"
) <&0 &
child=$!
trap 'kill -INT "$child" 2>/dev/null' INT
trap 'kill -TERM "$child" 2>/dev/null' TERM
trap 'kill -HUP "$child" 2>/dev/null' HUP
rc=0
while :; do
  wait "$child"
  rc=$?
  kill -0 "$child" 2>/dev/null || break
done
rm -f "${holders[@]}"
exit "$rc"
