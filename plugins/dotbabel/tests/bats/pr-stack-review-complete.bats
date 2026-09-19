#!/usr/bin/env bats
# pr-stack-review-complete.bats — the bin's wiring for review-complete evidence
# (P-G6): the `review-complete` subcommand, and the entry phase it lets `entry`
# derive.
#
# The judgment itself (what counts as a finished review, which comments are
# believed) is unit-tested against injected dependencies. This file covers what
# those tests cannot: that the bin dispatches the subcommand, reads real git
# history for ancestry, exits with the documented codes, and degrades to the
# conservative entry when evidence cannot be read.

load helpers

BIN="$REPO_ROOT/plugins/dotbabel/bin/dotbabel-pr-stack.mjs"
SRC="$REPO_ROOT/plugins/dotbabel/src"

setup() {
  REPO="$(make_tmp_git_repo)"
  cd "$REPO"
  git commit -q --allow-empty -m "c1"
  C1="$(git rev-parse HEAD)"
  git commit -q --allow-empty -m "c2"
  C2="$(git rev-parse HEAD)"
  git commit -q --allow-empty -m "c3"
  C3="$(git rev-parse HEAD)"
  # An unrelated history: a receipt posted against it must not count.
  ELSEWHERE="$(git commit-tree "$(git hash-object -t tree /dev/null)" -m elsewhere)"
  FIX="$BATS_TEST_TMPDIR/fix"
  mkdir -p "$FIX"
  export FIX C1 C2 C3 ELSEWHERE
}

teardown() {
  [ -n "${REPO:-}" ] && rm -rf "$REPO" "$REPO-bare.git" 2>/dev/null || true
}

# --- fixtures ---------------------------------------------------------------

# Write a GraphQL connection page: $1 field, $2 file, remaining: node JSON.
write_page() {
  local field="$1" file="$2"; shift 2
  node --input-type=module -e '
    const [field, file, ...nodes] = process.argv.slice(1);
    const page = { data: { repository: { pullRequest: { [field]: {
      pageInfo: { hasNextPage: false, endCursor: null },
      nodes: nodes.map((n) => JSON.parse(n)),
    } } } } };
    (await import("node:fs")).writeFileSync(file, JSON.stringify(page));
  ' "$field" "$file" "$@"
}

# Install the fake gh. Everything it serves comes from $FIX.
install_gh() {
  with_fake_tool_bin gh '
    case "$*" in
      *"pr view 42 --json headRefOid,state"*) cat "$FIX/view.json"; exit 0 ;;
      *"pr view 42 --json headRefOid --jq"*) cat "$FIX/head.txt"; exit 0 ;;
      *"pr view 42 --json body,mergeable"*) cat "$FIX/mergeview.json"; exit 0 ;;
      *"pr view --json number,state"*) printf "{\"number\":42,\"state\":\"OPEN\"}"; exit 0 ;;
      *"repo view --json nameWithOwner"*) echo o/r; exit 0 ;;
      *"api user"*) echo kaio; exit 0 ;;
      *"/files --paginate"*) exit 0 ;;
      *"comments --paginate"*) echo "[]"; exit 0 ;;
      *"reviewThreads(first"*) cat "$FIX/threads.json"; exit 0 ;;
      *"reviews(first"*) cat "$FIX/reviews.json"; exit 0 ;;
      *"comments(first"*) cat "$FIX/comments.json"; exit 0 ;;
      *"--method POST"*"issues/42/comments"*) cat > "$FIX/posted.json"; exit 0 ;;
    esac
    echo "unexpected gh call: $*" >&2
    exit 9
  ' >/dev/null
}

# Serve a healthy pull request: head $C3, a receipt for $C2, all findings resolved.
healthy() {
  printf '{"headRefOid":"%s","state":"OPEN"}' "$C3" > "$FIX/view.json"
  printf '%s\n' "$C3" > "$FIX/head.txt"
  printf '{"body":"","mergeable":"MERGEABLE","mergeStateStatus":"CLEAN","files":[],"changedFiles":0,"headRefOid":"%s","baseRefOid":"%s"}' "$C3" "$C1" > "$FIX/mergeview.json"
  receipt "$C2"
  write_page reviewThreads "$FIX/threads.json" '{"isResolved":true,"comments":{"nodes":[{"body":"fixed"}]}}'
  write_page comments "$FIX/comments.json"
  install_gh
}

