#!/usr/bin/env bash
# Claude Code hook entry for /yolo: a per-session autonomy grant that the
# owner starts with one approval and that reverts by itself.
#
# Register it with four entries (see docs/hooks.md#yolosh):
#   UserPromptExpansion, matcher "yolo":  yolo.sh grant
#   PermissionRequest:                    yolo.sh permission
#   UserPromptSubmit:                     yolo.sh prompt
#   SessionEnd:                           yolo.sh session-end
#
# grant        `/yolo --for 2h [--merge|--no-merge] [scope]` writes
#              <state>/<session_id>.json: the scope, whether merges are in it,
#              and the start and expiry (required lifetime, at most 24 h). It adds a
#              context line that tells the skill the grant exists, because a
#              skill cannot learn its own session id. `/yolo off` removes it.
# permission   While the session's grant lives, approves the permission
#              dialog, except for the denylist below. The grant file alone is
#              not enough: the session's transcript must hold the typed /yolo
#              that backs it (see `typed` below), and that line, not the file,
#              sets the scope, the expiry, and whether merges are in it. A PermissionRequest
#              "allow" also clears a dialog from a `permissions.ask` rule and
#              from a PreToolUse "ask", so the denylist re-runs
#              guard-destructive-git.sh itself. It never returns
#              updatedPermissions: nothing outlives the grant.
# prompt       Shows the owner a live grant at each prompt, or warns of a
#              grant file that no typed /yolo backs.
# session-end  Removes the session's grant.
#
# Limit: the hook and the agent run as the same user, so nothing here is a
# hard boundary. A session that can write files with no dialog can also forge
# a transcript line. Only the Claude Code sandbox, which keeps Bash writes in
# the worktree, stops that. The transcript check and the prompt line make a
# forged grant harder to make and easy to see.
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
MAX_SECONDS=86400
USAGE='Usage: /yolo --for 2h|90m [--merge|--no-merge] [scope], or /yolo off'

