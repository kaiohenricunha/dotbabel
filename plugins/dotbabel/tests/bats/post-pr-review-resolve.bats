#!/usr/bin/env bats
# Resolution invariants for post-pr-review-resolve.sh — step 1 of the
# /post-pr-review skill, and the only one of its scripts that shipped without
# a test.
#
# It requested a `baseRepository` JSON field that `gh pr view` does not
# support, so every invocation failed; `2>/dev/null` then masked the real
# "Unknown JSON field" error behind a misleading {"error":"PR not found"}.
# The fake gh here rejects unknown --json fields exactly as the real binary
# does, which is what makes that class of bug detectable at all.

load helpers

SCRIPT="$REPO_ROOT/plugins/dotbabel/scripts/post-pr-review-resolve.sh"

# Fields the real `gh pr view --json` accepts (subset we care about).
# Anything requested outside this set makes the shim fail like gh does.
FAKE_GH_STRICT='
KNOWN="number headRefOid state isDraft headRepository headRepositoryOwner isCrossRepository url title body files mergeable mergeStateStatus baseRefName nameWithOwner owner name"
sub="$1"; shift
fields=""
while [ $# -gt 0 ]; do
  case "$1" in
    --json) fields="$2"; shift 2 ;;
    *) shift ;;
  esac
done
if [ -n "$fields" ]; then
  IFS=, read -ra REQ <<< "$fields"
  for f in "${REQ[@]}"; do
    case " $KNOWN " in
      *" $f "*) ;;
      *) echo "Unknown JSON field: \"$f\"" >&2; exit 1 ;;
    esac
  done
fi
if [ "$sub" = "repo" ]; then
  echo "kaiohenricunha/dotbabel"
  exit 0
fi
cat <<JSON
{"number":278,"headRefOid":"42b2cff0e68054a9a21c722ae3880c0d2d2dd42b","state":"OPEN","isDraft":false,"headRepository":{"name":"dotbabel"},"isCrossRepository":false,"url":"https://github.com/kaiohenricunha/dotbabel/pull/278"}
JSON
'

setup() {
  [ -x "$SCRIPT" ] || chmod +x "$SCRIPT"
}

@test "resolve: requests only JSON fields gh actually supports" {
  with_fake_tool_bin gh "$FAKE_GH_STRICT" >/dev/null
  run "$SCRIPT" 278
  [ "$status" -eq 0 ]
  echo "$output" | jq -e '.number == 278' >/dev/null
}

@test "resolve: emits the baseRepository the skill binds REPO from" {
  with_fake_tool_bin gh "$FAKE_GH_STRICT" >/dev/null
  run "$SCRIPT" 278
  [ "$status" -eq 0 ]
  repo="$(echo "$output" | jq -r '"\(.baseRepository.owner.login)/\(.baseRepository.name)"')"
  [ "$repo" = "kaiohenricunha/dotbabel" ]
}

@test "resolve: honors an explicit --repo without a second lookup" {
  with_fake_tool_bin gh "$FAKE_GH_STRICT" >/dev/null
  run "$SCRIPT" 278 --repo other/project
  [ "$status" -eq 0 ]
  repo="$(echo "$output" | jq -r '"\(.baseRepository.owner.login)/\(.baseRepository.name)"')"
  [ "$repo" = "other/project" ]
}

@test "resolve: preserves the documented output keys" {
  with_fake_tool_bin gh "$FAKE_GH_STRICT" >/dev/null
  run "$SCRIPT" 278
  [ "$status" -eq 0 ]
  for k in number headRefOid state isDraft headRepository baseRepository isCrossRepository url; do
    echo "$output" | jq -e "has(\"$k\")" >/dev/null || {
      echo "missing documented key: $k"
      return 1
    }
  done
}

@test "resolve: surfaces gh's real error instead of masking it as 'PR not found'" {
  with_fake_tool_bin gh '
    # auth must succeed, or the script exits 2 before it ever calls pr view.
    if [ "$1" = "auth" ]; then exit 0; fi
    echo "GraphQL: Could not resolve to a PullRequest with the number of 999999." >&2
    exit 1
  ' >/dev/null
  run "$SCRIPT" 999999
  [ "$status" -eq 1 ]
  [[ "$output" == *"Could not resolve to a PullRequest"* ]]
}

@test "resolve: exits 2 when gh is not authenticated" {
  with_fake_tool_bin gh '
    if [ "$1" = "auth" ]; then exit 1; fi
    exit 0
  ' >/dev/null
  run "$SCRIPT" 278
  [ "$status" -eq 2 ]
}
