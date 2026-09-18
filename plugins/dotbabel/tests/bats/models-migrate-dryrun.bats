#!/usr/bin/env bats

load helpers

MODELS="node $REPO_ROOT/plugins/dotbabel/bin/dotbabel-models.mjs"
UMBRELLA="node $REPO_ROOT/plugins/dotbabel/bin/dotbabel.mjs"

# A repo with one agent whose legacy alias has a known meaning, one skill that
# declares nothing, and one agent whose canonical declaration disagrees with its
# legacy value.
setup() {
  REPO=$(mktemp -d)
  mkdir -p "$REPO/agents" "$REPO/skills/quiet"
  printf -- '---\nid: mapped-agent\ntype: agent\nname: mapped-agent\ndescription: probe\nmodel: opus\n---\n\nbody\n' > "$REPO/agents/mapped-agent.md"
  printf -- '---\nid: quiet\ntype: skill\nname: quiet\ndescription: probe\n---\n\nbody\n' > "$REPO/skills/quiet/SKILL.md"
  BEFORE=$(cd "$REPO" && find . -type f -exec sha256sum {} \; | sort)
}

teardown() {
  rm -rf "$REPO"
}

@test "models migrate: exits 0, prints the analysis, and leaves the tree unchanged" {
  run $MODELS migrate --repo-root "$REPO" --no-color
  [ "$status" -eq 0 ]
  [[ "$output" == *"mapped: 1"* ]]
  [[ "$output" == *"absent: 1"* ]]
  [[ "$output" == *"no artifact was written"* ]]

  AFTER=$(cd "$REPO" && find . -type f -exec sha256sum {} \; | sort)
  [ "$BEFORE" = "$AFTER" ]
}

@test "models migrate --json: stdout is one parseable document and stays write-free" {
  run bash -c "$MODELS migrate --repo-root '$REPO' --json 2>/dev/null"
  [ "$status" -eq 0 ]
  echo "$output" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const r=JSON.parse(s);if(r.envelope!=="MigrationReport")throw new Error("envelope");if(r.version!==1)throw new Error("version");if(r.mode!=="analysis")throw new Error("mode");if(r.totals.mapped!==1)throw new Error("totals");})'

  AFTER=$(cd "$REPO" && find . -type f -exec sha256sum {} \; | sort)
  [ "$BEFORE" = "$AFTER" ]
}

@test "models migrate: a canonical declaration disagreeing with its legacy value exits 1" {
  printf -- '---\nid: conflicted\ntype: agent\nname: conflicted\ndescription: probe\nmodel: haiku\ndotbabel:\n  compute:\n    requirement: frontier\n    binding: self\n    mode: floor\n---\n\nbody\n' > "$REPO/agents/conflicted.md"
  run $MODELS migrate --repo-root "$REPO" --no-color
  [ "$status" -eq 1 ]
  [[ "$output" == *"conflict: 1"* ]]
  # Rule 3 of KD-1: the report names the disagreement and picks no winner.
  [[ "$output" == *"frontier"* ]]
  [[ "$output" == *"mechanical"* ]]
}

@test "models migrate: unknown verb and missing verb are usage errors" {
  run $MODELS
  [ "$status" -eq 64 ]
  run $MODELS resolve
  [ "$status" -eq 64 ]
  [[ "$output" == *"unknown verb"* ]]
}

@test "models is reachable through the umbrella CLI" {
  run $UMBRELLA models migrate --repo-root "$REPO" --no-color
  [ "$status" -eq 0 ]
  run $UMBRELLA --help
  [ "$status" -eq 0 ]
  [[ "$output" == *"models"* ]]
}

@test "models migrate: a dotbabel.compute block that does not parse exits 1" {
  printf -- '---\nid: broken\ntype: agent\nname: broken\ndescription: probe\nmodel: opus\ndotbabel:\n  compute:\n    requrement: deep\n    binding: self\n    mode: dynamic\n---\n\nbody\n' > "$REPO/agents/broken.md"
  run $MODELS migrate --repo-root "$REPO" --no-color
  [ "$status" -eq 1 ]
  [[ "$output" == *"invalid-declaration: 1"* ]]
  [[ "$output" == *"MI_DECLARATION_INVALID"* ]]
  # The pointer tells the author which key is wrong.
  [[ "$output" == *"/dotbabel/compute/requrement"* ]]
}

@test "models migrate: a mapped proposal is flagged as defaulted, not approved" {
  run $MODELS migrate --repo-root "$REPO" --no-color
  [ "$status" -eq 0 ]
  [[ "$output" == *"owner decision is still required"* ]]
}
