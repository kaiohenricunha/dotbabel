#!/usr/bin/env bats
# Marker-extraction invariants for post-pr-review-list-markers.sh.
# The orchestrator dedupes new findings against existing markers; this
# script must extract them deterministically from comment bodies.

load helpers

SCRIPT="$REPO_ROOT/plugins/dotbabel/scripts/post-pr-review-list-markers.sh"

setup() {
  [ -x "$SCRIPT" ] || chmod +x "$SCRIPT"
}

@test "fake gh returns comments with markers: extracted hashes (one per line, sorted, unique)" {
  with_fake_tool_bin gh '
    cat <<EOF
Body without marker
First finding <!-- post-pr-review:v1:abcdef0123456789 -->
Second finding <!-- post-pr-review:v1:1234567890abcdef -->
Duplicate <!-- post-pr-review:v1:abcdef0123456789 -->
EOF
  ' >/dev/null
  run "$SCRIPT" 42 --repo owner/repo
  [ "$status" -eq 0 ]
  # Two unique markers, sorted alphabetically.
  expected=$'1234567890abcdef\nabcdef0123456789'
  [ "$output" = "$expected" ]
}

@test "fake gh returns no comments with markers: empty output, exit 0" {
  with_fake_tool_bin gh 'echo "Plain body, no marker"' >/dev/null
  run "$SCRIPT" 42 --repo owner/repo
  [ "$status" -eq 0 ]
  [ -z "$output" ]
}

@test "no args: exit 3 with usage" {
  run "$SCRIPT"
  [ "$status" -eq 3 ]
  [[ "$output" == *"usage"* ]]
}

@test "marker with non-hex characters is rejected (only [0-9a-f]{16})" {
  with_fake_tool_bin gh '
    cat <<EOF
Bad marker <!-- post-pr-review:v1:NOTHEXNOTHEX0000 -->
Good marker <!-- post-pr-review:v1:0123456789abcdef -->
EOF
  ' >/dev/null
  run "$SCRIPT" 42 --repo owner/repo
  [ "$status" -eq 0 ]
  [ "$output" = "0123456789abcdef" ]
}

@test "marker with wrong version (v2) is NOT extracted by v1 regex" {
  with_fake_tool_bin gh '
    cat <<EOF
v1 marker <!-- post-pr-review:v1:0123456789abcdef -->
v2 marker <!-- post-pr-review:v2:fedcba9876543210 -->
EOF
  ' >/dev/null
  run "$SCRIPT" 42 --repo owner/repo
  [ "$status" -eq 0 ]
  # Only the v1 marker is returned.
  [ "$output" = "0123456789abcdef" ]
}