# A trusted, unedited post-pr-review receipt posted against commit $1.
receipt() {
  local marker
  marker="$(node --input-type=module -e "import { POST_PR_REVIEW_RECEIPT_MARKER as m } from '$SRC/review-evidence.mjs'; process.stdout.write(m)")"
  write_page reviews "$FIX/reviews.json" \
    "$(node -e 'process.stdout.write(JSON.stringify({body: process.argv[1] + "\npost-pr-review: 1 posted", authorAssociation: "OWNER", lastEditedAt: null, commit: {oid: process.argv[2]}}))' "$marker" "$1")"
}

# --- review-complete --------------------------------------------------------

@test "review-complete: a dry run on a healthy pull request checks everything and posts nothing" {
  healthy
  run node "$BIN" review-complete --pr 42 --dry-run
  [ "$status" -eq 0 ]
  [[ "$output" == *"review-complete: DRY-RUN"* ]]
  [[ "$output" == *"head ${C3:0:8}, reviewed ${C2:0:8}"* ]]
  [ ! -e "$FIX/posted.json" ]
}

@test "review-complete: posts one comment naming the head, which the reader then accepts" {
  healthy
  run node "$BIN" review-complete --pr 42
  [ "$status" -eq 0 ]
  [[ "$output" == *"review-complete: POSTED"* ]]
  [ -f "$FIX/posted.json" ]
  run node --input-type=module -e "
    import { readFileSync } from 'node:fs';
    import { evaluateReviewEvidence, REVIEW_MARKER_PREFIX } from '$SRC/review-evidence.mjs';
    const { body } = JSON.parse(readFileSync('$FIX/posted.json', 'utf8'));
    if (body.split('\n')[0] !== REVIEW_MARKER_PREFIX + '$C3' + ' -->') throw new Error('line 1: ' + body.split('\n')[0]);
    const r = evaluateReviewEvidence({ comments: [{ body, authorAssociation: 'OWNER', lastEditedAt: null }], headSha: '$C3' });
    if (r.state !== 'reviewed') throw new Error(JSON.stringify(r));
  "
  [ "$status" -eq 0 ]
}

@test "review-complete: refuses, with exit 1 and the reason code, when there is no receipt" {
  healthy
  write_page reviews "$FIX/reviews.json"
  run node "$BIN" review-complete --pr 42
  [ "$status" -eq 1 ]
  [[ "$output" == *"review-complete: BLOCKED"* ]]
  [[ "$output" == *"REVIEW_NO_RECEIPT"* ]]
  [ ! -e "$FIX/posted.json" ]
}

@test "review-complete: refuses a receipt for a commit outside this history" {
  healthy
  receipt "$ELSEWHERE"
  run node "$BIN" review-complete --pr 42
  [ "$status" -eq 1 ]
  [[ "$output" == *"REVIEW_NO_RECEIPT"* ]]
  [ ! -e "$FIX/posted.json" ]
}

@test "review-complete: refuses while a finding the review posted is still open" {
  healthy
  write_page reviewThreads "$FIX/threads.json" \
    '{"isResolved":false,"comments":{"nodes":[{"body":"fix <!-- post-pr-review:v1:0123456789abcdef -->"}]}}'
  run node "$BIN" review-complete --pr 42
  [ "$status" -eq 1 ]
  [[ "$output" == *"REVIEW_FINDINGS_OPEN"* ]]
  [ ! -e "$FIX/posted.json" ]
}

@test "review-complete: an open advisory thread does not block" {
  healthy
  write_page reviewThreads "$FIX/threads.json" \
    '{"isResolved":false,"comments":{"nodes":[{"body":"advisory: this test asserts nothing"}]}}'
  run node "$BIN" review-complete --pr 42 --dry-run
  [ "$status" -eq 0 ]
  [[ "$output" == *"1 other open thread"* ]]
}

@test "review-complete: a pull request that is not open is refused" {
  healthy
  printf '{"headRefOid":"%s","state":"MERGED"}' "$C3" > "$FIX/view.json"
  run node "$BIN" review-complete --pr 42
  [ "$status" -eq 1 ]
  [[ "$output" == *"REVIEW_PR_NOT_OPEN"* ]]
}

@test "review-complete: a gh failure is an environment error, never a verdict" {
  healthy
  with_fake_tool_bin gh 'echo "gh: not logged in" >&2; exit 1' >/dev/null
  run node "$BIN" review-complete --pr 42
  [ "$status" -eq 2 ]
  [[ "$output" == *"not logged in"* ]]
}

