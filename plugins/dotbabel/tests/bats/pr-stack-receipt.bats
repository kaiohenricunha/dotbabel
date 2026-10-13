#!/usr/bin/env bats
# pr-stack-receipt.bats — `pr-stack record` and `pr-stack receipt`.
#
# The pure receipt logic is unit-tested in run-receipt.test.mjs. This file
# covers the half that touches the world: where the file lands, that every
# worktree of one repository extends the same history, that a gh outage or a
# damaged file never overwrites what is already recorded, and where the
# requested model is read from.

load helpers

BIN="$REPO_ROOT/plugins/dotbabel/bin/dotbabel-pr-stack.mjs"

setup() {
  REPO="$(make_tmp_git_repo)"
  TMP_HOME="$(make_tmp_home)"
  export HOME="$TMP_HOME"
  cd "$REPO"
  HEAD_SHA="$(git rev-parse HEAD)"
  RECEIPT="$REPO/.git/dotbabel/receipts/pr-42.json"
  stub_gh_view
}

teardown() {
  [ -n "${REPO:-}" ] && rm -rf "$REPO" "$REPO-bare.git" "$REPO-wt" 2>/dev/null || true
  rm_tmp_home "${TMP_HOME:-}"
}

# Stub gh so `pr view <N> --json headRefOid,baseRefName` names the repo HEAD.
stub_gh_view() {
  with_fake_tool_bin gh "
    case \"\$*\" in
      *'--json headRefOid,baseRefName'*) printf '{\"headRefOid\":\"%s\",\"baseRefName\":\"main\"}' '$HEAD_SHA'; exit 0 ;;
    esac
    exit 0
  " >/dev/null
}

@test "pr-stack record: writes the first attempt under the git common directory" {
  run node "$BIN" record --pr 42 --phase pre-pr --outcome pass --json
  [ "$status" -eq 0 ]
  [ -f "$RECEIPT" ]
  run jq -r '.attempts[0] | [.phase, .n, .outcome, .head_sha, .base_ref, .merge_base] | join(" ")' "$RECEIPT"
  [ "$output" = "pre-pr 1 pass $HEAD_SHA main $HEAD_SHA" ]
  # The working tree stays clean: local-attest and criteria verify require it.
  [ -z "$(git status --porcelain)" ]
}

@test "pr-stack record: a second attempt of one phase is appended, never replaces the first" {
  node "$BIN" record --pr 42 --phase review-pr --outcome fail --reason CRITERIA_FAILED >/dev/null
  run node "$BIN" record --pr 42 --phase review-pr --outcome pass
  [ "$status" -eq 0 ]
  run jq -r '[.attempts[] | "\(.n):\(.outcome):\(.reason_code)"] | join(",")' "$RECEIPT"
  [ "$output" = "1:fail:CRITERIA_FAILED,2:pass:null" ]
}

@test "pr-stack record: a linked worktree extends the same receipt" {
  node "$BIN" record --pr 42 --phase pre-pr --outcome pass >/dev/null
  git worktree add -q "$REPO-wt" -b other
  (cd "$REPO-wt" && node "$BIN" record --pr 42 --phase review-pr --outcome pass >/dev/null)
  run jq -r '[.attempts[].phase] | join(",")' "$RECEIPT"
  [ "$output" = "pre-pr,review-pr" ]
}

@test "pr-stack record: keeps every --evidence link" {
  run node "$BIN" record --pr 42 --phase local-attest --outcome pass --evidence https://x/1 --evidence https://x/2
  [ "$status" -eq 0 ]
  run jq -r '.attempts[0].evidence | join(",")' "$RECEIPT"
  [ "$output" = "https://x/1,https://x/2" ]
}

@test "pr-stack record: an unknown phase or outcome is a usage error and writes nothing" {
  run node "$BIN" record --pr 42 --phase deploy --outcome pass
  [ "$status" -eq 64 ]
  run node "$BIN" record --pr 42 --phase pre-pr --outcome maybe
  [ "$status" -eq 64 ]
  run node "$BIN" record --pr 42 --phase pre-pr --outcome fail --reason 'not a code'
  [ "$status" -eq 64 ]
  [ ! -f "$RECEIPT" ]
}

