#!/usr/bin/env bash
# One-line fleet state string for the tmux status bar.
# Returns: "pilot:WORKING 27% analyst:IDLE qa-verifier:STUCK feature-dev:WORKING 24%"
# with tmux color codes per state.

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

AGENTS=()
while IFS= read -r line; do
  [[ -n "$line" ]] && AGENTS+=("$line")
done < <(
  cortextos bus list-agents 2>/dev/null \
    | python3 -c 'import json,sys; [print(a["name"]) for a in json.load(sys.stdin) if a.get("running") and a.get("name") not in (".DS_Store",)]' 2>/dev/null
)

parts=()
for a in "${AGENTS[@]}"; do
  line=$("$SCRIPT_DIR/fleet-state.sh" "$a" 2>/dev/null || echo "UNKNOWN")
  state=$(echo "$line" | awk '{print $1}')
  cpu=$(echo "$line" | grep -oE 'cpu=[0-9]+%' | sed 's/cpu=//' || echo "")
  case "$state" in
    WORKING) color="#[fg=green,bold]" ;;
    IDLE)    color="#[fg=cyan]" ;;
    STALE)   color="#[fg=yellow]" ;;
    STUCK)   color="#[fg=red,bold]" ;;
    OFF)     color="#[fg=white,dim]" ;;
    *)       color="#[fg=white]" ;;
  esac
  if [[ "$state" == "WORKING" && -n "$cpu" ]]; then
    parts+=("${color}${a}:${state} ${cpu}#[default]")
  else
    parts+=("${color}${a}:${state}#[default]")
  fi
done

IFS=' | '
echo "${parts[*]}"
