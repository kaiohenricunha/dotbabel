#!/usr/bin/env bash
# output.sh — shared ✓/✗/⚠ helpers for every harness shell script.
#
# Gold-standard originates from plugins/dotclaude/scripts/validate-settings.sh:43-45.
# Every consumer should:
#
#   # shellcheck source=plugins/dotclaude/scripts/lib/output.sh
#   source "$(dirname "${BASH_SOURCE[0]}")/lib/output.sh"
#   out_init            # sets G/R/Y/N + FAIL/WARN globals, honors --json + NO_COLOR
#   pass "JSON well-formed"
#   fail "SEC-2 skipDangerousModePermissionPrompt is set"
#   warn "projects/ close to budget"
#   out_summary         # prints "Summary: N failure(s), N warning(s)"
#
# When DOTCLAUDE_JSON=1 is set, pass/fail/warn buffer JSON objects with the shape
#   { "check": "...", "category": "...", "status": "pass|fail|warn", "message": "..." }
# into DOTCLAUDE_JSON_BUFFER; callers flush with `out_flush`. The `category`
# defaults to the CATEGORY env; individual calls can override with the
# two-argument form: `fail SEC-2 "skipDangerous... is set"`.

# Shell-scoped globals are set by out_init. Declaring defaults here keeps
# callers working even if they forget out_init and lets linters see the
# assignments.
FAIL=${FAIL:-0}
WARN=${WARN:-0}
G=""; R=""; Y=""; N=""
DOTCLAUDE_JSON=${DOTCLAUDE_JSON:-0}
DOTCLAUDE_JSON_BUFFER=""
# shellcheck disable=SC2034  # CATEGORY is consumed by sourced scripts
CATEGORY=${CATEGORY:-general}

out_init() {
  FAIL=0
  WARN=0
  DOTCLAUDE_JSON_BUFFER=""
  if [ "${DOTCLAUDE_JSON:-0}" = "1" ] || [ "${NO_COLOR:-}" != "" ] || [ ! -t 1 ]; then
    G=""; R=""; Y=""; N=""
  else
    G=$'\033[32m'; R=$'\033[31m'; Y=$'\033[33m'; N=$'\033[0m'
  fi
}

# Internal: buffer one JSON object. Escapes the double-quotes and backslashes in $message.
_out_json_push() {
  local status="$1" check="$2" message="$3"
  local cat="${4:-$CATEGORY}"
  # Escape backslash then double-quote for safe JSON inclusion.
  message=${message//\\/\\\\}
  message=${message//\"/\\\"}
  check=${check//\\/\\\\}
  check=${check//\"/\\\"}
  local entry
  entry=$(printf '{"check":"%s","category":"%s","status":"%s","message":"%s"}' \
    "$check" "$cat" "$status" "$message")
  if [ -z "$DOTCLAUDE_JSON_BUFFER" ]; then
    DOTCLAUDE_JSON_BUFFER="$entry"
  else
    DOTCLAUDE_JSON_BUFFER="$DOTCLAUDE_JSON_BUFFER,$entry"
  fi
}

pass() {
  local msg="$1"
  if [ "${DOTCLAUDE_JSON:-0}" = "1" ]; then
    _out_json_push pass "${2:-$msg}" "$msg"
  else
    printf '  %s✓%s %s\n' "$G" "$N" "$msg"
  fi
}

fail() {
  local msg="$1"
  FAIL=$((FAIL+1))
  if [ "${DOTCLAUDE_JSON:-0}" = "1" ]; then
    _out_json_push fail "${2:-$msg}" "$msg"
  else
    printf '  %s✗%s %s\n' "$R" "$N" "$msg"
  fi
}

warn() {
  local msg="$1"
  WARN=$((WARN+1))
  if [ "${DOTCLAUDE_JSON:-0}" = "1" ]; then
    _out_json_push warn "${2:-$msg}" "$msg"
  else
    printf '  %s⚠%s %s\n' "$Y" "$N" "$msg"
  fi
}

out_flush() {
  if [ "${DOTCLAUDE_JSON:-0}" = "1" ]; then
    printf '{"events":[%s],"counts":{"fail":%d,"warn":%d}}\n' \
      "$DOTCLAUDE_JSON_BUFFER" "$FAIL" "$WARN"
  fi
}

out_summary() {
  if [ "${DOTCLAUDE_JSON:-0}" = "1" ]; then
    out_flush
  else
    echo
    echo "Summary: $FAIL failure(s), $WARN warning(s)"
  fi
}
