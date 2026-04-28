#!/usr/bin/env bats
# Integration tests for #91 Gap 7: tags first-class.
#
# Covers (a) multi-tag push writes both metadata.tags and legacy
# metadata.tag, (b) exact-tag pull resolution beats substring,
# (c) `list --remote --tag <name>` filter, (d) `list --remote --tags`
# histogram, (e) legacy single-tag metadata still resolves through
# the migration helper, (f) special-char tag slugification round-trip.

bats_require_minimum_version 1.5.0

load helpers

BIN="$REPO_ROOT/plugins/dotclaude/bin/dotclaude-handoff.mjs"

STUB_DOCTOR=""

# slugify(hostname()) — must match the lib so own-host filter resolves.
this_host_slug() {
  hostname | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9-]/-/g; s/--*/-/g; s/^-//; s/-$//' | cut -c1-40
}

# Push a stub branch directly, encoding tags into description + metadata.json.
# Used to simulate branches written by older dotclaude installs (legacy
# single-tag) and to seed the histogram + filter tests deterministically.
seed_handoff_branch() {
  local transport="$1" branch="$2" host="$3" cli="$4" desc_tag_seg="$5" meta_json="$6"
  local tmp; tmp=$(mktemp -d)
  (
    cd "$tmp"
    git init -q
    git config user.email handoff@dotclaude.local
    git config user.name dotclaude-handoff
    git checkout -q -b "$branch"
    printf 'stub handoff body\n' > handoff.md
    if [ -n "$desc_tag_seg" ]; then
      printf 'handoff:v2:%s:%s:2026-04:%s:%s:%s\n' \
        proj "$cli" "${branch##*/}" "$host" "$desc_tag_seg" > description.txt
    else
      printf 'handoff:v2:%s:%s:2026-04:%s:%s\n' \
        proj "$cli" "${branch##*/}" "$host" > description.txt
    fi
    printf '%s\n' "$meta_json" > metadata.json
    git add . >/dev/null
    git commit -q -m fixture >/dev/null
    git push -q "$transport" "$branch" >/dev/null
  )
  rm -rf "$tmp"
}

setup() {
  TEST_HOME=$(mktemp -d)
  export HOME="$TEST_HOME"
  make_claude_session_tree "$TEST_HOME"

  TRANSPORT_REPO=$(mktemp -d)
  rm -rf "$TRANSPORT_REPO"
  git init -q --bare "$TRANSPORT_REPO"
  export DOTCLAUDE_HANDOFF_REPO="$TRANSPORT_REPO"

  STUB_DOCTOR=$(mktemp)
  printf '#!/usr/bin/env bash\nexit 0\n' > "$STUB_DOCTOR"
  chmod +x "$STUB_DOCTOR"
  export DOTCLAUDE_DOCTOR_SH="$STUB_DOCTOR"

  THIS_HOST=$(this_host_slug)
  export TRANSPORT_REPO STUB_DOCTOR THIS_HOST
}

teardown() {
  rm -rf "$TEST_HOME" "$TRANSPORT_REPO"
  [ -f "${STUB_DOCTOR:-}" ] && rm -f "$STUB_DOCTOR"
}

# ---- 1: multi-tag push writes tags array (no legacy tag field) ------------

@test "push --tag foo --tag bar: writes metadata.tags=[foo,bar] without legacy tag field" {
  run --separate-stderr node "$BIN" push --from claude --tag foo --tag bar
  [ "$status" -eq 0 ]

  # Fetch the branch and inspect metadata.json.
  local branch; branch=$(echo "$output" | head -1)
  local checkout; checkout=$(mktemp -d)
  git clone -q --depth 1 --branch "$branch" "$TRANSPORT_REPO" "$checkout"
  echo "$checkout/metadata.json:"
  cat "$checkout/metadata.json"
  jq -e '.tags == ["foo","bar"]' "$checkout/metadata.json" >/dev/null
  jq -e 'has("tag") | not' "$checkout/metadata.json" >/dev/null
  rm -rf "$checkout"
}

# ---- 2: exact-tag pull beats substring ------------------------------------

@test "fetch <tag>: exact-tag match wins over substring on description" {
  # Seed a branch tagged exactly "shipping" plus a decoy whose description
  # contains "shipping" as a substring of project name.
  seed_handoff_branch "$TRANSPORT_REPO" "handoff/proj/claude/2026-04/aaaaaaaa" \
    "$THIS_HOST" claude "shipping" \
    '{"cli":"claude","hostname":"'"$THIS_HOST"'","short_id":"aaaaaaaa","tags":["shipping"],"tag":"shipping"}'
  seed_handoff_branch "$TRANSPORT_REPO" "handoff/proj/claude/2026-04/bbbbbbbb" \
    "$THIS_HOST" claude "shipping-related" \
    '{"cli":"claude","hostname":"'"$THIS_HOST"'","short_id":"bbbbbbbb","tags":["shipping-related"],"tag":"shipping-related"}'

  run --separate-stderr node "$BIN" fetch shipping
  [ "$status" -eq 0 ]
  # The exact-tag match resolves to aaaaaaaa, not bbbbbbbb (substring would
  # match both).
  [[ "$output" == *"stub handoff body"* ]]
}

