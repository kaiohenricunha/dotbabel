#!/usr/bin/env bats
# Behavior tests for plugins/dotclaude/scripts/handoff-description.sh.
# Encodes/decodes the gist description schema:
#   handoff:v1:<cli>:<short-uuid>:<project-slug>:<hostname>[:<tag>]

load helpers

DESC="$REPO_ROOT/plugins/dotclaude/scripts/handoff-description.sh"

setup() {
  [ -x "$DESC" ] || chmod +x "$DESC"
}

@test "encode: minimal args (no tag) produces expected string" {
  run "$DESC" encode \
    --cli claude --short-id 3564b8c0 \
    --project dotclaude --hostname thinkpad-pop
  [ "$status" -eq 0 ]
  [ "$output" = "handoff:v1:claude:3564b8c0:dotclaude:thinkpad-pop" ]
}

@test "encode: with tag produces 7-segment string" {
  run "$DESC" encode \
    --cli codex --short-id 1be89762 \
    --project squadranks --hostname win-desktop --tag evening
  [ "$status" -eq 0 ]
  [ "$output" = "handoff:v1:codex:1be89762:squadranks:win-desktop:evening" ]
}

@test "encode: slugifies mixed-case project with spaces and punctuation" {
  run "$DESC" encode \
    --cli claude --short-id 3564b8c0 \
    --project "Dot Claude!" --hostname "Thinkpad PopOS"
  [ "$status" -eq 0 ]
  [ "$output" = "handoff:v1:claude:3564b8c0:dot-claude:thinkpad-popos" ]
}

@test "encode: slugifies tag the same way as project/hostname" {
  run "$DESC" encode \
    --cli claude --short-id 3564b8c0 \
    --project dotclaude --hostname pop --tag "Evening Run!"
  [ "$status" -eq 0 ]
  [ "$output" = "handoff:v1:claude:3564b8c0:dotclaude:pop:evening-run" ]
}

@test "encode: rejects unknown --cli" {
  run "$DESC" encode \
    --cli bogus --short-id 3564b8c0 \
    --project p --hostname h
  [ "$status" -eq 2 ]
  [[ "$output" == *"--cli must be one of"* ]]
}

@test "encode: rejects bad short-id length" {
  run "$DESC" encode \
    --cli claude --short-id abc \
    --project p --hostname h
  [ "$status" -eq 2 ]
  [[ "$output" == *"short-id must be exactly 8 hex chars"* ]]
}

@test "encode: rejects non-hex short-id" {
  run "$DESC" encode \
    --cli claude --short-id 3564b8cZ \
    --project p --hostname h
  [ "$status" -eq 2 ]
  [[ "$output" == *"short-id must be exactly 8 hex chars"* ]]
}

@test "decode: round-trips a 6-segment string" {
  run "$DESC" decode "handoff:v1:claude:3564b8c0:dotclaude:thinkpad-pop"
  [ "$status" -eq 0 ]
  [[ "$output" == *'"cli":"claude"'* ]]
  [[ "$output" == *'"short_id":"3564b8c0"'* ]]
  [[ "$output" == *'"project":"dotclaude"'* ]]
  [[ "$output" == *'"hostname":"thinkpad-pop"'* ]]
  [[ "$output" == *'"tag":null'* ]]
}

@test "decode: round-trips a 7-segment string with tag" {
  run "$DESC" decode "handoff:v1:codex:1be89762:squadranks:win-desktop:evening"
  [ "$status" -eq 0 ]
  [[ "$output" == *'"tag":"evening"'* ]]
}

@test "decode: rejects missing handoff:v1 prefix" {
  run "$DESC" decode "v2:claude:3564b8c0:p:h"
  [ "$status" -eq 2 ]
  [[ "$output" == *"missing handoff:v1: prefix"* ]]
}

@test "decode: rejects too few segments" {
  run "$DESC" decode "handoff:v1:claude:3564b8c0:dotclaude"
  [ "$status" -eq 2 ]
  [[ "$output" == *"missing required segment"* ]]
}

@test "decode: rejects too many segments" {
  run "$DESC" decode "handoff:v1:claude:3564b8c0:p:h:t:extra"
  [ "$status" -eq 2 ]
  [[ "$output" == *"too many colon segments"* ]]
}

@test "decode: rejects bad cli name" {
  run "$DESC" decode "handoff:v1:bogus:3564b8c0:p:h"
  [ "$status" -eq 2 ]
  [[ "$output" == *"cli not one of"* ]]
}

@test "decode: rejects bad short-id length" {
  run "$DESC" decode "handoff:v1:claude:3564:p:h"
  [ "$status" -eq 2 ]
  [[ "$output" == *"short-id not 8 hex chars"* ]]
}

@test "roundtrip: encode then decode yields same fields" {
  local encoded
  encoded="$("$DESC" encode --cli claude --short-id 3564b8c0 \
    --project dotclaude --hostname pop --tag morning)"
  [ "$encoded" = "handoff:v1:claude:3564b8c0:dotclaude:pop:morning" ]

  run "$DESC" decode "$encoded"
  [ "$status" -eq 0 ]
  [[ "$output" == *'"cli":"claude"'* ]]
  [[ "$output" == *'"tag":"morning"'* ]]
}
