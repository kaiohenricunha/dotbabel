#!/usr/bin/env bats

load helpers

setup() {
  WORK=$(mktemp -d)
  export XDG_CACHE_HOME="$WORK/cache"
  export XDG_CONFIG_HOME="$WORK/config"
  PROJECT="$WORK/project"
  mkdir -p "$PROJECT"
  MODELS_BIN="$REPO_ROOT/plugins/dotbabel/bin/dotbabel-models.mjs"
  SEED="$REPO_ROOT/plugins/dotbabel/tests/fixtures/model-intelligence/seed-resolver-cache.mjs"
  isolate_path
}

teardown() {
  rm_stub_path
  rm -rf "$WORK"
}

@test "models resolve: --json emits a ResolverResult and exit 1 on conflict" {
  "$REAL_NODE" "$SEED" "$PROJECT" conflict
  run "$REAL_NODE" "$MODELS_BIN" resolve --requirement deep --runtime codex --repo-root "$PROJECT" --json
  [ "$status" -eq 1 ]
  echo "$output" | "$REAL_NODE" -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const r=JSON.parse(s);if(r.status!=="conflict"||r.enforcement.state!=="unsatisfied"||r.configuration!==undefined)throw new Error("conflict");})'
}

@test "models resolve: cached resolution writes no configuration or cache" {
  "$REAL_NODE" "$SEED" "$PROJECT" valid
  CONFIG_BEFORE=$("$REAL_NODE" -e 'process.stdout.write(require("node:fs").readFileSync(process.argv[1],"utf8"))' "$PROJECT/.dotbabel.json")
  CACHE_BEFORE=$("$REAL_NODE" -e 'process.stdout.write(require("node:fs").readFileSync(process.argv[1],"utf8"))' "$XDG_CACHE_HOME/dotbabel/model-intelligence/entries/codex.json")
  run "$REAL_NODE" "$MODELS_BIN" resolve --requirement deep --runtime codex --repo-root "$PROJECT" --json
  [ "$status" -eq 0 ]
  echo "$output" | "$REAL_NODE" -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const r=JSON.parse(s);if(r.status!=="resolved"||r.configuration.axes.model!=="opaque-cli-model"||r.configuration.axes.reasoning!=="native-low"||r.enforcement.state!=="unknown")throw new Error("resolution");})'
  [ "$("$REAL_NODE" -e 'process.stdout.write(require("node:fs").readFileSync(process.argv[1],"utf8"))' "$PROJECT/.dotbabel.json")" = "$CONFIG_BEFORE" ]
  [ "$("$REAL_NODE" -e 'process.stdout.write(require("node:fs").readFileSync(process.argv[1],"utf8"))' "$XDG_CACHE_HOME/dotbabel/model-intelligence/entries/codex.json")" = "$CACHE_BEFORE" ]
  [ ! -e "$XDG_CACHE_HOME/dotbabel/model-intelligence/attempts" ]
}

@test "models resolve: missing evidence exits 2, including adapters without supported discovery" {
  run "$REAL_NODE" "$MODELS_BIN" resolve --requirement deep --runtime codex --repo-root "$PROJECT" --json
  [ "$status" -eq 2 ]
  [[ "$output" == *'"status": "unresolved"'* ]]
  [ ! -e "$XDG_CACHE_HOME/dotbabel/model-intelligence" ]
  run "$REAL_NODE" "$MODELS_BIN" resolve --requirement deep --runtime copilot --repo-root "$PROJECT" --json
  [ "$status" -eq 2 ]
  [[ "$output" == *'insufficient_capability_evidence'* ]]
  run "$REAL_NODE" "$MODELS_BIN" resolve --requirement deep --runtime gemini --repo-root "$PROJECT" --json
  [ "$status" -eq 2 ]
  [[ "$output" == *'insufficient_capability_evidence'* ]]
}
