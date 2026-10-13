#!/usr/bin/env bash
# Claude Code hook entry for /yolo: a per-session autonomy grant that the
# owner starts with one approval and that reverts by itself.
#
# Register it with three entries (see docs/hooks.md#yolosh):
#   UserPromptExpansion, matcher "yolo":  yolo.sh grant
#   PermissionRequest:                    yolo.sh permission
#   SessionEnd:                           yolo.sh session-end
#
# grant        `/yolo <scope> [--for 2h] [--merge|--no-merge]` writes
#              <state>/<session_id>.json: the scope, whether merges are in it,
#              and the start and expiry (default 4 h, at most 24 h). It adds a
#              context line that tells the skill the grant exists, because a
#              skill cannot learn its own session id. `/yolo off` removes it.
# permission   While the session's grant lives, approves the permission
#              dialog, except for the denylist below. A PermissionRequest
#              "allow" also clears a dialog from a `permissions.ask` rule and
#              from a PreToolUse "ask", so the denylist re-runs
#              guard-destructive-git.sh itself. It never returns
#              updatedPermissions: nothing outlives the grant.
# session-end  Removes the session's grant.
#
# The gate declines by printing nothing, and then the dialog shows as it does
# with no grant. It fails closed: without jq, without a readable grant, without
# guard-destructive-git.sh beside it (for Bash), or on any error, it declines.
# It can only approve a dialog that Claude Code was about to show; it never
# turns an allowed call into a prompt, so the skill text carries the same stops.
# The session's own permission surface (settings files, .claude/hooks/,
# ~/.claude/, the grants) keeps its dialog too: a change there would outlive
# the grant. The one exception is `rm -f` of the session's own grant file,
# which is how the skill ends the grant.
#
# State: $DOTBABEL_YOLO_STATE_DIR, else $XDG_STATE_HOME/dotbabel/yolo, else
# ~/.local/state/dotbabel/yolo. Each permission call also removes expired
# grants, grants whose file and session_id disagree, and grants of a session
# that the Claude Code session registry ($CLAUDE_CONFIG_DIR/sessions) shows
# with no live process.

command -v jq >/dev/null 2>&1 || exit 0

STATE="${DOTBABEL_YOLO_STATE_DIR:-${XDG_STATE_HOME:-${HOME:-}/.local/state}/dotbabel/yolo}"
SID_RX='^[A-Za-z0-9_-]{1,128}$'
DEFAULT_SECONDS=14400
MAX_SECONDS=86400
USAGE='Usage: /yolo <scope> [--for 2h|90m] [--merge|--no-merge], or /yolo off'

INPUT=$(cat)
SID=$(printf '%s' "$INPUT" | jq -r '.session_id // empty' 2>/dev/null) || exit 0

field() {
  printf '%s' "$INPUT" | jq -r "$1 // empty" 2>/dev/null
}

iso() {
  date -u -d "@$1" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -r "$1" +%Y-%m-%dT%H:%M:%SZ
}

# ---------------- grant ----------------

block() {
  jq -cn --arg r "$1" '{decision: "block", reason: $r}'
  exit 0
}

context() {
  jq -cn --arg c "$1" '{hookSpecificOutput: {hookEventName: "UserPromptExpansion", additionalContext: $c}}'
  exit 0
}

