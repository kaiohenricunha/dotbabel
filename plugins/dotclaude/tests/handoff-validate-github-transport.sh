#!/usr/bin/env bash
# handoff-validate-github-transport.sh — end-to-end evidence harness.
#
# Proves the handoff remote transport works against a real GitHub
# gist, end-to-end, without involving an LLM. Unit-level correctness
# of the digest builder is covered by the bats suites under
# plugins/dotclaude/tests/bats/. This script tests everything the
# bats suites cannot reach: real network, real auth, real gist CRUD.
#
# Opt-in: requires `gh auth status` to be active on the host. Never
# wired into automatic CI — run manually or from an opt-in
# `make validate-handoff-remote` target.
#
# On success, appends one JSON line to
# docs/audits/handoff-remote/run-log.jsonl.
#
# Environment:
#   DOTCLAUDE_GH_TOKEN    (optional)  enables the gist-token workaround smoke test
#
# Exit codes:
#   0  all assertions passed
#   1  an assertion failed (transcript in stderr)
#   2  preflight failed (remediation block in stderr)

set -euo pipefail

# Resolve repo root from this script's location so the harness works
# regardless of cwd.
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/../../.." && pwd)"
SCRIPTS="$REPO_ROOT/plugins/dotclaude/scripts"

SCRUB="$SCRIPTS/handoff-scrub.sh"
DESC="$SCRIPTS/handoff-description.sh"
DOCTOR="$SCRIPTS/handoff-doctor.sh"

for s in "$SCRUB" "$DESC" "$DOCTOR"; do
  [[ -x "$s" ]] || { printf 'missing executable: %s\n' "$s" >&2; exit 2; }
done

# State for cleanup. The cleanup trap runs on any exit path.
GIST_ID=""
GIST_TOKEN_ID=""
FAKE_HOME=""
FAKE_HOME_2=""
WORK=""

cleanup() {
  local rc=$?
  set +e
  if [[ -n "$GIST_ID" ]]; then
    gh gist delete "$GIST_ID" --yes >/dev/null 2>&1 || true
  fi
  if [[ -n "$GIST_TOKEN_ID" ]]; then
    gh gist delete "$GIST_TOKEN_ID" --yes >/dev/null 2>&1 || true
  fi
  [[ -n "$FAKE_HOME" && -d "$FAKE_HOME" ]] && rm -rf "$FAKE_HOME"
  [[ -n "$FAKE_HOME_2" && -d "$FAKE_HOME_2" ]] && rm -rf "$FAKE_HOME_2"
  [[ -n "$WORK" && -d "$WORK" ]] && rm -rf "$WORK"
  exit "$rc"
}
trap cleanup EXIT

log() { printf '[validate] %s\n' "$*"; }
fail() { printf '[validate] FAIL: %s\n' "$*" >&2; exit 1; }

# Number of passing asserts the receipt records.
ASSERTS=0
pass() { ASSERTS=$((ASSERTS + 1)); }

# -----------------------------------------------------------------------------
# 1. Preflight
# -----------------------------------------------------------------------------
log 'step 1/12: preflight (doctor --via github)'
if ! "$DOCTOR" github; then
  printf '[validate] preflight failed — aborting\n' >&2
  exit 2
fi
GH_ACCOUNT="$(gh api user --jq .login 2>/dev/null)"
[[ -n "$GH_ACCOUNT" ]] || fail 'could not resolve authenticated GitHub account'
log "authenticated as: $GH_ACCOUNT"
pass

# -----------------------------------------------------------------------------
# 2. Synthesize fixture (synthetic claude session with a bait token)
# -----------------------------------------------------------------------------
log 'step 2/12: synthesize fixture'
BAIT_TOKEN='ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAA00000001'
WORK="$(mktemp -d)"
FAKE_HOME="$(mktemp -d)"
FAKE_HOME_2="$(mktemp -d)"
SESSION_UUID='11111111-2222-3333-4444-555555555555'
SHORT_ID='11111111'
PROJECT_SLUG='dotclaude-validate'
HOSTNAME_SLUG='test-harness'
TAG='evidence-run'

# Craft a deterministic handoff.yaml fixture with the bait token embedded
# so the scrub pass has something real to clean. This stands in for the
# skill's LLM-driven digest builder (covered by unit tests elsewhere).
cat > "$WORK/handoff.raw.yaml" <<YAML
<handoff origin="claude" session="$SHORT_ID" cwd="/tmp/fake-session">

**Summary.** Fixture handoff produced by the e2e harness. Contains the
planted token $BAIT_TOKEN to verify scrubbing on the wire.

**User prompts (verbatim, in order).**

1. please redact $BAIT_TOKEN before pushing this
2. and keep the rest of the context

**Key findings.**

- The scrubber must replace the bait token with the redacted marker.
- The remote payload must not contain $BAIT_TOKEN verbatim.

**Artifacts.**

- Files touched: /tmp/fake/session.jsonl
- Commands run: echo "noop"

