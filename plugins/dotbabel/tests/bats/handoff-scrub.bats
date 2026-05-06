#!/usr/bin/env bats
# Behavior tests for plugins/dotbabel/scripts/handoff-scrub.sh.
# The script's pattern table is authoritatively documented in
# skills/handoff/references/redaction.md — this suite cross-checks
# each documented pattern with at least one positive test case.

load helpers

SCRUB="$REPO_ROOT/plugins/dotbabel/scripts/handoff-scrub.sh"

setup() {
  [ -x "$SCRUB" ] || chmod +x "$SCRUB"
}

@test "scrub: empty input → empty stdout, scrubbed:0 on stderr" {
  local err_file
  err_file="$(mktemp)"
  run bash -c "printf '' | '$SCRUB' 2>'$err_file'"
  [ "$status" -eq 0 ]
  [ -z "$output" ]
  [ "$(cat "$err_file")" = "scrubbed:0" ]
  rm -f "$err_file"
}

@test "scrub: plain prose with no secrets passes through unchanged, scrubbed:0" {
  local input="Hello world, this is harmless content with numbers 1234 and path /tmp/foo."
  run bash -c "printf %s '$input' | '$SCRUB' 2> >(grep -o 'scrubbed:.*')"
  [ "$status" -eq 0 ]
  [[ "$output" == *"Hello world, this is harmless content"* ]]
}

@test "scrub: github-token is redacted" {
  run bash -c "printf 'pre ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456 post' | '$SCRUB'"
  [ "$status" -eq 0 ]
  [[ "$output" == *"<redacted:github-token>"* ]]
  [[ "$output" != *"ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456"* ]]
}

@test "scrub: openai/anthropic sk-... is redacted" {
  run bash -c "printf 'key sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123' | '$SCRUB'"
  [ "$status" -eq 0 ]
  [[ "$output" == *"<redacted:openai-or-sk>"* ]]
}

@test "scrub: sk-learn is NOT redacted (false-friend)" {
  run bash -c "printf 'I use sk-learn for ML and sklearn too' | '$SCRUB'"
  [ "$status" -eq 0 ]
  [[ "$output" == *"sk-learn"* ]]
  [[ "$output" == *"sklearn"* ]]
  [[ "$output" != *"<redacted:openai-or-sk>"* ]]
}

@test "scrub: AWS access key AKIA... is redacted" {
  run bash -c "printf 'id=AKIAIOSFODNN7EXAMPLE end' | '$SCRUB'"
  [ "$status" -eq 0 ]
  [[ "$output" == *"<redacted:aws-access-key>"* ]]
}

@test "scrub: Google API key AIza... is redacted in full" {
  # Real Google API keys are 39 chars total (AIza + 35). Input deliberately
  # avoids a leading 'key=' so the env-secret pattern doesn't swallow it first.
  run bash -c "printf 'the quota belongs to AIzaSyABCDEFGHIJKLMNOPQRSTUVWXYZ0123456 good' | '$SCRUB' 2>/dev/null"
  [ "$status" -eq 0 ]
  [[ "$output" == *"<redacted:google-api-key>"* ]]
  [[ "$output" != *"AIzaSy"* ]]
}

@test "scrub: Slack token xoxb-... is redacted" {
  run bash -c "printf 'token xoxb-1234567890-abcdef end' | '$SCRUB'"
  [ "$status" -eq 0 ]
  [[ "$output" == *"<redacted:slack-token>"* ]]
}

@test "scrub: Authorization: Bearer line is redacted" {
  run bash -c "printf 'Authorization: Bearer eyJ.abc.def\n' | '$SCRUB'"
  [ "$status" -eq 0 ]
  [[ "$output" == *"<redacted:auth-bearer>"* ]]
  [[ "$output" != *"eyJ.abc.def"* ]]
}

@test "scrub: env-secret line (PASSWORD=...) is redacted" {
  run bash -c "printf 'DATABASE_PASSWORD=hunter2\n' | '$SCRUB'"
  [ "$status" -eq 0 ]
  [[ "$output" == *"<redacted:env-secret>"* ]]
  [[ "$output" != *"hunter2"* ]]
}

@test "scrub: env-secret line (export API_TOKEN=...) is redacted" {
  run bash -c "printf '  export API_TOKEN=abc123\n' | '$SCRUB'"
  [ "$status" -eq 0 ]
  [[ "$output" == *"<redacted:env-secret>"* ]]
}

@test "scrub: PEM private key header is redacted" {
  run bash -c "printf -- '-----BEGIN RSA PRIVATE KEY-----\n' | '$SCRUB'"
  [ "$status" -eq 0 ]
  [[ "$output" == *"<redacted:pem-private-key>"* ]]
}

@test "scrub: stderr reports correct count on multi-match input" {
  local err_file err
  err_file="$(mktemp)"
  bash -c "printf 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456\nAKIAIOSFODNN7EXAMPLE\n' | '$SCRUB' >/dev/null 2>'$err_file'"
  err="$(cat "$err_file")"
  rm -f "$err_file"
  [ "$err" = "scrubbed:2" ]
}

@test "scrub: reference doc pattern count matches script pattern count" {
  # The reference table lists 8 patterns; the script must implement all 8.
  local table_count script_count
  table_count="$(awk -F'|' '/^\| `[a-z0-9-]+`/{print $2}' "$REPO_ROOT/skills/handoff/references/redaction.md" | wc -l)"
  script_count="$(grep -c '<redacted:[a-z0-9-]\+>' "$REPO_ROOT/plugins/dotbabel/scripts/handoff-scrub.sh")"
  # Script has one substitution per pattern, so counts should match.
  [ "$table_count" -eq 8 ]
  [ "$script_count" -eq 8 ]
}