@test "review-complete: --pr is required and must be a positive integer" {
  healthy
  run node "$BIN" review-complete
  [ "$status" -eq 64 ]
  run node "$BIN" review-complete --pr nonsense
  [ "$status" -eq 64 ]
}

@test "review-complete: --json carries the reasons and never posts on a refusal" {
  healthy
  write_page reviews "$FIX/reviews.json"
  run node "$BIN" review-complete --pr 42 --json
  [ "$status" -eq 1 ]
  [[ "$output" == *'"subcommand": "review-complete"'* ]]
  [[ "$output" == *'"posted": false'* ]]
  [[ "$output" == *'"code": "REVIEW_NO_RECEIPT"'* ]]
}

# --- entry: what the evidence lets the conductor skip -----------------------

# Write the comments the entry command will find for head $C3.
#   $1: review | none    $2: attest | none    $3: the commit the review names (default $C3)
entry_comments() {
  node --input-type=module -e '
    const [src, head, review, attest, reviewSha, file] = process.argv.slice(1);
    const r = await import(src + "/review-evidence.mjs");
    const a = await import(src + "/attestation.mjs");
    const nodes = [];
    const owner = (body) => ({ body, authorAssociation: "OWNER", lastEditedAt: null, author: { login: "kaio" } });
    if (review === "review") {
      nodes.push(owner(r.renderReviewComment(r.buildReviewPayload({
        headSha: reviewSha, reviewedSha: head, findings: { posted: 0, unresolved: 0 },
      }))));
    }
    if (attest === "attest") {
      nodes.push(owner(a.renderAttestationHeader(a.buildAttestationPayload({
        headSha: head, legs: [{ name: "test", mode: "hard", status: "pass" }],
      }))));
    }
    const page = { data: { repository: { pullRequest: { comments: {
      pageInfo: { hasNextPage: false, endCursor: null }, nodes } } } } };
    (await import("node:fs")).writeFileSync(file, JSON.stringify(page));
  ' "$SRC" "$C3" "$1" "$2" "${3:-$C3}" "$FIX/comments.json"
}

@test "entry: a head that was reviewed and attested stops at the hand-off" {
  healthy
  entry_comments review attest
  run node "$BIN" entry --pr 42 --json
  [ "$status" -eq 0 ]
  [[ "$output" == *'"phase": "stop"'* ]]
  [[ "$output" == *'"reason": "REVIEWED_AND_ATTESTED"'* ]]
}

@test "entry: a head that was reviewed but not attested resumes at local-attest" {
  healthy
  entry_comments review none
  run node "$BIN" entry --pr 42 --json
  [ "$status" -eq 0 ]
  [[ "$output" == *'"phase": "local-attest"'* ]]
  [[ "$output" == *'"reason": "REVIEWED_AT_HEAD"'* ]]
}

@test "entry: an attestation alone never skips the review" {
  # The invariant the whole design rests on. Somebody can run local-attest
  # directly; that proves the matrix passed and says nothing about review.
  healthy
  entry_comments none attest
  run node "$BIN" entry --pr 42 --json
  [ "$status" -eq 0 ]
  [[ "$output" == *'"phase": "pre-pr"'* ]]
  [[ "$output" == *'"reason": "PR_OPEN"'* ]]
  [[ "$output" == *'"attestedAtHead": true'* ]]
  [[ "$output" == *'"reviewedAtHead": false'* ]]
}

@test "entry: a review that names an older head does not count" {
  healthy
  entry_comments review attest "$C1"
  run node "$BIN" entry --pr 42 --json
  [ "$status" -eq 0 ]
  [[ "$output" == *'"reason": "PR_OPEN"'* ]]
  [[ "$output" == *"REVIEW_STALE"* ]]
}

@test "entry: evidence that cannot be read degrades to PR_OPEN instead of failing" {
  healthy
  printf '' > "$FIX/head.txt"
  run node "$BIN" entry --pr 42 --json
  [ "$status" -eq 0 ]
  [[ "$output" == *'"reason": "PR_OPEN"'* ]]
  [[ "$output" == *"head SHA could not be read"* ]]
}

@test "entry: the human output says what each piece of evidence found" {
  healthy
  entry_comments review none
  run node "$BIN" entry --pr 42
  [ "$status" -eq 0 ]
  [[ "$output" == *"entry: local-attest (REVIEWED_AT_HEAD)"* ]]
  [[ "$output" == *"review: complete on this head"* ]]
  [[ "$output" == *"attestation: none on this head"* ]]
}