**Next step.** Assert scrubbing worked on the remote.

</handoff>
YAML

# Scrub the fixture through the real scrub script. Capture the count.
SCRUB_ERR="$WORK/scrub.err"
"$SCRUB" < "$WORK/handoff.raw.yaml" > "$WORK/handoff.yaml" 2> "$SCRUB_ERR"
SCRUBBED_COUNT="$(awk -F: '$1=="scrubbed"{print $2; exit}' "$SCRUB_ERR")"
# Fixture plants the bait token in three places (summary, prompt, findings);
# assert at least one redaction happened AND the bait token is fully gone.
[[ "${SCRUBBED_COUNT:-0}" -ge 1 ]] || fail "expected scrubbed>=1 but got scrubbed:$SCRUBBED_COUNT"
grep -q "$BAIT_TOKEN" "$WORK/handoff.yaml" && fail 'scrubbed fixture still contains the bait token'
pass

# Metadata file.
CREATED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
jq -n \
  --arg cli claude \
  --arg session_id "$SESSION_UUID" \
  --arg short_id "$SHORT_ID" \
  --arg cwd /tmp/fake-session \
  --arg hostname "$(hostname -s)" \
  --arg created_at "$CREATED_AT" \
  --arg tag "$TAG" \
  --argjson scrubbed "$SCRUBBED_COUNT" \
  '{cli:$cli,session_id:$session_id,short_id:$short_id,cwd:$cwd,
    hostname:$hostname,git_remote:null,created_at:$created_at,
    scrubbed_count:$scrubbed,schema_version:"1",tag:$tag}' \
  > "$WORK/metadata.json"

# -----------------------------------------------------------------------------
# 3. Push (via gh gist create)
# -----------------------------------------------------------------------------
log 'step 3/12: push (gh gist create)'
DESCRIPTION="$("$DESC" encode \
  --cli claude --short-id "$SHORT_ID" \
  --project "$PROJECT_SLUG" --hostname "$HOSTNAME_SLUG" --tag "$TAG")"
[[ "$DESCRIPTION" == "handoff:v1:claude:$SHORT_ID:$PROJECT_SLUG:$HOSTNAME_SLUG:$TAG" ]] \
  || fail "description string malformed: $DESCRIPTION"
pass

GIST_URL="$(gh gist create --desc "$DESCRIPTION" \
  "$WORK/handoff.yaml" "$WORK/metadata.json")"
GIST_ID="$(printf '%s' "$GIST_URL" | sed -E 's#^https://gist.github.com/[^/]+/##')"
[[ "$GIST_ID" =~ ^[a-f0-9]{20,}$ ]] || fail "gist id not recognized: $GIST_ID"
log "created gist: $GIST_ID ($GIST_URL)"
pass

# -----------------------------------------------------------------------------
# 4. Assert remote state
# -----------------------------------------------------------------------------
log 'step 4/12: assert remote state'
# `gh gist view --filename X --raw` prints just the file body. Normalize
# trailing whitespace on both sides to tolerate a stray newline.
gh gist view "$GIST_ID" --filename handoff.yaml --raw > "$WORK/handoff.remote.yaml"
LOCAL_NORM="$(awk 'BEGIN{RS=""} {gsub(/[[:space:]]+$/,""); print}' "$WORK/handoff.yaml")"
REMOTE_NORM="$(awk 'BEGIN{RS=""} {gsub(/[[:space:]]+$/,""); print}' "$WORK/handoff.remote.yaml")"
if [[ "$LOCAL_NORM" != "$REMOTE_NORM" ]]; then
  # Emit a compact diff for debugging.
  diff -u "$WORK/handoff.yaml" "$WORK/handoff.remote.yaml" >&2 || true
  fail 'remote handoff.yaml does not match local (after whitespace normalization)'
fi
pass

REMOTE_META="$(gh gist view "$GIST_ID" --filename metadata.json --raw 2>/dev/null)"
REMOTE_SCRUBBED="$(printf '%s' "$REMOTE_META" | jq -r .scrubbed_count)"
[[ "$REMOTE_SCRUBBED" == "$SCRUBBED_COUNT" ]] || fail "remote scrubbed_count mismatch: $REMOTE_SCRUBBED vs $SCRUBBED_COUNT"
REMOTE_HOST="$(printf '%s' "$REMOTE_META" | jq -r .hostname)"
[[ -n "$REMOTE_HOST" && "$REMOTE_HOST" != "null" ]] || fail 'remote hostname empty'
pass

# -----------------------------------------------------------------------------
# 5. Scrubbing evidence on the wire
# -----------------------------------------------------------------------------
log 'step 5/12: scrubbing evidence (bait token MUST NOT be present)'
REMOTE_FULL="$(gh gist view "$GIST_ID")"
if printf '%s' "$REMOTE_FULL" | grep -qF "$BAIT_TOKEN"; then
  fail 'bait token leaked to gist — scrubbing did not happen on the wire'
fi
log 'bait token absent from remote — scrub verified'
pass

