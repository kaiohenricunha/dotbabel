#!/usr/bin/env bash
# Source this file before host-neutral tests or fixture generation. Keep the
# patterns aligned with detectHost() in bin/dotbabel-handoff.mjs.

clear_host_cli_environment() {
  local env_name
  while IFS= read -r env_name; do
    case "$env_name" in
      CLAUDECODE|CLAUDE_CODE_SSE_PORT|CODEX_*|GITHUB_COPILOT_*|COPILOT_*|GEMINI_CLI|GEMINI_CLI_*)
        unset "$env_name"
        ;;
    esac
  done < <(compgen -e)
}

clear_host_cli_environment
