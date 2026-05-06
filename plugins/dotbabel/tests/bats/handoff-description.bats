#!/usr/bin/env bats
# Behavior tests for plugins/dotclaude/scripts/handoff-description.sh.
# Encode produces the v2 schema:
#   handoff:v2:<project>:<cli>:<YYYY-MM>:<short>:<host>[:<tag>]
# Decode accepts v1 (legacy) and v2; the returned JSON includes a
# "schema" key so callers can render "(legacy)" markers.

load helpers

DESC="$REPO_ROOT/plugins/dotclaude/scripts/handoff-description.sh"

setup() {
  [ -x "$DESC" ] || chmod +x "$DESC"
}

# ---- v2 encode ---------------------------------------------------------

@test "encode v2: minimal args (no tag) produces expected string" {
  run "$DESC" encode \
    --cli claude --short-id 3564b8c0 \
    --project dotclaude --hostname thinkpad-pop \
    --month 2026-04
  [ "$status" -eq 0 ]
  [ "$output" = "handoff:v2:dotclaude:claude:2026-04:3564b8c0:thinkpad-pop" ]
}

@test "encode v2: with tag produces 8-segment string" {
  run "$DESC" encode \
    --cli codex --short-id 1be89762 \
    --project example-app --hostname win-desktop \
    --month 2026-04 --tag evening
  [ "$status" -eq 0 ]
  [ "$output" = "handoff:v2:example-app:codex:2026-04:1be89762:win-desktop:evening" ]
}

@test "encode v2: accepts gemini cli" {
  run "$DESC" encode \
    --cli gemini --short-id 9999aaaa \
    --project dotclaude --hostname thinkpad-pop \
    --month 2026-05 --tag test
  [ "$status" -eq 0 ]
  [ "$output" = "handoff:v2:dotclaude:gemini:2026-05:9999aaaa:thinkpad-pop:test" ]
}

@test "encode v2: slugifies mixed-case project with spaces and punctuation" {
  run "$DESC" encode \
    --cli claude --short-id 3564b8c0 \
    --project "Dot Claude!" --hostname "Thinkpad PopOS" \
    --month 2026-04
  [ "$status" -eq 0 ]
  [ "$output" = "handoff:v2:dot-claude:claude:2026-04:3564b8c0:thinkpad-popos" ]
}

@test "encode v2: slugifies tag the same way as project/hostname" {
  run "$DESC" encode \
    --cli claude --short-id 3564b8c0 \
    --project dotclaude --hostname pop --tag "Evening Run!" \
    --month 2026-04
  [ "$status" -eq 0 ]
  [ "$output" = "handoff:v2:dotclaude:claude:2026-04:3564b8c0:pop:evening-run" ]
}

@test "encode v2: rejects unknown --cli" {
  run "$DESC" encode \
    --cli bogus --short-id 3564b8c0 \
    --project p --hostname h --month 2026-04
  [ "$status" -eq 2 ]
  [[ "$output" == *"--cli must be one of"* ]]
}

@test "encode v2: rejects bad short-id length" {
  run "$DESC" encode \
    --cli claude --short-id abc \
    --project p --hostname h --month 2026-04
  [ "$status" -eq 2 ]
  [[ "$output" == *"short-id must be exactly 8 hex chars"* ]]
}

@test "encode v2: rejects non-hex short-id" {
  run "$DESC" encode \
    --cli claude --short-id 3564b8cZ \
    --project p --hostname h --month 2026-04
  [ "$status" -eq 2 ]
  [[ "$output" == *"short-id must be exactly 8 hex chars"* ]]
}

@test "encode v2: rejects missing --month" {
  run "$DESC" encode \
    --cli claude --short-id 3564b8c0 \
    --project p --hostname h
  [ "$status" -eq 2 ]
  [[ "$output" == *"encode requires --month"* ]]
}

@test "encode v2: rejects malformed --month" {
  run "$DESC" encode \
    --cli claude --short-id 3564b8c0 \
    --project p --hostname h --month not-a-month
  [ "$status" -eq 2 ]
  [[ "$output" == *"--month must be YYYY-MM"* ]]
}

# ---- v2 decode ---------------------------------------------------------

