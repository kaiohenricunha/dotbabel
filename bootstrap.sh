#!/usr/bin/env bash
# bootstrap.sh — symlink dotbabel contents into ~/.claude/
#
# Idempotent: safe to re-run after pulling new commits.
# Backs up pre-existing real files (not symlinks) to <name>.bak-<timestamp>.
#
# Antigravity CLI (agy) is the recommended Google runtime for new installs.
# Installed Gemini CLI remains supported; --all continues to configure both.
# Project fan_out defaults do not restrict this user-scope bootstrap.
#
# Flags:
#   --quiet   suppress per-file progress output; only warnings + the final
#             one-line summary are printed.
#   --all     link all supported CLI instruction targets even when the
#             corresponding CLI binary is not currently on PATH.
#   --source <path>  use an explicit local source tree.
#   --projections    install verified release projections through the Node CLI;
#                    requires Node and the installed CLI dependencies.

set -euo pipefail

QUIET=0
ALL=0
PROJECTIONS=0
SOURCE_OVERRIDE=""
while [[ "$#" -gt 0 ]]; do
  case "$1" in
    --quiet) QUIET=1; shift ;;
    --all) ALL=1; shift ;;
    --projections) PROJECTIONS=1; shift ;;
    --source)
      if [[ "$#" -lt 2 || -z "$2" || "$2" == --* ]]; then
        echo "bootstrap.sh: --source requires a path" >&2
        exit 64
      fi
      SOURCE_OVERRIDE="$2"; shift 2
      ;;
    --help|-h)
      grep -E '^# ' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "bootstrap.sh: unknown argument '$1' (try --help)" >&2
      exit 64
      ;;
  esac
done

SCRIPT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DOTBABEL="${SOURCE_OVERRIDE:-$SCRIPT_ROOT}"
TARGET="$HOME/.claude"
if [[ ! -d "$DOTBABEL" ]]; then
  echo "bootstrap.sh: source directory does not exist" >&2
  exit 2
fi
DOTBABEL="$(cd "$DOTBABEL" && pwd)"

# The plain quickstart remains shell-only. Explicit projections and existing
# projection ownership require the shared Node transaction instead of legacy links.
projection_state_exists() {
  [[ -e "$TARGET/.dotbabel-projection.json" || -L "$TARGET/.dotbabel-projection.json" || -e "$TARGET/.dotbabel-projection.pending.json" || -L "$TARGET/.dotbabel-projection.pending.json" ]]
}

bootstrap_node() {
  if ! command -v node >/dev/null 2>&1; then
    echo "bootstrap.sh: projection ownership requires Node and the installed dotbabel CLI" >&2
    exit 2
  fi
  BOOTSTRAP_ARGS=(--source "$DOTBABEL")
  [[ "$PROJECTIONS" = "1" ]] && BOOTSTRAP_ARGS+=(--projections)
  [[ "$QUIET" = "1" ]] && BOOTSTRAP_ARGS+=(--quiet)
  [[ "$ALL" = "1" ]] && BOOTSTRAP_ARGS+=(--all)
  exec node "$SCRIPT_ROOT/plugins/dotbabel/bin/dotbabel-bootstrap.mjs" "${BOOTSTRAP_ARGS[@]}"
}

if [[ "$PROJECTIONS" = "1" ]] || projection_state_exists || [[ -e "$TARGET/.dotbabel-projection.lock" || -L "$TARGET/.dotbabel-projection.lock" ]]; then
  bootstrap_node
fi

mkdir -p "$TARGET"
LEGACY_LOCK="$TARGET/.dotbabel-projection.lock"
if ! mkdir "$LEGACY_LOCK" 2>/dev/null; then
  echo "bootstrap.sh: projection tree is busy; no files were installed" >&2
  exit 2
fi
LEGACY_LOCK_OWNER="owner-$$-$RANDOM-$RANDOM"
printf '%s\n' "$$" > "$LEGACY_LOCK/$LEGACY_LOCK_OWNER"
release_legacy_lock() {
  if [[ -f "$LEGACY_LOCK/$LEGACY_LOCK_OWNER" && ! -L "$LEGACY_LOCK/$LEGACY_LOCK_OWNER" ]]; then
    if ! rm -- "$LEGACY_LOCK/$LEGACY_LOCK_OWNER" || ! rm -d -- "$LEGACY_LOCK"; then
      echo "bootstrap.sh: could not release its projection reservation" >&2
    fi
  fi
}
trap release_legacy_lock EXIT
# A projection may have committed between the first check and our reservation.
if projection_state_exists; then
  release_legacy_lock
  trap - EXIT
  bootstrap_node