grant() {
  local name args seconds="" merge="" word scope="" i
  local -a words=()
  name=$(field .command_name)
  case "$name" in
    yolo | *:yolo) ;;
    *) exit 0 ;;
  esac
  [[ $SID =~ $SID_RX ]] || block "No usable session id, so no grant was written. $USAGE"
  local file="$STATE/$SID.json"

  args=$(field .command_args)
  read -r -d '' -a words <<<"$args"
  if [ "${#words[@]}" -eq 1 ] && [ "${words[0]}" = off ]; then
    rm -f "$file"
    context "YOLO GRANT REMOVED for session $SID. Every permission default is back: each dialog and each ask rule prompts again."
  fi

  i=0
  while [ "$i" -lt "${#words[@]}" ]; do
    word=${words[$i]}
    case "$word" in
      --for)
        i=$((i + 1))
        local value=${words[$i]:-}
        if [[ $value =~ ^([0-9]{1,5})([hm])$ ]]; then
          seconds=${BASH_REMATCH[1]}
          [ "${BASH_REMATCH[2]}" = h ] && seconds=$((10#$seconds * 3600)) || seconds=$((10#$seconds * 60))
        else
          block "--for needs a lifetime such as 2h or 90m. $USAGE"
        fi
        ;;
      --merge) merge=true ;;
      --no-merge) merge=false ;;
      *) scope="${scope:+$scope }$word" ;;
    esac
    i=$((i + 1))
  done

  [ -n "$scope" ] || block "Give the scope of the work. $USAGE"
  seconds=${seconds:-$DEFAULT_SECONDS}
  if [ "$seconds" -le 0 ] || [ "$seconds" -gt "$MAX_SECONDS" ]; then
    block "The lifetime must be more than 0 and at most 24h. $USAGE"
  fi
  if [ -z "$merge" ]; then
    shopt -s nocasematch
    merge=false
    if [[ $scope =~ (^|[^a-z])merg(e|es|ed|ing)?([^a-z]|$) ]]; then
      merge=true
      [[ $scope =~ (do[[:space:]]+not|don\'?t|never|no|not|without|skip)[[:space:]]+(auto-?)?merg ]] && merge=false
    fi
    shopt -u nocasematch
  fi

  local now expires tmp
  now=$(date +%s)
  expires=$((now + seconds))
  (umask 077 && mkdir -p "$STATE") || block "Cannot create $STATE, so no grant was written."
  chmod 700 "$STATE" 2>/dev/null
  tmp=$(umask 077 && mktemp "$STATE/.grant.XXXXXX") || block "Cannot write in $STATE, so no grant was written."
  if ! jq -n --arg sid "$SID" --arg scope "$scope" --argjson merge "$merge" \
    --argjson started "$now" --argjson expires "$expires" --arg cwd "$(field .cwd)" \
    '{session_id: $sid, scope: $scope, merge: $merge, started: $started, expires: $expires, cwd: $cwd}' >"$tmp" ||
    ! mv -f "$tmp" "$file"; then
    rm -f "$tmp"
    block "Cannot write $file, so no grant was written."
  fi

  local yes=no
  [ "$merge" = true ] && yes=yes
  context "YOLO GRANT ACTIVE for session $SID until $(iso "$expires") ($((seconds / 60)) minutes). Grant file: $file. merge: $yes. Scope: $scope. While it lives, the PermissionRequest hook approves each permission dialog in this session except the denylist (force push, reset --hard, branch or repository deletion, rm -r outside the worktree, terraform/tofu destroy, production deploys and releases, edits under docs/specs/, changes to settings files, hooks, ~/.claude, or a grant, and gh pr merge when merge is no)."
}

# ---------------- permission ----------------

# The registry holds one <pid>.json per Claude Code process, with its
# sessionId. Unknown (no registry, no /proc) counts as live.
session_live() {
  local registry="${CLAUDE_CONFIG_DIR:-${HOME:-}/.claude}/sessions" f pid
  [ -d "$registry" ] && [ -d /proc/self ] || return 0
  while IFS= read -r f; do
    pid=$(jq -r '.pid // empty' "$f" 2>/dev/null)
    [[ $pid =~ ^[0-9]+$ ]] && [ -d "/proc/$pid" ] && return 0
  done < <(grep -lE "\"sessionId\"[[:space:]]*:[[:space:]]*\"$1\"" "$registry"/*.json 2>/dev/null)
  return 1
}

prune() {
  local f base row gsid gexp
  for f in "$STATE"/*.json; do
    [ -e "$f" ] || continue
    base=${f##*/}
    base=${base%.json}
    [ "$base" = "$SID" ] && continue
    row=$(jq -r '"\(.session_id // "")\t\(.expires // "")"' "$f" 2>/dev/null)
    gsid=${row%%$'\t'*}
    gexp=${row#*$'\t'}
    if [ "$gsid" != "$base" ] || ! [[ $gexp =~ ^[0-9]+$ ]] || [ "$gexp" -le "$1" ] || ! session_live "$gsid"; then
      rm -f "$f"
    fi
  done
}

B='(^|[[:space:];&|(`])'
GIT="${B}([^[:space:];&|]*/)?git[[:space:]]([^;&|]*[[:space:]])?"
REST='([^;&|]*[[:space:]])?'
END='([[:space:]]|$)'
DENY_BASH=(
  "${GIT}branch[[:space:]]${REST}(-[a-zA-Z]*[dD][a-zA-Z]*|--delete)${END}"
  "${GIT}push[[:space:]]${REST}(-d|--delete|--mirror|--prune|:[^[:space:]]+|\+[^[:space:]]+)${END}"
  "${B}gh[[:space:]]+repo[[:space:]]+delete${END}"
  "${B}gh[[:space:]]+api[[:space:]]${REST}(-X|--method)[[:space:]=]*DELETE${END}"
  "${B}gh[[:space:]]+pr[[:space:]]+merge[[:space:]]${REST}(-[a-zA-Z]*d[a-zA-Z]*|--delete-branch(=[^[:space:]]*)?)${END}"
  "${B}(terraform|tofu|terragrunt)[[:space:]]${REST}-?destroy${END}"
  "[[:space:]]--prod(uction)?([[:space:]=]|$)"
  "${B}vercel[[:space:]]${REST}(promote|rollback)${END}"
  "${B}(fly|flyctl|wrangler|firebase)[[:space:]]${REST}deploy${END}"
  "${B}(npm|pnpm|yarn)[[:space:]]${REST}publish${END}"
  "${B}gh[[:space:]]+release[[:space:]]+create${END}"
)
MERGE_RX="${B}gh[[:space:]]+pr[[:space:]]+merge${END}"

# rm_outside COMMAND CWD: true when a recursive rm may reach outside the
# worktree. Every doubt counts as outside: a variable, a glob, a quote, `..`,
# a `cd`, an unknown worktree, or an rm fed by xargs.
rm_outside() {
  local cmd=$1 cwd=$2 root="" line w target recursive i
  local -a words=()
  root=$(git -C "${cwd:-/nonexistent}" rev-parse --show-toplevel 2>/dev/null) || root=""
  cmd=${cmd//&&/$'\n'}
  cmd=${cmd//||/$'\n'}
  cmd=${cmd//[;|&]/$'\n'}
  while IFS= read -r line; do
    read -r -a words <<<"$line"
    i=0
    local fed=0
    while [ "$i" -lt "${#words[@]}" ]; do
      w=${words[$i]}
      case "$w" in
        sudo | command | env | nice | nohup | time) ;;
        xargs) fed=1 ;;
        [A-Za-z_]*=*) ;;
        *) break ;;
      esac
      i=$((i + 1))
    done
    [ "${words[$i]##*/}" = rm ] 2>/dev/null || continue
    recursive=0
    local -a targets=()
    local opts=1
    for w in "${words[@]:$((i + 1))}"; do
      if [ "$opts" = 1 ] && [ "$w" = -- ]; then
        opts=0
      elif [ "$opts" = 1 ] && [[ $w == --* ]]; then
        [ "$w" = --recursive ] && recursive=1
      elif [ "$opts" = 1 ] && [[ $w == -* ]]; then
        [[ $w == *[rR]* ]] && recursive=1
      else
        targets+=("$w")
      fi
    done
    [ "$recursive" = 1 ] || continue
    [ "$fed" = 1 ] && return 0
    [ -n "$root" ] || return 0
    for target in "${targets[@]}"; do
      [[ $target == *[\$\`~*?\"\'\(\)\{\}\[\]]* ]] && return 0
      [[ $target == .. || $target == ../* || $target == */.. || $target == */../* ]] && return 0
      [[ $target == . || $target == ./ ]] && return 0
      if [[ $target == /* ]]; then
        [[ $target == "$root"/?* ]] || return 0
      else
        [[ $1 =~ ${B}(cd|pushd)[[:space:]] ]] && return 0
        [[ $cwd == "$root" || $cwd == "$root"/* ]] || return 0
      fi
    done
  done <<<"$cmd"
  return 1
}

# surface PATH: true when PATH is part of the session's own permission
# surface: a Claude Code settings file, a project hook, the user's Claude
# Code directory, or a grant. A change there would outlive the grant.
surface() {
  case "$1" in
    .claude/settings*.json | */.claude/settings*.json | .claude/hooks/* | */.claude/hooks/*) return 0 ;;
    "${CLAUDE_CONFIG_DIR:-${HOME:-}/.claude}"/* | "${HOME:-/nonexistent}"/.claude/*) return 0 ;;
    "$STATE"/*) return 0 ;;
  esac
  return 1
}

# bash_denied MERGE: true when the Bash call must keep its dialog.
bash_denied() {
  local cmd norm out rx
  cmd=$(printf '%s' "$INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null) || return 0
  [ -f "$HERE/guard-destructive-git.sh" ] || return 0
  # The guard's per-call bypass covers the guard alone, never this grant.
  out=$(jq -cn --arg c "${cmd//BYPASS_DESTRUCTIVE_GIT=1/}" '{tool_name: "Bash", tool_input: {command: $c}}' |
    env -u BYPASS_DESTRUCTIVE_GIT bash "$HERE/guard-destructive-git.sh" 2>/dev/null) || return 0
  [ -z "$out" ] || return 0
  norm=${cmd//$'\\\n'/ }
  norm=$(printf '%s' "$norm" | tr '\t' ' ' | tr -s ' ')
  # The skill ends the grant with `rm -f <grant file>`; any other command that
  # names the permission surface keeps its dialog.
  if [[ $norm == *.claude/settings* || $norm == *.claude/hooks* || $norm == *"$STATE"* ||
    $norm == *"${CLAUDE_CONFIG_DIR:-${HOME:-/nonexistent}/.claude}"* || $norm == *"${HOME:-/nonexistent}/.claude"* ]]; then
    [[ $norm =~ ^[[:space:]]*rm[[:space:]]+-f[[:space:]]+([^[:space:];&|\`$]+)[[:space:]]*$ ]] || return 0
    [ "${BASH_REMATCH[1]}" = "$STATE/$SID.json" ] || return 0
  fi
  for rx in "${DENY_BASH[@]}"; do
    printf '%s' "$norm" | grep -qE -- "$rx" && return 0
  done
  if [ "$1" != true ] && printf '%s' "$norm" | grep -qE -- "$MERGE_RX"; then
    return 0
  fi
  rm_outside "$norm" "$(field .cwd)" && return 0
  return 1
}

permission() {
  [[ $SID =~ $SID_RX ]] || exit 0
  local now file expires merge tool skill path
  now=$(date +%s)
  prune "$now"
  file="$STATE/$SID.json"
  [ -f "$file" ] || exit 0
  expires=$(jq -r --arg sid "$SID" 'select(.session_id == $sid) | .expires' "$file" 2>/dev/null) || exit 0
  [[ $expires =~ ^[0-9]+$ ]] || exit 0
  if [ "$expires" -le "$now" ]; then
    rm -f "$file"
    exit 0
  fi
  merge=$(jq -r '.merge == true' "$file" 2>/dev/null) || exit 0
  tool=$(field .tool_name)
  [ -n "$tool" ] || exit 0

  shopt -s nocasematch
  case "$tool" in
    Bash)
      bash_denied "$merge" && exit 0
      ;;
    Skill)
      skill=$(field .tool_input.skill)
      [[ $skill =~ (deploy|release|rollback|flyctl) ]] && exit 0
      [[ $skill =~ (^|:)merge-pr$ ]] && [ "$merge" != true ] && exit 0
      ;;
    Edit | Write | MultiEdit | NotebookEdit)
      path=$(field '(.tool_input.file_path // .tool_input.notebook_path)')
      [[ $path == docs/specs/* || $path == */docs/specs/* ]] && exit 0
      surface "$path" && exit 0
      ;;
    mcp__*)
      [[ $tool =~ (deploy|promote|rollback|release|publish|delete|destroy) ]] && exit 0
      ;;
  esac
  shopt -u nocasematch

  jq -cn '{hookSpecificOutput: {hookEventName: "PermissionRequest", decision: {behavior: "allow"}}}'
}

# ---------------- session-end ----------------

session_end() {
  [[ $SID =~ $SID_RX ]] && rm -f "$STATE/$SID.json"
  exit 0
}

src="${BASH_SOURCE[0]}"
while [ -L "$src" ]; do
  dir="$(cd -P "$(dirname "$src")" && pwd)" || exit 0
  src="$(readlink "$src")"
  case "$src" in
    /*) ;;
    *) src="$dir/$src" ;;
  esac
done
HERE="$(cd -P "$(dirname "$src")" && pwd)" || exit 0

case "${1:-}" in
  grant) grant ;;
  permission) permission ;;
  session-end) session_end ;;
esac
exit 0