@test "decode v2: round-trips a 7-segment string" {
  run "$DESC" decode "handoff:v2:dotclaude:claude:2026-04:3564b8c0:thinkpad-pop"
  [ "$status" -eq 0 ]
  [[ "$output" == *'"schema":"v2"'* ]]
  [[ "$output" == *'"cli":"claude"'* ]]
  [[ "$output" == *'"short_id":"3564b8c0"'* ]]
  [[ "$output" == *'"project":"dotclaude"'* ]]
  [[ "$output" == *'"month":"2026-04"'* ]]
  [[ "$output" == *'"hostname":"thinkpad-pop"'* ]]
  [[ "$output" == *'"tag":null'* ]]
}

@test "decode v2: round-trips an 8-segment string with tag" {
  run "$DESC" decode "handoff:v2:squadranks:codex:2026-04:1be89762:win-desktop:evening"
  [ "$status" -eq 0 ]
  [[ "$output" == *'"schema":"v2"'* ]]
  [[ "$output" == *'"tag":"evening"'* ]]
}

@test "decode v2: accepts gemini cli" {
  run "$DESC" decode "handoff:v2:dotclaude:gemini:2026-05:9999aaaa:thinkpad-pop:test"
  [ "$status" -eq 0 ]
  [[ "$output" == *'"schema":"v2"'* ]]
  [[ "$output" == *'"cli":"gemini"'* ]]
  [[ "$output" == *'"short_id":"9999aaaa"'* ]]
  [[ "$output" == *'"tag":"test"'* ]]
}

@test "decode v2: rejects too few segments" {
  run "$DESC" decode "handoff:v2:dotclaude:claude:2026-04:3564b8c0"
  [ "$status" -eq 2 ]
  [[ "$output" == *"malformed v2"* ]]
}

@test "decode v2: rejects too many segments" {
  run "$DESC" decode "handoff:v2:p:claude:2026-04:3564b8c0:h:t:extra"
  [ "$status" -eq 2 ]
  [[ "$output" == *"too many colon segments"* ]]
}

@test "decode v2: rejects malformed month segment" {
  run "$DESC" decode "handoff:v2:p:claude:not-a-month:3564b8c0:h"
  [ "$status" -eq 2 ]
  [[ "$output" == *"month not YYYY-MM"* ]]
}

# ---- v1 decode (legacy back-compat) -----------------------------------

@test "decode v1: round-trips a 6-segment legacy string with schema=v1 marker" {
  run "$DESC" decode "handoff:v1:claude:3564b8c0:dotclaude:thinkpad-pop"
  [ "$status" -eq 0 ]
  [[ "$output" == *'"schema":"v1"'* ]]
  [[ "$output" == *'"cli":"claude"'* ]]
  [[ "$output" == *'"short_id":"3564b8c0"'* ]]
  [[ "$output" == *'"project":"dotclaude"'* ]]
  [[ "$output" == *'"month":null'* ]]
  [[ "$output" == *'"tag":null'* ]]
}

@test "decode v1: round-trips a 7-segment legacy string with tag" {
  run "$DESC" decode "handoff:v1:codex:1be89762:squadranks:win-desktop:evening"
  [ "$status" -eq 0 ]
  [[ "$output" == *'"schema":"v1"'* ]]
  [[ "$output" == *'"tag":"evening"'* ]]
}

# ---- error paths -------------------------------------------------------

@test "decode: rejects missing handoff:v[12] prefix" {
  run "$DESC" decode "v3:claude:3564b8c0:p:h"
  [ "$status" -eq 2 ]
  [[ "$output" == *"handoff:v[12]: prefix"* ]]
}

@test "decode v1: rejects bad cli name" {
  run "$DESC" decode "handoff:v1:bogus:3564b8c0:p:h"
  [ "$status" -eq 2 ]
  [[ "$output" == *"cli not one of"* ]]
}

@test "decode v1: rejects bad short-id length" {
  run "$DESC" decode "handoff:v1:claude:3564:p:h"
  [ "$status" -eq 2 ]
  [[ "$output" == *"short-id not 8 hex chars"* ]]
}

# ---- v2 roundtrip ------------------------------------------------------

@test "roundtrip v2: encode then decode yields same fields" {
  local encoded
  encoded="$("$DESC" encode --cli claude --short-id 3564b8c0 \
    --project dotclaude --hostname pop --month 2026-04 --tag morning)"
  [ "$encoded" = "handoff:v2:dotclaude:claude:2026-04:3564b8c0:pop:morning" ]

  run "$DESC" decode "$encoded"
  [ "$status" -eq 0 ]
  [[ "$output" == *'"schema":"v2"'* ]]
  [[ "$output" == *'"cli":"claude"'* ]]
  [[ "$output" == *'"tag":"morning"'* ]]
}