# The prompt entry runs at every prompt: with no grant on disk, stop before
# any work.
if [ "${1:-}" = prompt ]; then
  set -- prompt "$STATE"/*.json
  [ -e "$2" ] || exit 0
fi

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

# parse_args ARGS: the /yolo arguments into P_OFF, P_SCOPE, P_SECONDS, and
# P_MERGE. Returns 1 with the reason in P_ERR when they are not a valid grant.
parse_args() {
  local word i value
  local -a words=()
  P_OFF=0 P_SCOPE="" P_SECONDS="" P_MERGE="" P_ERR=""
  read -r -d '' -a words <<<"$1"
  if [ "${#words[@]}" -eq 1 ] && [ "${words[0]}" = off ]; then
    P_OFF=1
    return 0
  fi
  i=0
  while [ "$i" -lt "${#words[@]}" ]; do
    word=${words[$i]}
    case "$word" in
      --for)
        i=$((i + 1))
        value=${words[$i]:-}
        if [[ $value =~ ^([0-9]{1,5})([hm])$ ]]; then
          P_SECONDS=${BASH_REMATCH[1]}
          [ "${BASH_REMATCH[2]}" = h ] && P_SECONDS=$((10#$P_SECONDS * 3600)) || P_SECONDS=$((10#$P_SECONDS * 60))
        else
          P_ERR="--for needs a lifetime such as 2h or 90m. $USAGE"
          return 1
        fi
        ;;
      --merge) P_MERGE=true ;;
      --no-merge) P_MERGE=false ;;
      *) P_SCOPE="${P_SCOPE:+$P_SCOPE }$word" ;;
    esac
    i=$((i + 1))
  done

  if [ -z "$P_SECONDS" ]; then
    P_ERR="--for is required. $USAGE"
    return 1
  fi
  P_SCOPE=${P_SCOPE:-the current task in this session}
  if [ "$P_SECONDS" -le 0 ] || [ "$P_SECONDS" -gt "$MAX_SECONDS" ]; then
    P_ERR="The lifetime must be more than 0 and at most 24h. $USAGE"
    return 1
  fi
  if [ -z "$P_MERGE" ]; then
    shopt -s nocasematch
    P_MERGE=false
    if [[ $P_SCOPE =~ (^|[^a-z])merg(e|es|ed|ing)?([^a-z]|$) ]]; then
      P_MERGE=true
      [[ $P_SCOPE =~ (do[[:space:]]+not|don\'?t|never|no|not|without|skip)[[:space:]]+(auto-?)?merg ]] && P_MERGE=false
    fi
    shopt -u nocasematch
  fi
  return 0
}

grant() {
  local name
  name=$(field .command_name)
  case "$name" in
    yolo | *:yolo) ;;
    *) exit 0 ;;
  esac
  [[ $SID =~ $SID_RX ]] || block "No usable session id, so no grant was written. $USAGE"
  local file="$STATE/$SID.json"

  parse_args "$(field .command_args)" || block "$P_ERR"
  if [ "$P_OFF" = 1 ]; then
    rm -f "$file"
    context "YOLO GRANT REMOVED for session $SID. Every permission default is back: each dialog and each ask rule prompts again."
  fi
  local scope=$P_SCOPE seconds=$P_SECONDS merge=$P_MERGE

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
  context "YOLO GRANT ACTIVE for session $SID until $(iso "$expires") ($((seconds / 60)) minutes). Grant file: $file. merge: $yes. Scope: $scope. While it lives, the PermissionRequest hook approves each permission dialog in this session except the denylist (force push, reset --hard, branch or repository deletion (except the head branch of a pull request merged in the scope), rm -r outside the worktree, terraform/tofu destroy, production deploys and releases, edits under docs/specs/, changes to settings files, hooks, ~/.claude, or a grant, and gh pr merge when merge is no)."
}

# ---------------- the typed /yolo ----------------

# typed: true when the session's transcript holds the typed /yolo that backs
# its grant. It reads the last /yolo line that Claude Code wrote for a prompt
# the owner typed in this session: a user line with string content that starts
# with the command markup, a human origin, and not from a subagent. A tool
# result is a user line too, but its content is an array, so a file the agent
# reads cannot count. That line, not the grant file, sets T_SCOPE, T_MERGE,
# and T_EXPIRES (its timestamp plus its lifetime). A later `/yolo off` line,
# or no line, is false.
typed() {
  local transcript row ts args
  transcript=$(field .transcript_path)
  [ -n "$transcript" ] && [ -r "$transcript" ] || return 1
  row=$(grep -F 'yolo</command-name>' "$transcript" 2>/dev/null | jq -c --arg sid "$SID" '
    select(.type == "user" and (.isSidechain | not) and .sessionId == $sid
      and ((.origin.kind // "human") == "human")
      and (.message.content | type) == "string"
      and (.message.content | startswith("<command-message>")))
    | (.message.content | capture("<command-name>/(?<name>[^<]*)</command-name>\\s*<command-args>(?<args>[\\s\\S]*)</command-args>")) as $m
    | select($m.name == "yolo" or ($m.name | endswith(":yolo")))
    | [(.timestamp | sub("\\.[0-9]+"; "") | fromdateiso8601), $m.args]' 2>/dev/null | tail -n 1)
  [ -n "$row" ] || return 1
  ts=$(printf '%s' "$row" | jq -r '.[0]') || return 1
  args=$(printf '%s' "$row" | jq -r '.[1]') || return 1
  [[ $ts =~ ^[0-9]+$ ]] || return 1
  parse_args "$args" || return 1
  [ "$P_OFF" = 0 ] || return 1
  T_SCOPE=$P_SCOPE T_MERGE=$P_MERGE T_EXPIRES=$((ts + P_SECONDS))
  return 0
}

# ---------------- prompt ----------------

message() {
  jq -cn --arg m "$1" '{systemMessage: $m}'
  exit 0
}

clock() {
  date -d "@$1" +%H:%M 2>/dev/null || date -r "$1" +%H:%M
}

prompt() {
  [[ $SID =~ $SID_RX ]] || exit 0
  local file="$STATE/$SID.json" now expires
  [ -f "$file" ] || exit 0
  now=$(date +%s)
  expires=$(jq -r '.expires // empty' "$file" 2>/dev/null)
  if typed; then
    [[ $expires =~ ^[0-9]+$ ]] && [ "$expires" -lt "$T_EXPIRES" ] && T_EXPIRES=$expires
    if [ "$T_EXPIRES" -le "$now" ]; then
      rm -f "$file"
      message "YOLO grant expired. Every permission default is back."
    fi
    local yes=no
    [ "$T_MERGE" = true ] && yes=yes
    message "YOLO active until $(clock "$T_EXPIRES") · merge: $yes · scope: $T_SCOPE · /yolo off to end it"
  fi
  if [[ $expires =~ ^[0-9]+$ ]] && [ "$expires" -le "$now" ]; then
    rm -f "$file"
    message "YOLO grant expired. Every permission default is back."
  fi
  message "Warning: a YOLO grant file exists for this session ($file), but no typed /yolo in this session backs it, so the permission gate ignores it. If you did not type /yolo, something wrote it: remove it and check what did."
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
  "${B}(terraform|tofu|terragrunt)[[:space:]]${REST}-?destroy${END}"
  "[[:space:]]--prod(uction)?([[:space:]=]|$)"
  "${B}vercel[[:space:]]${REST}(promote|rollback)${END}"
  "${B}(fly|flyctl|wrangler|firebase)[[:space:]]${REST}deploy${END}"
  "${B}(npm|pnpm|yarn)[[:space:]]${REST}publish${END}"
  "${B}gh[[:space:]]+release[[:space:]]+create${END}"
)
# gh pr merge, with or without --delete-branch, passes only when merges are in
# the scope: deleting the merged pull request's own head branch is part of the
# merge (/merge-pr always passes it), and GitHub can restore it from the PR.
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
  typed || exit 0
  [ "$T_EXPIRES" -gt "$now" ] || exit 0
  merge=$T_MERGE
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
  prompt) prompt ;;
  session-end) session_end ;;
esac
exit 0
