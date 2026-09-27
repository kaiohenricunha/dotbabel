#!/usr/bin/env bash
# fleet-lane.sh — run one command in a CPU lane of `dotbabel fleet`.
#
# Usage:
#   fleet-lane.sh [--name <label>] -- <command> [args...]
#   fleet-lane.sh --layout
#
# A lane is a fixed set of CPUs. The online CPUs are split into lanes of about
# 5, and the last CPU stays free for shells, editors, and the Claude Code
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
  k="${DOTBABEL_FLEET_LANE_COUNT:-}"
  [[ $k =~ ^[1-9][0-9]*$ ]] || k=$(((usable + 2) / 5))
  [ "$k" -ge 1 ] || k=1
  [ "$k" -le "$usable" ] || k=$usable
  w=$((usable / k))
  for ((i = 0; i < k; i++)); do
    s=$((i * w))
    e=$((s + w - 1))
    [ "$i" -eq $((k - 1)) ] && e=$((usable - 1))
    if [ "$s" -eq "$e" ]; then echo "lane $((i + 1)) $s"; else echo "lane $((i + 1)) $s-$e"; fi
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
# the nearest ancestor that has one.
session="${DOTBABEL_LANE_SESSION:-}"
if [ -z "$session" ]; then
  registry="${CLAUDE_CONFIG_DIR:-${HOME:-}/.claude}/sessions"
  p=$PPID
  for _ in 1 2 3 4; do
    if [ -r "$registry/$p.json" ]; then
      session=$(sed -n 's/.*"name":"\([^"]*\)".*/\1/p' "$registry/$p.json")
      break
    fi
    p=$(awk '{ sub(/.*\) /, ""); print $2 }' "/proc/$p/stat" 2>/dev/null) || break
    [ -n "$p" ] && [ "$p" -gt 1 ] || break
  done
fi
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
holder=""
waiting=0
cleanup() { rm -f "$waiter" ${holder:+"$holder"}; }
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

got=""
while [ -z "$got" ]; do
  for ((i = 0; i < ${#lanes[@]}; i++)); do
    exec {lane}>>"$dir/lane-$((i + 1)).lock" || continue
    if flock -n "$lane"; then
      got=$i
      break
    fi
    exec {lane}>&-
  done
  if [ -z "$got" ]; then
    [ "$waiting" = 1 ] || announce
    sleep 0.5
  fi
done
flock -u "$queue"
exec {queue}>&-
rm -f "$waiter"

cpus=${lanes[$got]}
index=$((got + 1))
holder="$dir/lane-$index.holder"
write_info "$holder" "$index" "$cpus"

width=0
for part in ${cpus//,/ }; do
  if [[ $part == *-* ]]; then width=$((width + ${part#*-} - ${part%-*} + 1)); else width=$((width + 1)); fi
done
export DOTBABEL_LANE="$index" DOTBABEL_LANE_CPUS="$cpus"
user_workers="${PYTEST_XDIST_AUTO_NUM_WORKERS:-}"
if ! [[ $user_workers =~ ^[1-9][0-9]*$ ]] || [ "$user_workers" -gt "$width" ]; then
  export PYTEST_XDIST_AUTO_NUM_WORKERS="$width"
fi

# The command must not inherit the lock: the lane belongs to this script.
taskset -c "$cpus" "$@" {lane}>&- <&0 &
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
rm -f "$holder"
exit "$rc"