fi
TS=$(date +%Y%m%d-%H%M%S)

mkdir -p "$TARGET"

say() {
  [[ "$QUIET" = "1" ]] && return 0
  echo "$@"
}

link_one() {
  local src="$1"
  local dst="$2"
  local current_dst

  if [[ -L "$dst" ]]; then
    # Already a symlink — update if pointing elsewhere.
    current_dst="$(readlink "$dst")"
    if [[ "$current_dst" != "$src" ]]; then
      rm "$dst"
      ln -s "$src" "$dst"
      say "  updated: $dst -> $src"
    else
      say "  ok:      $dst"
    fi
  elif [[ -e "$dst" ]]; then
    # Real file/dir — back it up before linking.
    mv "$dst" "${dst}.bak-${TS}"
    ln -s "$src" "$dst"
    say "  backed up + linked: $dst (old at ${dst}.bak-${TS})"
  else
    ln -s "$src" "$dst"
    say "  linked:  $dst -> $src"
  fi
}

ensure_real_dir() {
  local dst="$1"

  if [[ -L "$dst" || -e "$dst" ]] && [[ ! -d "$dst" || -L "$dst" ]]; then
    mv "$dst" "${dst}.bak-${TS}"
    say "  backed up: $dst (old at ${dst}.bak-${TS})"
  fi

  mkdir -p "$dst"
}

link_cli_instruction() {
  local cli="$1"
  local src="$2"
  local dst="$3"
  local alt_probe="${4:-}"

  if [[ "$ALL" != "1" ]]; then
    local found=0
    command -v "$cli" >/dev/null 2>&1 && found=1
    if [[ "$found" = "0" && -n "$alt_probe" ]]; then
      eval "$alt_probe" >/dev/null 2>&1 && found=1
    fi
    if [[ "$found" = "0" ]]; then
      say "==> skipping $cli instructions (command not found; use --all to force)"
      return 0
    fi
  fi

  if [[ ! -f "$src" ]]; then
    say "==> skipping $cli instructions (missing source: $src)"
    return 0
  fi

  say "==> linking $cli instructions"
  mkdir -p "$(dirname "$dst")"
  link_one "$src" "$dst"
}

