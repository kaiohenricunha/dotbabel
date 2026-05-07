#!/usr/bin/env bats
# Diff-parser invariants for post-pr-review-build-postable-lines.sh.
# The orchestrator gates which (path, line) coordinates are valid POST
# targets against this script's output, so its correctness is load-bearing.

load helpers

SCRIPT="$REPO_ROOT/plugins/dotbabel/scripts/post-pr-review-build-postable-lines.sh"

setup() {
  [ -x "$SCRIPT" ] || chmod +x "$SCRIPT"
  TMPDIFF=$(mktemp)
}

teardown() {
  rm -f "$TMPDIFF"
}

@test "single-file single-hunk: emits NEW-side line numbers in hunk range" {
  cat > "$TMPDIFF" <<'EOF'
--- a/src/foo.ts
+++ b/src/foo.ts
@@ -1,3 +1,4 @@
 line one
-old line two
+new line two
+inserted line
 line three
EOF
  run "$SCRIPT" "$TMPDIFF"
  [ "$status" -eq 0 ]
  result=$(echo "$output" | jq -r '.["src/foo.ts"] | join(",")')
  [ "$result" = "1,2,3,4" ]
}

@test "file deletion (+++ /dev/null): excluded from output" {
  cat > "$TMPDIFF" <<'EOF'
--- a/deleted.txt
+++ /dev/null
@@ -1,2 +0,0 @@
-content
-more
EOF
  run "$SCRIPT" "$TMPDIFF"
  [ "$status" -eq 0 ]
  count=$(echo "$output" | jq 'keys | length')
  [ "$count" = "0" ]
}

@test "multi-file diff: each file gets its own array" {
  cat > "$TMPDIFF" <<'EOF'
--- a/file1.go
+++ b/file1.go
@@ -1,2 +1,2 @@
-old
+new
 keep
--- a/file2.py
+++ b/file2.py
@@ -10,1 +10,2 @@
 unchanged
+added
EOF
  run "$SCRIPT" "$TMPDIFF"
  [ "$status" -eq 0 ]
  echo "$output" | jq -e '.["file1.go"] == [1, 2]'
  echo "$output" | jq -e '.["file2.py"] == [10, 11]'
}

@test "multiple hunks in one file: line numbers honor each hunk's @@ header" {
  cat > "$TMPDIFF" <<'EOF'
--- a/big.ts
+++ b/big.ts
@@ -5,2 +5,2 @@
 ctx
+added at 6
@@ -100,1 +100,2 @@
 ctx2
+added at 101
EOF
  run "$SCRIPT" "$TMPDIFF"
  [ "$status" -eq 0 ]
  echo "$output" | jq -e '.["big.ts"] == [5, 6, 100, 101]'
}

@test "addition-only diff (new file): all lines included" {
  cat > "$TMPDIFF" <<'EOF'
--- /dev/null
+++ b/new.md
@@ -0,0 +1,3 @@
+# Title
+
+body
EOF
  run "$SCRIPT" "$TMPDIFF"
  [ "$status" -eq 0 ]
  echo "$output" | jq -e '.["new.md"] == [1, 2, 3]'
}

@test "missing diff file: exit 3 (invocation error)" {
  run "$SCRIPT" "/tmp/does-not-exist-$$"
  [ "$status" -eq 3 ]
}

@test "no args: exit 3 with usage" {
  run "$SCRIPT"
  [ "$status" -eq 3 ]
  [[ "$output" == *"usage"* ]]
}

@test "deletion-only line is NOT in postable set (LEFT side excluded)" {
  cat > "$TMPDIFF" <<'EOF'
--- a/del.ts
+++ b/del.ts
@@ -5,3 +5,2 @@
 keep
-removed
 also keep
EOF
  run "$SCRIPT" "$TMPDIFF"
  [ "$status" -eq 0 ]
  # Only NEW-side lines: 5 (keep) and 6 (also keep).
  echo "$output" | jq -e '.["del.ts"] == [5, 6]'
}
