#!/usr/bin/env bash
# Fleet monitor v4 — spawns a tmux session with one pane per running agent,
# each pane running scripts/bus-messages.sh which merges 4 bus signal
# sources: protocol events, Telegram outbound, inbox bus msgs, outbox
# bus msgs. v3 saw only Telegram outbound — blind to agent-to-agent bus.
# Pane title = agent name.
#
# Usage:
#   scripts/monitor-fleet.sh          # auto-detect running agents, (re)open session
#   scripts/monitor-fleet.sh attach   # attach to existing session if running
#   scripts/monitor-fleet.sh kill     # kill the monitor session
#
# Attach from iTerm2:
#   tmux attach -t fleet
# or with iTerm2 tmux integration (recommended — each pane becomes a native iTerm2 pane):
#   tmux -CC attach -t fleet

set -euo pipefail

SESSION="fleet"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG_ROOT="${CTX_ROOT:-$HOME/.cortextos/default}/logs"

cmd="${1:-start}"

if [[ "$cmd" == "kill" ]]; then
  tmux kill-session -t "$SESSION" 2>/dev/null && echo "killed $SESSION" || echo "no session $SESSION"
  exit 0
fi

if [[ "$cmd" == "attach" ]]; then
  exec tmux attach -t "$SESSION"
fi

# Discover running agents from the live roster
RUNNING=()
while IFS= read -r line; do
  [[ -n "$line" ]] && RUNNING+=("$line")
done < <(
  cortextos bus list-agents 2>/dev/null \
    | python3 -c 'import json,sys; [print(a["name"]) for a in json.load(sys.stdin) if a.get("running") and a.get("name") not in (".DS_Store",)]'
)

if [[ ${#RUNNING[@]} -eq 0 ]]; then
  echo "no running agents"; exit 1
fi

echo "monitoring: ${RUNNING[*]}"

# Per-agent viewer command. v4: delegate to bus-messages.sh which merges
# 4 bus signal sources (protocol events, Telegram outbound, inbox bus msgs,
# outbox bus msgs). v3 tailed only outbound/inbound-messages.jsonl which
# missed all agent-to-agent bus coordination.
build_viewer_cmd() {
  local agent="$1"
  cat <<SHELL
clear
exec '$SCRIPT_DIR/bus-messages.sh' '$agent'
SHELL
}

# Kill stale session
tmux kill-session -t "$SESSION" 2>/dev/null || true

# First agent — create the window
first="${RUNNING[0]}"
first_cmd="$(build_viewer_cmd "$first")"
tmux new-session -d -s "$SESSION" -n "fleet" "$first_cmd"
tmux select-pane -t "$SESSION:0.0" -T "$first"

# Remaining agents — split, tile, title
for ((i=1; i<${#RUNNING[@]}; i++)); do
  agent="${RUNNING[$i]}"
  cmd_str="$(build_viewer_cmd "$agent")"
  # Alternate split direction
  if (( i % 2 == 1 )); then
    tmux split-window -t "$SESSION" -h "$cmd_str"
  else
    tmux split-window -t "$SESSION" -v "$cmd_str"
  fi
  tmux select-layout -t "$SESSION" tiled >/dev/null
  tmux select-pane -t "$SESSION:0.$i" -T "$agent" 2>/dev/null || true
done

tmux select-layout -t "$SESSION" tiled >/dev/null

# Pane border titles: agent name + live state (WORKING/IDLE/STUCK/STALE/OFF) refreshed by tmux
tmux set -t "$SESSION" pane-border-status top
tmux set -t "$SESSION" pane-border-format " #[fg=cyan,bold]#{pane_title}#[default]  #(${SCRIPT_DIR}/fleet-state.sh #{pane_title}) "
# Status line: session name + full fleet state + refresh hint
tmux set -t "$SESSION" status-left "#[bg=blue,fg=white,bold] fleet #[default] "
tmux set -t "$SESSION" status-right "#(${SCRIPT_DIR}/fleet-statusline.sh)  #[fg=yellow]re-run: $0#[default] "
tmux set -t "$SESSION" status-right-length 200
tmux set -t "$SESSION" status-interval 5

tmux select-pane -t "$SESSION:0.0" 2>/dev/null || true

echo
echo "tmux session '$SESSION' ready with ${#RUNNING[@]} panes."
echo "attach with:  tmux attach -t $SESSION"
echo "or iTerm2:    tmux -CC attach -t $SESSION    (native iTerm2 panes)"
echo "kill with:    $0 kill"
echo
echo "NOTE: v4 — panes run bus-messages.sh which merges 4 signal sources:"
echo "      protocol events, Telegram, inbox bus msgs, outbox bus msgs."
echo "      v3 was blind to agent-to-agent bus; v4 sees everything."
echo "      Pane title = agent name. Re-run on new spawns to refresh layout."