# fan_out_skills_to_dir CLI DST_SKILLS_DIR
#
# Mirrors the dotbabel skills/ + commands/ surface into a CLI-specific skills
# directory. Each skills/<id>/ becomes <dst>/<id>/ (whole-dir symlink). Each
# commands/<name>.md becomes <dst>/<name>/SKILL.md (single-file symlink wrapped
# in a fresh directory so the CLI sees the canonical skill shape).
#
# Idempotent. Skips entries named ".system" defensively, in case a host CLI
# reserves that namespace for built-in skills (Codex does).
fan_out_skills_to_dir() {
  local cli="$1"
  local dst_dir="$2"
  # Optional: the executable to probe, when it differs from the CLI name.
  # Antigravity is installed as `agy`, so probing its id would never find it.
  local probe_cli="${3:-$cli}"

  if [[ "$ALL" != "1" ]] && ! command -v "$probe_cli" >/dev/null 2>&1; then
    say "==> skipping $cli skills (command not found; use --all to force)"
    return 0
  fi

  say "==> fanning out skills/ + commands/ to $cli ($dst_dir)"
  mkdir -p "$dst_dir"

  for d in "$DOTBABEL/skills"/*/; do
    [[ -e "$d" ]] || continue
    local name
    name=$(basename "$d")
    [[ "$name" = ".system" ]] && continue
    link_one "${d%/}" "$dst_dir/$name"
  done

  for f in "$DOTBABEL/commands"/*.md; do
    [[ -e "$f" ]] || continue
    local base name
    base=$(basename "$f")
    name="${base%.md}"
    [[ "$name" = ".system" ]] && continue
    ensure_real_dir "$dst_dir/$name"
    link_one "$f" "$dst_dir/$name/SKILL.md"
  done
}

say "==> linking CLAUDE.md"
[[ -f "$DOTBABEL/CLAUDE.md" ]] && link_one "$DOTBABEL/CLAUDE.md" "$TARGET/CLAUDE.md"

say "==> linking commands/"
mkdir -p "$TARGET/commands"
for f in "$DOTBABEL/commands"/*.md; do
  [[ -e "$f" ]] || continue
  link_one "$f" "$TARGET/commands/$(basename "$f")"
done

say "==> linking skills/"
mkdir -p "$TARGET/skills"
for d in "$DOTBABEL/skills"/*/; do
  [[ -e "$d" ]] || continue
  name=$(basename "$d")
  link_one "${d%/}" "$TARGET/skills/$name"
done

say "==> linking hooks/"
mkdir -p "$TARGET/hooks"
for f in "$DOTBABEL/plugins/dotbabel/hooks"/*.sh; do
  [[ -e "$f" ]] || continue
  link_one "$f" "$TARGET/hooks/$(basename "$f")"
done

say "==> installing agents/"
AGENTS_SRC="$DOTBABEL/plugins/dotbabel/templates/claude/agents"
AGENTS_DST="$TARGET/agents"
mkdir -p "$AGENTS_DST"
if [[ -d "$AGENTS_SRC" ]]; then
  for agent_file in "$AGENTS_SRC"/*.md; do
    [[ -e "$agent_file" ]] || continue
    agent_name=$(basename "$agent_file")
    dst_file="$AGENTS_DST/$agent_name"
    if [[ -e "$dst_file" ]]; then
      say "  skipped (exists): $agent_name — delete to reinstall on next bootstrap"
    else
      cp "$agent_file" "$dst_file"
      say "  installed agent: $agent_name"
    fi
  done
fi

CLI_INSTRUCTIONS_SRC="$DOTBABEL/plugins/dotbabel/templates/cli-instructions"
# Copilot CLI has no skill auto-discovery dir (~/.copilot/), so we link only
# the instruction file, not skills.
link_cli_instruction \
  copilot \
  "$CLI_INSTRUCTIONS_SRC/copilot-instructions.md" \
  "$HOME/.github/copilot-instructions.md" \
  "gh copilot --version"
link_cli_instruction \
  codex \
  "$CLI_INSTRUCTIONS_SRC/codex-AGENTS.md" \
  "$HOME/.codex/AGENTS.md"
fan_out_skills_to_dir codex "${CODEX_HOME:-$HOME/.codex}/skills"
link_cli_instruction \
  gemini \
  "$CLI_INSTRUCTIONS_SRC/gemini-GEMINI.md" \
  "$HOME/.gemini/GEMINI.md"
fan_out_skills_to_dir gemini "${GEMINI_HOME:-$HOME/.gemini}/skills"
# Antigravity gets skills but no instruction link, and that asymmetry is
# deliberate. Its GEMINI.md sharing is PROJECT-scope only: the CLI discovers
# GEMINI.md by walking up from the CWD to the repo root, which never reaches
# $HOME. No evidence it reads a user-scope ~/.gemini/GEMINI.md — agy v1.2.4
# contains no such literal, and its bundled guide lists the global root as
# ~/.gemini/config/ instead. Linking one here would create a file nothing reads.
#
# That root is a separate subtree inside Gemini CLI's ~/.gemini/, so it never
# collides with Gemini's own ~/.gemini/skills/. Probed as `agy`, since that is
# the installed executable name.
fan_out_skills_to_dir antigravity "${ANTIGRAVITY_CONFIG_HOME:-$HOME/.gemini/config}/skills" agy
# OpenCode keeps both user-scope artifacts under one XDG config root: AGENTS.md
# sits beside the skills/ tree. The root is $OPENCODE_CONFIG_DIR, else
# $XDG_CONFIG_HOME/opencode, else ~/.config/opencode — verified with
# `opencode debug paths` under an isolated HOME on v2.0.5. OPENCODE_CONFIG names
# a config FILE and is deliberately not consulted here.
OPENCODE_ROOT="${OPENCODE_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/opencode}"
link_cli_instruction \
  opencode \
  "$CLI_INSTRUCTIONS_SRC/opencode-AGENTS.md" \
  "$OPENCODE_ROOT/AGENTS.md"
fan_out_skills_to_dir opencode "$OPENCODE_ROOT/skills"

if [[ "$QUIET" = "1" ]]; then
  echo "bootstrap complete — target: $TARGET"
else
  echo ""
  echo "bootstrap complete."
  echo "dotbabel: $DOTBABEL"
  echo "target:    $TARGET"
fi

# Tail hint — only when dotbabel-doctor is discoverable on PATH so first-time
# bootstrappers are not confused by a broken reference.
if command -v dotbabel-doctor >/dev/null 2>&1 && [[ "$QUIET" != "1" ]]; then
  echo ""
  echo "next: run 'dotbabel-doctor' to verify install."
fi