# -----------------------------------------------------------------------------
# 6. Pull from cold cache
# -----------------------------------------------------------------------------
log 'step 6/12: pull from cold cache'
# Simulating a second machine: run from a fresh cwd with no local session
# files. We intentionally do NOT swap HOME — gh's credentials live under
# ~/.config/gh, and a real second machine has ITS OWN auth. The thing
# we're proving is that pull reads only the gist API, not any local
# session-file state.
( cd "$FAKE_HOME_2" && gh gist view "$GIST_ID" --filename handoff.yaml --raw ) \
  > "$WORK/handoff.pulled.yaml"
[[ -s "$WORK/handoff.pulled.yaml" ]] || fail 'pull returned empty'
pass

# -----------------------------------------------------------------------------
# 7. Byte-diff pulled vs pushed
# -----------------------------------------------------------------------------
log 'step 7/12: byte-diff pulled vs pushed (whitespace-normalized)'
PULLED_NORM="$(awk 'BEGIN{RS=""} {gsub(/[[:space:]]+$/,""); print}' "$WORK/handoff.pulled.yaml")"
[[ "$LOCAL_NORM" == "$PULLED_NORM" ]] || fail 'pulled handoff.yaml does not match pushed'
pass

# -----------------------------------------------------------------------------
# 8. remote-list sanity
# -----------------------------------------------------------------------------
log 'step 8/12: remote-list sanity'
# gh gist list has no --json flag; use the REST API which returns JSON.
REMOTE_ROW="$(gh api '/gists?per_page=100' \
  | jq -r --arg id "$GIST_ID" '.[] | select(.id == $id) | .description')"
[[ "$REMOTE_ROW" == "$DESCRIPTION" ]] \
  || fail "gist not found in /gists (or description mismatch: $REMOTE_ROW)"
pass

# -----------------------------------------------------------------------------
# 9. Workaround smoke (--via gist-token) — optional
# -----------------------------------------------------------------------------
GIST_TOKEN_RESULT='skipped'
if [[ -n "${DOTCLAUDE_GH_TOKEN:-}" ]]; then
  log 'step 9/12: workaround smoke (gist-token path)'
  "$DOCTOR" gist-token >/dev/null || fail 'gist-token doctor failed'

  RESP="$(curl -fsS \
    -H "Authorization: token $DOTCLAUDE_GH_TOKEN" \
    -H "Accept: application/vnd.github+json" \
    -X POST https://api.github.com/gists \
    -d "$(jq -n --arg desc "$DESCRIPTION-tok" \
                 --arg handoff "$(cat "$WORK/handoff.yaml")" \
                 --arg meta "$(cat "$WORK/metadata.json")" \
                 '{description:$desc, public:false,
                   files:{"handoff.yaml":{content:$handoff},
                          "metadata.json":{content:$meta}}}')")"
  GIST_TOKEN_ID="$(printf '%s' "$RESP" | jq -r .id)"
  [[ "$GIST_TOKEN_ID" =~ ^[a-f0-9]{20,}$ ]] || fail "gist-token push did not return valid id: $GIST_TOKEN_ID"

  TOK_PULL="$(curl -fsS -H "Authorization: token $DOTCLAUDE_GH_TOKEN" \
    "https://api.github.com/gists/$GIST_TOKEN_ID" \
    | jq -r '.files["handoff.yaml"].content')"
  [[ "$TOK_PULL" == "$(cat "$WORK/handoff.yaml")" ]] \
    || fail 'gist-token pulled content != pushed'
  GIST_TOKEN_RESULT='pass'
  pass
else
  log 'step 9/12: gist-token workaround skipped (DOTCLAUDE_GH_TOKEN unset)'
fi

# -----------------------------------------------------------------------------
# 10. Cleanup happens in trap; logged here for traceability.
# -----------------------------------------------------------------------------
log 'step 10/12: cleanup deferred to trap'

# -----------------------------------------------------------------------------
# 11. Receipt
# -----------------------------------------------------------------------------
log 'step 11/12: write receipt'
RECEIPT_FILE="$REPO_ROOT/docs/audits/handoff-remote/run-log.jsonl"
mkdir -p "$(dirname "$RECEIPT_FILE")"
jq -cn \
  --arg ts "$CREATED_AT" \
  --arg acct "$GH_ACCOUNT" \
  --arg gid "$GIST_ID" \
  --arg tokpath "$GIST_TOKEN_RESULT" \
  --argjson asserts "$ASSERTS" \
  --argjson scrubbed "$SCRUBBED_COUNT" \
  '{timestamp:$ts, gh_account:$acct, gist_id:$gid,
    asserts_passed:$asserts, scrubbed_count:$scrubbed,
    gist_token_path:$tokpath, result:"pass"}' \
  >> "$RECEIPT_FILE"
log "receipt appended: $RECEIPT_FILE"

# -----------------------------------------------------------------------------
# 12. Done
# -----------------------------------------------------------------------------
log "step 12/12: pass ($ASSERTS asserts)"
