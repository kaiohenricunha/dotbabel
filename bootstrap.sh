#!/usr/bin/env bash
# bootstrap.sh — symlink dotbabel contents into ~/.claude/
#
# Idempotent: safe to re-run after pulling new commits.
# Backs up pre-existing real files (not symlinks) to <name>.bak-<timestamp>.
#
# Flags:
#   --quiet   suppress per-file progress output; only warnings + the final
#             one-line summary are printed.

set -euo pipefail

QUIET=0
for arg in "$@"; do
  case "$arg" in
    --quiet) QUIET=1 ;;
    --help|-h)
      grep -E '^# ' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "bootstrap.sh: unknown argument '$arg' (try --help)" >&2
      exit 64
      ;;
  esac
done

DOTBABEL="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TARGET="$HOME/.claude"
TS=$(date +%Y%m%d-%H%M%S)

mkdir -p "$TARGET"

say() {
  [ "$QUIET" = "1" ] && return 0
  echo "$@"
}

link_one() {
  local src="$1"
  local dst="$2"

  if [ -L "$dst" ]; then
    # Already a symlink — update if pointing elsewhere.
    if [ "$(readlink "$dst")" != "$src" ]; then
      rm "$dst"
      ln -s "$src" "$dst"
      say "  updated: $dst -> $src"
    else
      say "  ok:      $dst"
    fi
  elif [ -e "$dst" ]; then
    # Real file/dir — back it up before linking.
    mv "$dst" "${dst}.bak-${TS}"
    ln -s "$src" "$dst"
    say "  backed up + linked: $dst (old at ${dst}.bak-${TS})"
  else
    ln -s "$src" "$dst"
    say "  linked:  $dst -> $src"
  fi
}

say "==> linking CLAUDE.md"
[ -f "$DOTBABEL/CLAUDE.md" ] && link_one "$DOTBABEL/CLAUDE.md" "$TARGET/CLAUDE.md"

say "==> linking commands/"
mkdir -p "$TARGET/commands"
for f in "$DOTBABEL/commands"/*.md; do
  [ -e "$f" ] || continue
  link_one "$f" "$TARGET/commands/$(basename "$f")"
done

say "==> linking skills/"
mkdir -p "$TARGET/skills"
for d in "$DOTBABEL/skills"/*/; do
  [ -e "$d" ] || continue
  name=$(basename "$d")
  link_one "${d%/}" "$TARGET/skills/$name"
done

say "==> linking hooks/"
mkdir -p "$TARGET/hooks"
for f in "$DOTBABEL/plugins/dotbabel/hooks"/*.sh; do
  [ -e "$f" ] || continue
  link_one "$f" "$TARGET/hooks/$(basename "$f")"
done

say "==> installing agents/"
AGENTS_SRC="$DOTBABEL/plugins/dotbabel/templates/claude/agents"
AGENTS_DST="$TARGET/agents"
mkdir -p "$AGENTS_DST"
if [ -d "$AGENTS_SRC" ]; then
  for agent_file in "$AGENTS_SRC"/*.md; do
    [ -e "$agent_file" ] || continue
    agent_name=$(basename "$agent_file")
    dst_file="$AGENTS_DST/$agent_name"
    if [ -e "$dst_file" ]; then
      say "  skipped (exists): $agent_name — delete to reinstall on next bootstrap"
    else
      cp "$agent_file" "$dst_file"
      say "  installed agent: $agent_name"
    fi
  done
fi

if [ "$QUIET" = "1" ]; then
  echo "bootstrap complete — target: $TARGET"
else
  echo ""
  echo "bootstrap complete."
  echo "dotbabel: $DOTBABEL"
  echo "target:    $TARGET"
fi

# Tail hint — only when dotbabel-doctor is discoverable on PATH so first-time
# bootstrappers are not confused by a broken reference.
if command -v dotbabel-doctor >/dev/null 2>&1 && [ "$QUIET" != "1" ]; then
  echo ""
  echo "next: run 'dotbabel-doctor' to verify install."
fi