@test "pr-stack record: a gh failure without --sha is an env error and writes nothing" {
  with_fake_tool_bin gh 'echo "gh: not authenticated" >&2; exit 1' >/dev/null
  run node "$BIN" record --pr 42 --phase pre-pr --outcome pass
  [ "$status" -eq 2 ]
  [ ! -f "$RECEIPT" ]
}

@test "pr-stack record: --sha records without gh, with no base it cannot know" {
  with_fake_tool_bin gh 'exit 1' >/dev/null
  run node "$BIN" record --pr 42 --phase pre-pr --outcome pass --sha "$HEAD_SHA"
  [ "$status" -eq 0 ]
  run jq -r '.attempts[0] | "\(.head_sha) \(.base_ref) \(.merge_base)"' "$RECEIPT"
  [ "$output" = "$HEAD_SHA null null" ]
}

@test "pr-stack record: a damaged receipt is an env error and is left as it was" {
  mkdir -p "$(dirname "$RECEIPT")"
  printf '{"schema_version": 9}' > "$RECEIPT"
  run node "$BIN" record --pr 42 --phase pre-pr --outcome pass
  [ "$status" -eq 2 ]
  [[ "$output" == *"schema_version"* ]]
  [ "$(cat "$RECEIPT")" = '{"schema_version": 9}' ]
}

@test "pr-stack record: requested_model comes from the project skill's frontmatter" {
  mkdir -p .claude/skills/post-pr-review
  printf -- '---\nid: post-pr-review\nmodel: opus\n---\nbody\n' > .claude/skills/post-pr-review/SKILL.md
  run node "$BIN" record --pr 42 --phase post-pr-review --outcome pass --sha "$HEAD_SHA"
  [ "$status" -eq 0 ]
  run jq -r '.attempts[0].requested_model' "$RECEIPT"
  [ "$output" = "opus" ]
}

@test "pr-stack record: a personal skill wins over the project copy, as Claude Code loads them" {
  mkdir -p "$HOME/.claude/skills/review-pr" .claude/skills/review-pr
  printf -- '---\nmodel: haiku\n---\n' > "$HOME/.claude/skills/review-pr/SKILL.md"
  printf -- '---\nmodel: opus\n---\n' > .claude/skills/review-pr/SKILL.md
  run node "$BIN" record --pr 42 --phase review-pr --outcome pass --sha "$HEAD_SHA"
  [ "$status" -eq 0 ]
  [ "$(jq -r '.attempts[0].requested_model' "$RECEIPT")" = "haiku" ]
}

@test "pr-stack record: a copy that names no model falls through to the next one" {
  mkdir -p "$HOME/.claude/skills/review-pr" .claude/skills/review-pr
  printf -- '---\nid: review-pr\n---\n' > "$HOME/.claude/skills/review-pr/SKILL.md"
  printf -- '---\nmodel: opus\n---\n' > .claude/skills/review-pr/SKILL.md
  run node "$BIN" record --pr 42 --phase review-pr --outcome pass --sha "$HEAD_SHA"
  [ "$status" -eq 0 ]
  [ "$(jq -r '.attempts[0].requested_model' "$RECEIPT")" = "opus" ]
}

@test "pr-stack record: requested_model falls back to the bootstrapped ~/.claude copy" {
  mkdir -p "$HOME/.claude/skills/review-pr"
  printf -- '---\nmodel: sonnet\n---\n' > "$HOME/.claude/skills/review-pr/SKILL.md"
  run node "$BIN" record --pr 42 --phase review-pr --outcome pass --sha "$HEAD_SHA"
  [ "$status" -eq 0 ]
  run jq -r '.attempts[0].requested_model' "$RECEIPT"
  [ "$output" = "sonnet" ]
}

@test "pr-stack receipt: no receipt yet is not an error" {
  run node "$BIN" receipt --pr 42
  [ "$status" -eq 0 ]
  [[ "$output" == *"no receipt"* ]]
}