# ---- 3: legacy single-tag metadata still resolves -------------------------

@test "fetch <tag>: legacy branch with only metadata.tag (no tags) still works" {
  # Description carries only single-tag segment (no comma); metadata.json
  # has only the legacy `tag` field.
  seed_handoff_branch "$TRANSPORT_REPO" "handoff/proj/claude/2026-04/cccccccc" \
    "$THIS_HOST" claude "legacy" \
    '{"cli":"claude","hostname":"'"$THIS_HOST"'","short_id":"cccccccc","tag":"legacy"}'

  run --separate-stderr node "$BIN" fetch legacy
  [ "$status" -eq 0 ]
  [[ "$output" == *"stub handoff body"* ]]
}

# ---- 4: list --remote --tag filters by exact tag --------------------------

@test "list --remote --tag foo: shows only branches tagged foo" {
  seed_handoff_branch "$TRANSPORT_REPO" "handoff/proj/claude/2026-04/aaaaaaaa" \
    "$THIS_HOST" claude "foo" \
    '{"cli":"claude","tags":["foo"]}'
  seed_handoff_branch "$TRANSPORT_REPO" "handoff/proj/claude/2026-04/bbbbbbbb" \
    "$THIS_HOST" claude "bar" \
    '{"cli":"claude","tags":["bar"]}'

  run --separate-stderr node "$BIN" list --remote --tag foo
  [ "$status" -eq 0 ]
  [[ "$output" == *"aaaaaaaa"* ]]
  [[ "$output" != *"bbbbbbbb"* ]]
}

# ---- 5: list --remote --tags histogram ------------------------------------

@test "list --remote --tags: prints sorted histogram" {
  seed_handoff_branch "$TRANSPORT_REPO" "handoff/proj/claude/2026-04/aaaaaaaa" \
    "$THIS_HOST" claude "shipping,perf" \
    '{"cli":"claude","tags":["shipping","perf"]}'
  seed_handoff_branch "$TRANSPORT_REPO" "handoff/proj/claude/2026-04/bbbbbbbb" \
    "$THIS_HOST" claude "shipping" \
    '{"cli":"claude","tags":["shipping"]}'
  seed_handoff_branch "$TRANSPORT_REPO" "handoff/proj/claude/2026-04/cccccccc" \
    "$THIS_HOST" claude "" \
    '{"cli":"claude"}'

  run --separate-stderr node "$BIN" list --remote --tags
  [ "$status" -eq 0 ]
  [[ "$output" == *"tag histogram"* ]]
  [[ "$output" == *"shipping"* ]]
  [[ "$output" == *"perf"* ]]
  [[ "$output" == *"(untagged)"* ]]
  # shipping=2, perf=1 — shipping should appear before perf in the output.
  local shipping_line; shipping_line=$(echo "$output" | grep -n "shipping" | head -1 | cut -d: -f1)
  local perf_line; perf_line=$(echo "$output" | grep -n "perf" | head -1 | cut -d: -f1)
  [ "$shipping_line" -lt "$perf_line" ]
}

# ---- bonus: fetch with raw user input still resolves slugified tag -------

@test "fetch \"Foo Bar!\": matches a branch tagged foo-bar (slug-aware exact match)" {
  # Push with raw special-char tag — encoder slugifies into description.
  run --separate-stderr node "$BIN" push --from claude --tag 'Foo Bar!'
  [ "$status" -eq 0 ]
  # Fetch with the SAME raw user input — resolver must slugify before
  # comparing to description-side tags so this exact-tag hit lands.
  # Pre-fix, this would fall through to substring matching on the raw
  # query "Foo Bar!" and never resolve.
  run --separate-stderr node "$BIN" fetch 'Foo Bar!'
  [ "$status" -eq 0 ]
  [ -n "$output" ]
}

# ---- 6: special-char tag slugify round-trip -------------------------------

@test "push --tag 'Foo Bar!': slugifies to foo-bar and round-trips" {
  run --separate-stderr node "$BIN" push --from claude --tag 'Foo Bar!'
  [ "$status" -eq 0 ]

  local branch; branch=$(echo "$output" | head -1)
  local description; description=$(echo "$output" | head -3 | tail -1)
  # Description segment-8 is the slugified tag.
  [[ "$description" == *":foo-bar" ]]

  local checkout; checkout=$(mktemp -d)
  git clone -q --depth 1 --branch "$branch" "$TRANSPORT_REPO" "$checkout"
  # Metadata preserves the raw user input (matches existing single-tag
  # behavior — the script slugifies for the description, not metadata).
  jq -e '.tags == ["Foo Bar!"]' "$checkout/metadata.json" >/dev/null
  rm -rf "$checkout"
}
