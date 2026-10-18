#!/usr/bin/env bats

load helpers

# `refresh` and `status` read and write only the capability cache, so every test points
# XDG_CACHE_HOME at a temp dir: nothing touches the user's real ~/.cache/dotbabel. No test
# here reaches the network. `status` never refreshes (ARCH-33), and `refresh --runtime codex`
# only starts a subprocess, which the isolated PATH below cannot find.
setup() {
  WORK=$(mktemp -d)
  export XDG_CACHE_HOME="$WORK/cache"
  export XDG_CONFIG_HOME="$WORK/config"
  export HOME="$WORK/home"
  mkdir -p "$HOME"
  MODELS_BIN="$REPO_ROOT/plugins/dotbabel/bin/dotbabel-models.mjs"
  # No runtime CLI is reachable: PATH holds only the basic tools, never codex or claude.
  isolate_path
}

teardown() {
  rm_stub_path
  rm -rf "$WORK"
}

@test "models status: exits 0 with no cache and no runtimes" {
  cd "$WORK"
  run "$REAL_NODE" "$MODELS_BIN" status --no-color
  [ "$status" -eq 0 ]
  [[ "$output" == *"models-dev"* ]]
  [[ "$output" == *"no cache"* ]]
  # status is read-only: it creates no cache.
  [ ! -e "$XDG_CACHE_HOME/dotbabel/model-intelligence" ]
}

@test "models refresh: Anthropic metadata needs native transport and never guesses credentials" {
  cd "$WORK"
  run "$REAL_NODE" "$MODELS_BIN" refresh --source anthropic-models-api --no-color
  [ "$status" -eq 2 ]
  [[ "$output" == *"native_transport_unavailable"* ]]
  [ ! -e "$XDG_CACHE_HOME/dotbabel/model-intelligence/entries/anthropic-models-api.json" ]
}

@test "models refresh: exits 2 when a required source is unavailable and no cache exists" {
  cd "$WORK"
  run "$REAL_NODE" "$MODELS_BIN" refresh --runtime codex --no-color
  [ "$status" -eq 2 ]
  [[ "$output" == *"codex"* ]]
  [[ "$output" == *"binary_missing"* ]]
  # A failed refresh writes no evidence, so the cache still holds no entry.
  [ ! -e "$XDG_CACHE_HOME/dotbabel/model-intelligence/entries/codex.json" ]
}

@test "models status --json: stdout is one parseable status document" {
  cd "$WORK"
  run bash -c "'$REAL_NODE' '$MODELS_BIN' status --json 2>/dev/null"
  [ "$status" -eq 0 ]
  echo "$output" | "$REAL_NODE" -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const r=JSON.parse(s);if(r.envelope!=="ModelsStatus")throw new Error("envelope");if(r.version!==1)throw new Error("version");const ids=r.sources.map(x=>x.id);for(const id of ["claude","codex","models-dev"])if(!ids.includes(id))throw new Error("missing "+id);if(r.sources.some(x=>x.cache!==null))throw new Error("cache");if(r.cache.withinLimit!==true)throw new Error("limit");})'
}

@test "models refresh: a runtime without a discovery adapter is required and unavailable" {
  cd "$WORK"
  run "$REAL_NODE" "$MODELS_BIN" refresh --runtime claude --no-color
  [ "$status" -eq 2 ]
  [[ "$output" == *"unsupported"* ]]
}

@test "models refresh: an unknown source or runtime id is a usage error" {
  cd "$WORK"
  run "$REAL_NODE" "$MODELS_BIN" refresh --source no-such-source
  [ "$status" -eq 64 ]
  run "$REAL_NODE" "$MODELS_BIN" refresh --runtime no-such-runtime
  [ "$status" -eq 64 ]
  run "$REAL_NODE" "$MODELS_BIN" status --check --json --source models-dev
  [ "$status" -eq 64 ]
}
