#!/usr/bin/env bash
# Live unified bus message stream for a given agent.
#
# Merges 4 signal sources so fleet monitor panes show REAL bus activity
# (not just Telegram outbound, which was v3's blind spot):
#   1. Protocol events — analytics/events/<agent>/<date>.jsonl (tail -F JSONL)
#   2. Telegram outbound — logs/<agent>/outbound-messages.jsonl (tail -F JSONL)
#   3. Incoming bus messages — processed/<agent>/*.json (file-per-msg, polled)
#   4. Outgoing bus messages — processed/*/2-*-from-<agent>-*.json (file-per-msg, polled)
#
# Color key (ANSI):
#   magenta [EVT] — protocol event log entry (action/task/milestone)
#   cyan    [TG ] — Telegram message out to humans
#   yellow  [IN ] — agent-to-agent message received
#   green   [OUT] — agent-to-agent message sent
#
# Usage: scripts/bus-messages.sh <agent>

set -uo pipefail

agent="${1:?usage: bus-messages.sh <agent>}"
CTX_ROOT="${CTX_ROOT:-$HOME/.cortextos/default}"
ORG="${CTX_ORG:-bridgepilot}"

TODAY=$(date +%Y-%m-%d)
EVENTS_LOG="$CTX_ROOT/orgs/$ORG/analytics/events/$agent/$TODAY.jsonl"
OUT_LOG="$CTX_ROOT/logs/$agent/outbound-messages.jsonl"
INBOX_DIR="$CTX_ROOT/processed/$agent"

mkdir -p "$(dirname "$EVENTS_LOG")" "$(dirname "$OUT_LOG")" 2>/dev/null || true
touch "$EVENTS_LOG" "$OUT_LOG" 2>/dev/null || true

# Banner
printf '\033[1;36m=== %s — bus stream v4 ===\033[0m\n' "$agent"
printf 'events:   %s\n' "$EVENTS_LOG"
printf 'telegram: %s\n' "$OUT_LOG"
printf 'inbox:    %s\n' "$INBOX_DIR"
printf 'outbox:   processed/*/2-*-from-%s-*.json (scan)\n\n' "$agent"

# Poll-start timestamp in ms (filename-embedded epoch, not mtime)
INIT_TS_MS=$(($(date +%s) * 1000))

# Cleanup child processes on exit
TAIL1_PID=""
TAIL2_PID=""
POLL_PID=""
cleanup() {
  [[ -n "$TAIL1_PID" ]] && kill "$TAIL1_PID" 2>/dev/null
  [[ -n "$TAIL2_PID" ]] && kill "$TAIL2_PID" 2>/dev/null
  [[ -n "$POLL_PID" ]] && kill "$POLL_PID" 2>/dev/null
}
trap cleanup EXIT INT TERM

# ---- Stream 1: protocol events (JSONL tail) ----
(
  tail -F -n 3 "$EVENTS_LOG" 2>/dev/null | while IFS= read -r line; do
    printf '\033[35m[EVT %s]\033[0m %s %s\n' \
      "$(echo "$line" | jq -r '.timestamp // "?"' 2>/dev/null)" \
      "$(echo "$line" | jq -r '.event // "?"' 2>/dev/null)" \
      "$(echo "$line" | jq -rc '.metadata // {}' 2>/dev/null | cut -c1-300)"
  done
) &
TAIL1_PID=$!

# ---- Stream 2: Telegram outbound (JSONL tail) ----
(
  tail -F -n 3 "$OUT_LOG" 2>/dev/null | while IFS= read -r line; do
    txt=$(echo "$line" | jq -r '.text // .message // "-"' 2>/dev/null | tr '\n' ' ' | cut -c1-300)
    ts=$(echo "$line" | jq -r '.timestamp // "?"' 2>/dev/null)
    printf '\033[36m[TG  %s]\033[0m %s\n' "$ts" "$txt"
  done
) &
TAIL2_PID=$!

# ---- Stream 3+4: bus messages (poll processed/ for new files) ----
(
  shopt -s nullglob
  last_ts=$INIT_TS_MS
  while true; do
    cur_ts=$(($(date +%s) * 1000))

    # Incoming (to this agent)
    if [[ -d "$INBOX_DIR" ]]; then
      for f in "$INBOX_DIR"/*.json; do
        base=$(basename "$f")
        file_ts=$(echo "$base" | awk -F'-' '{print $2}')
        [[ -z "$file_ts" ]] && continue
        if (( file_ts > last_ts && file_ts <= cur_ts )); then
          ts=$(jq -r '.timestamp // "?"' "$f" 2>/dev/null)
          from=$(jq -r '.from // "?"' "$f" 2>/dev/null)
          to=$(jq -r '.to // "?"' "$f" 2>/dev/null)
          txt=$(jq -r '.text // .message // "-"' "$f" 2>/dev/null | tr '\n' ' ' | cut -c1-300)
          printf '\033[33m[IN  %s]\033[0m %s → %s: %s\n' "$ts" "$from" "$to" "$txt"
        fi
      done
    fi

    # Outgoing (from this agent to others — scan all recipients' processed dirs)
    for other in "$CTX_ROOT"/processed/*/; do
      [[ -d "$other" ]] || continue
      other_name=$(basename "$other")
      [[ "$other_name" == "$agent" ]] && continue
      for f in "$other"*-from-"$agent"-*.json; do
        base=$(basename "$f")
        file_ts=$(echo "$base" | awk -F'-' '{print $2}')
        [[ -z "$file_ts" ]] && continue
        if (( file_ts > last_ts && file_ts <= cur_ts )); then
          ts=$(jq -r '.timestamp // "?"' "$f" 2>/dev/null)
          from=$(jq -r '.from // "?"' "$f" 2>/dev/null)
          to=$(jq -r '.to // "?"' "$f" 2>/dev/null)
          txt=$(jq -r '.text // .message // "-"' "$f" 2>/dev/null | tr '\n' ' ' | cut -c1-300)
          printf '\033[32m[OUT %s]\033[0m %s → %s: %s\n' "$ts" "$from" "$to" "$txt"
        fi
      done
    done

    last_ts=$cur_ts
    sleep 2
  done
) &
POLL_PID=$!

wait