@test "pr-stack record: a --sha that disagrees with the pull request head is refused" {
  OTHER="$(git commit -q --allow-empty -m other && git rev-parse HEAD)"
  run node "$BIN" record --pr 42 --phase local-attest --outcome pass --sha "$OTHER"
  [ "$status" -eq 64 ]
  [[ "$output" == *"not the head of #42"* ]]
  [ ! -f "$RECEIPT" ]
}

@test "pr-stack record: a --sha that is not a commit here is refused when gh cannot answer" {
  with_fake_tool_bin gh 'exit 1' >/dev/null
  run node "$BIN" record --pr 42 --phase pre-pr --outcome pass --sha "$(printf 'd%.0s' {1..40})"
  [ "$status" -eq 64 ]
  [ ! -f "$RECEIPT" ]
}

@test "pr-stack record: an empty --evidence link is a usage error and writes nothing" {
  run node "$BIN" record --pr 42 --phase pre-pr --outcome pass --evidence ""
  [ "$status" -eq 64 ]
  [ ! -f "$RECEIPT" ]
}

@test "pr-stack record and receipt: a non-JSON receipt is an env error and is left as it was" {
  mkdir -p "$(dirname "$RECEIPT")"
  printf 'not json' > "$RECEIPT"
  run node "$BIN" record --pr 42 --phase pre-pr --outcome pass
  [ "$status" -eq 2 ]
  run node "$BIN" receipt --pr 42
  [ "$status" -eq 2 ]
  [ "$(cat "$RECEIPT")" = "not json" ]
}

@test "pr-stack receipt: a receipt for another pull request is an env error" {
  node "$BIN" record --pr 42 --phase pre-pr --outcome pass >/dev/null
  jq '.pr = 7' "$RECEIPT" > "$RECEIPT.x" && mv "$RECEIPT.x" "$RECEIPT"
  run node "$BIN" receipt --pr 42
  [ "$status" -eq 2 ]
  [[ "$output" == *"#42"* ]]
}

@test "pr-stack record: a held lock is an env error; a stale one is cleared" {
  mkdir -p "$RECEIPT.lock"
  run node "$BIN" record --pr 42 --phase pre-pr --outcome pass
  [ "$status" -eq 2 ]
  [[ "$output" == *"lock"* ]]
  touch -d '10 minutes ago' "$RECEIPT.lock"
  run node "$BIN" record --pr 42 --phase pre-pr --outcome pass
  [ "$status" -eq 0 ]
  [ ! -d "$RECEIPT.lock" ]
}

@test "pr-stack receipt: a stop pass after every phase passed on the head reads ready" {
  for phase in pre-pr post-pr-review review-pr local-attest stop; do
    node "$BIN" record --pr 42 --phase "$phase" --outcome pass >/dev/null
  done
  run node "$BIN" receipt --pr 42 --json
  [ "$status" -eq 0 ]
  [ "$(printf '%s' "$output" | jq -r '.result.verdict')" = "ready" ]
}

@test "pr-stack receipt: reports the verdict, per-phase counts, and the rollback point" {
  node "$BIN" record --pr 42 --phase pre-pr --outcome pass >/dev/null
  node "$BIN" record --pr 42 --phase review-pr --outcome fail --reason CRITERIA_FAILED >/dev/null
  run node "$BIN" receipt --pr 42 --json
  [ "$status" -eq 0 ]
  [ "$(printf '%s' "$output" | jq -r '.result.verdict')" = "blocked" ]
  [ "$(printf '%s' "$output" | jq -r '.result.phases["review-pr"].consecutive_failures')" = "1" ]
  [ "$(printf '%s' "$output" | jq -r '.result.rollback.merge_base')" = "$HEAD_SHA" ]
  run node "$BIN" receipt --pr 42
  [[ "$output" == *"receipt #42: blocked"* ]]
  [[ "$output" == *"review-pr: 1 attempt(s), last fail (CRITERIA_FAILED), 1 failed in a row"* ]]
}
