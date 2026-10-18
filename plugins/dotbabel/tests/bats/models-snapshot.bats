#!/usr/bin/env bats

load helpers

setup() {
  WORK=$(mktemp -d)
  export XDG_CACHE_HOME="$WORK/cache"
  export HOME="$WORK/home"
  mkdir -p "$HOME"
  MODELS_BIN="$REPO_ROOT/plugins/dotbabel/bin/dotbabel-models.mjs"
  SNAPSHOT="$WORK/snapshot.json"
  cp "$REPO_ROOT/plugins/dotbabel/src/model-intelligence/snapshot/release-capabilities.json" "$SNAPSHOT"
  COPY_BIN=$(command -v cp)
  COMPARE_BIN=$(command -v cmp)
  isolate_path
}

teardown() {
  rm_stub_path
  rm -rf "$WORK"
}

@test "models snapshot: default prints the diff and writes nothing; --check and --write are mutually exclusive (exit 64)" {
  "$COPY_BIN" "$SNAPSHOT" "$WORK/before.json"
  run "$REAL_NODE" "$MODELS_BIN" snapshot --snapshot-file "$SNAPSHOT" --evidence-file "$SNAPSHOT" --json
  [ "$status" -eq 0 ]
  [[ "$output" == *'"written": false'* ]]
  "$COMPARE_BIN" "$SNAPSHOT" "$WORK/before.json"
  run "$REAL_NODE" "$MODELS_BIN" snapshot --check --write --snapshot-file "$SNAPSHOT"
  [ "$status" -eq 64 ]
  "$COMPARE_BIN" "$SNAPSHOT" "$WORK/before.json"
}

@test "models snapshot: check is offline and write refuses an unavailable required runtime without changing the file" {
  run "$REAL_NODE" "$MODELS_BIN" snapshot --check --snapshot-file "$SNAPSHOT" --json
  [ "$status" -eq 0 ]
  "$COPY_BIN" "$SNAPSHOT" "$WORK/before.json"
  run "$REAL_NODE" "$MODELS_BIN" snapshot --write --snapshot-file "$SNAPSHOT" --json
  [ "$status" -eq 2 ]
  [[ "$output" == *'release_source_unavailable'* ]]
  "$COMPARE_BIN" "$SNAPSHOT" "$WORK/before.json"
}

@test "snapshot --check and status --check fail when a required release projection depends on evidence older than 7 days, and plain status still exits 0" {
  "$REAL_NODE" -e 'const fs=require("fs"),p=process.argv[1],s=JSON.parse(fs.readFileSync(p));s.sources.forEach(x=>x.observedAt="2000-01-01T00:00:00.000Z");fs.writeFileSync(p,JSON.stringify(s))' "$SNAPSHOT"
  run "$REAL_NODE" "$MODELS_BIN" snapshot --check --snapshot-file "$SNAPSHOT" --json
  [ "$status" -eq 1 ]
  [[ "$output" == *'release_evidence_stale'* ]]
  run "$REAL_NODE" "$MODELS_BIN" status --check --snapshot-file "$SNAPSHOT" --json
  [ "$status" -eq 1 ]
  run "$REAL_NODE" "$MODELS_BIN" status --snapshot-file "$SNAPSHOT" --json
  [ "$status" -eq 0 ]
  [[ "$output" == *'release_evidence_stale'* ]]
}

@test "models snapshot: explicit accepted evidence writes a complete candidate and never modifies the evidence file" {
  "$COPY_BIN" "$SNAPSHOT" "$WORK/evidence.json"
  rm "$SNAPSHOT"
  run "$REAL_NODE" "$MODELS_BIN" snapshot --write --snapshot-file "$SNAPSHOT" --evidence-file "$WORK/evidence.json" --json
  [ "$status" -eq 0 ]
  [[ "$output" == *'"written": true'* ]]
  "$COMPARE_BIN" "$SNAPSHOT" "$WORK/evidence.json"
}

@test "models snapshot: invalid identity is rejected without repair and flags stay scoped" {
  "$REAL_NODE" -e 'const fs=require("fs"),p=process.argv[1],s=JSON.parse(fs.readFileSync(p));s.snapshotId="sha256:"+"0".repeat(64);fs.writeFileSync(p,JSON.stringify(s))' "$SNAPSHOT"
  "$COPY_BIN" "$SNAPSHOT" "$WORK/before.json"
  run "$REAL_NODE" "$MODELS_BIN" snapshot --check --snapshot-file "$SNAPSHOT" --json
  [ "$status" -eq 1 ]
  [[ "$output" == *'snapshot_identity_mismatch'* ]]
  "$COMPARE_BIN" "$SNAPSHOT" "$WORK/before.json"
  run "$REAL_NODE" "$MODELS_BIN" refresh --write
  [ "$status" -eq 64 ]
}
