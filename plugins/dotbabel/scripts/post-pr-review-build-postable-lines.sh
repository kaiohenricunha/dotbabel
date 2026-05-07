#!/usr/bin/env bash
# post-pr-review-build-postable-lines.sh — derive the set of postable
# (path, line) coordinates from a unified diff.
#
# Usage:
#   post-pr-review-build-postable-lines.sh <diff-path>
#
# Output: JSON object {path: [line, line, ...], ...} — one entry per file in
# the diff. Lines included = additions (+) and context (' ') lines visible on
# the RIGHT (NEW) side of the diff. The orchestrator gates which (path, line)
# coordinates are valid POST targets against this set.
#
# Files deleted in the diff (`+++ /dev/null`) are excluded.
#
# Exit codes:
#   0  ok
#   3  invocation error

set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "usage: $0 <diff-path>" >&2
  exit 3
fi

DIFF="$1"
if [[ ! -f "$DIFF" ]]; then
  echo "diff not found: $DIFF" >&2
  exit 3
fi

awk '
BEGIN {
  printf("{")
  first_file=1
  in_file=0
}
/^\+\+\+ / {
  if (in_file) {
    printf("]")
    first_file=0
  }
  path=$2
  sub(/^b\//, "", path)
  if (path == "/dev/null") {
    in_file=0
    next
  }
  if (!first_file) printf(",")
  printf("\"%s\":[", path)
  in_file=1
  line=0
  first_line=1
  next
}
/^@@ / {
  if (match($0, /\+([0-9]+)/, arr)) {
    line=arr[1]-1
  }
  next
}
in_file && /^[+ ]/ {
  if (!/^\+\+\+/) {
    line++
    if (substr($0,1,1) == "+" || substr($0,1,1) == " ") {
      if (!first_line) printf(",")
      printf("%d", line)
      first_line=0
    }
  }
}
END {
  if (in_file) printf("]")
  printf("}")
}
' "$DIFF"
