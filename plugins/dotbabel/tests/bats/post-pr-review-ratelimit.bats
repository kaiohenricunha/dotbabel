#!/usr/bin/env bats
# Header-parser invariants for post-pr-review-ratelimit.sh.
# This script reads x-ratelimit-* headers from a saved `gh api --include`
# response. The orchestrator uses its output to decide whether to slow down
# or stop a posting batch.

load helpers

SCRIPT="$REPO_ROOT/plugins/dotbabel/scripts/post-pr-review-ratelimit.sh"

setup() {
  [ -x "$SCRIPT" ] || chmod +x "$SCRIPT"
  HFILE=$(mktemp)
}

teardown() {
  rm -f "$HFILE"
}

@test "well-formed headers: emits {limit, remaining, used, reset} JSON" {
  cat > "$HFILE" <<'EOF'
HTTP/2 201
content-type: application/json
x-ratelimit-limit: 5000
x-ratelimit-remaining: 4998
x-ratelimit-used: 2
x-ratelimit-reset: 1735689600
EOF
  run "$SCRIPT" "$HFILE"
  [ "$status" -eq 0 ]
  echo "$output" | jq -e '.limit == 5000'
  echo "$output" | jq -e '.remaining == 4998'
  echo "$output" | jq -e '.used == 2'
  echo "$output" | jq -e '.reset == 1735689600'
}

@test "missing remaining header: exit 1 (call likely failed)" {
  cat > "$HFILE" <<'EOF'
HTTP/2 403
content-type: application/json
EOF
  run "$SCRIPT" "$HFILE"
  [ "$status" -eq 1 ]
}

@test "missing headers file: exit 1" {
  run "$SCRIPT" "/tmp/no-such-headers-file-$$"
  [ "$status" -eq 1 ]
}

@test "no args: exit 3 with usage" {
  run "$SCRIPT"
  [ "$status" -eq 3 ]
  [[ "$output" == *"usage"* ]]
}

@test "uppercase header names: still matched (case-insensitive)" {
  cat > "$HFILE" <<'EOF'
HTTP/2 201
X-RateLimit-Limit: 5000
X-RateLimit-Remaining: 100
X-RateLimit-Used: 4900
X-RateLimit-Reset: 1735689600
EOF
  run "$SCRIPT" "$HFILE"
  [ "$status" -eq 0 ]
  echo "$output" | jq -e '.remaining == 100'
}

@test "CRLF line endings: stripped before parse" {
  printf 'HTTP/2 201\r\nx-ratelimit-limit: 5000\r\nx-ratelimit-remaining: 42\r\nx-ratelimit-used: 4958\r\nx-ratelimit-reset: 1735689600\r\n' > "$HFILE"
  run "$SCRIPT" "$HFILE"
  [ "$status" -eq 0 ]
  echo "$output" | jq -e '.remaining == 42'
}

@test "duplicate headers (response with retry): tail wins" {
  cat > "$HFILE" <<'EOF'
HTTP/2 201
x-ratelimit-limit: 5000
x-ratelimit-remaining: 4999
x-ratelimit-used: 1
x-ratelimit-reset: 1735689600

HTTP/2 201
x-ratelimit-limit: 5000
x-ratelimit-remaining: 4998
x-ratelimit-used: 2
x-ratelimit-reset: 1735689600
EOF
  run "$SCRIPT" "$HFILE"
  [ "$status" -eq 0 ]
  # Tail-wins: the second response's value, not the first.
  echo "$output" | jq -e '.remaining == 4998'
}
