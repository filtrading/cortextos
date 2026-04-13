#!/usr/bin/env bash
# Computes agent activity state: WORKING | IDLE | STUCK | STALE | OFF
#
# Usage: scripts/fleet-state.sh [--raw] <agent>
#
# Default output (human-readable, one line):
#   "<STATE> out=<age> hb=<age> text=<age> cpu=<n>% age=<age>"
#
# --raw output (machine-parseable, one line, integer seconds):
#   "<STATE> <out_age> <hb_age> <text_age> <cpu> <session_age>"
#   OFF state encoded as "OFF 999999 999999 999999 0 0" — sentinel values,
#   always 6 numeric fields, no dashes. Parser pattern: check STATE==OFF
#   before reading ages.
#
# Rules:
#   OFF     — process not running
#   STUCK   — HB or out > 2h stale AND cpu < 2% AND session > 6h (classic ceiling deadlock)
#   STALE   — text > 1h AND out > 1h AND cpu < 2% (v4 four-signal divergence — file-fresh but text-stale shape)
#             OR HB or out > 4h stale (fallback cautionary)
#   WORKING — cpu > 5% OR outbound activity < 5 min ago
#   IDLE    — everything else

set -euo pipefail

# Parse args: support both positional agent and --raw flag in either order.
raw_mode=false
args=()
for arg in "$@"; do
  if [[ "$arg" == "--raw" ]]; then
    raw_mode=true
  else
    args+=("$arg")
  fi
done
set -- "${args[@]}"

agent="${1:?usage: fleet-state.sh [--raw] <agent>}"
CTX_ROOT="${CTX_ROOT:-$HOME/.cortextos/default}"
HB_PATH="$CTX_ROOT/state/$agent/heartbeat.json"
OUT_LOG="$CTX_ROOT/logs/$agent/outbound-messages.jsonl"

now=$(date +%s)

# Process lookup: enumerate children of the cortextos daemon, check each child's cwd.
# The daemon spawns each agent with cwd = orgs/<org>/agents/<name>.
pid=""
daemon_pid=""
if [[ -f "$CTX_ROOT/daemon.pid" ]]; then
  daemon_pid=$(cat "$CTX_ROOT/daemon.pid" 2>/dev/null || true)
fi
if [[ -n "$daemon_pid" ]]; then
  while IFS= read -r child; do
    [[ -z "$child" ]] && continue
    cwd=$(lsof -p "$child" -a -d cwd -Fn 2>/dev/null | awk '/^n/{print substr($0,2); exit}')
    if [[ "$cwd" == *"/agents/$agent" ]]; then
      pid="$child"
      break
    fi
  done < <(ps axo pid,ppid 2>/dev/null | awk -v d="$daemon_pid" '$2==d {print $1}')
fi

if [[ -z "$pid" ]] || ! kill -0 "$pid" 2>/dev/null; then
  # Not running
  if $raw_mode; then
    printf "OFF 999999 999999 999999 0 0\n"
  else
    printf "OFF - - - -\n"
  fi
  exit 0
fi

# ps reads: pcpu as integer, etime converted to seconds
ps_line=$(ps -o pcpu=,etime= -p "$pid" 2>/dev/null || echo "0 0")
cpu=$(echo "$ps_line" | awk '{print int($1)}')
etime=$(echo "$ps_line" | awk '{print $2}')
# etime format: [[DD-]HH:]MM:SS
session_age=$(python3 -c "
import re,sys
s='$etime'.strip()
m=re.match(r'(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)', s)
if not m: print(0); sys.exit()
d,h,mn,sc=[int(x) if x else 0 for x in m.groups()]
print(d*86400 + h*3600 + mn*60 + sc)
" 2>/dev/null || echo 0)

# Heartbeat FILE timestamp + TEXT freshness (four-signal divergence detector).
# File age = proves cron loop alive. Text age = proves status string genuinely changed.
# Today's feature-dev incident: file 2m fresh, text 2h42m stale. Hidden by three-signal view.
hb_age=999999
text_age=999999
hb_status=""
if [[ -f "$HB_PATH" ]]; then
  hb_ts=$(python3 -c "
import json
try:
    d=json.load(open('$HB_PATH'))
    from datetime import datetime
    t=d.get('last_heartbeat','')
    if t.endswith('Z'): t=t[:-1]+'+00:00'
    print(int(datetime.fromisoformat(t).timestamp()))
except Exception:
    print(0)
" 2>/dev/null || echo 0)
  hb_age=$(( now - hb_ts ))
  hb_status=$(python3 -c "
import json
try:
    d=json.load(open('$HB_PATH'))
    print(d.get('status','') or '')
except Exception:
    pass
" 2>/dev/null || echo "")

  # Track first-seen timestamp for the current status string. Persist in state dir.
  text_cache="$CTX_ROOT/state/$agent/.fleet-state-text"
  hash=$(printf '%s' "$hb_status" | shasum -a 1 | awk '{print $1}')
  prev_hash=""
  prev_seen=$now
  if [[ -f "$text_cache" ]]; then
    prev_hash=$(awk 'NR==1{print $1}' "$text_cache" 2>/dev/null || echo "")
    prev_seen=$(awk 'NR==1{print $2}' "$text_cache" 2>/dev/null || echo "$now")
  fi
  if [[ "$hash" == "$prev_hash" ]]; then
    text_age=$(( now - prev_seen ))
  else
    # New status string — record first-seen now
    printf '%s %d\n' "$hash" "$now" > "$text_cache" 2>/dev/null || true
    text_age=0
  fi
fi

# out_age — v4: MIN age across 4 bus signal sources.
# v3 saw only Telegram outbound (outbound-messages.jsonl) and was blind
# to agent-to-agent bus coordination. v4 merges: (1) Telegram+legacy,
# (2) protocol events jsonl, (3) inbox bus msgs (file-per-msg), (4)
# outbox bus msgs (file-per-msg across recipients). "Bus-min age IS the
# liveness signal" — analyst, 2026-04-13 slice_003 convergence.

out_age=999999

# Signal 1: Telegram + legacy bus outbound (outbound-messages.jsonl)
if [[ -f "$OUT_LOG" ]]; then
  last=$(tail -1 "$OUT_LOG" 2>/dev/null || echo "")
  if [[ -n "$last" ]]; then
    out_ts=$(echo "$last" | python3 -c "
import json,sys
from datetime import datetime
try:
    d=json.loads(sys.stdin.read())
    t=d.get('timestamp','')
    if t.endswith('Z'): t=t[:-1]+'+00:00'
    print(int(datetime.fromisoformat(t).timestamp()))
except Exception:
    print(0)
" 2>/dev/null || echo 0)
    (( out_ts > 0 )) && out_age=$(( now - out_ts ))
  fi
fi

# Signal 2: protocol events jsonl (analytics/events/<agent>/<today>.jsonl)
ORG="${CTX_ORG:-bridgepilot}"
TODAY=$(date +%Y-%m-%d)
EVENTS_LOG="$CTX_ROOT/orgs/$ORG/analytics/events/$agent/$TODAY.jsonl"
if [[ -f "$EVENTS_LOG" ]]; then
  last=$(tail -1 "$EVENTS_LOG" 2>/dev/null || echo "")
  if [[ -n "$last" ]]; then
    ev_ts=$(echo "$last" | python3 -c "
import json,sys
from datetime import datetime
try:
    d=json.loads(sys.stdin.read())
    t=d.get('timestamp','')
    if t.endswith('Z'): t=t[:-1]+'+00:00'
    print(int(datetime.fromisoformat(t).timestamp()))
except Exception:
    print(0)
" 2>/dev/null || echo 0)
    if (( ev_ts > 0 )); then
      ev_age=$(( now - ev_ts ))
      (( ev_age < out_age )) && out_age=$ev_age
    fi
  fi
fi

# Signal 3: inbox — NOT merged into out_age on purpose.
# Inbox freshness proves that SOMEONE ELSE sent a message to this agent.
# It does NOT prove this agent is alive/responsive. For liveness classifier
# we only count signals where the agent actively DID something: signals
# 1 (Telegram out), 2 (events emit), 4 (bus outbox). bus-messages.sh viewer
# DOES show inbox signal for human visibility — different purpose.
# Captured 2026-04-13 after qa-verifier stuck-state false positive: my
# manual slice_complete relay to him dropped out_age to 1m and flipped his
# classifier to WORKING even though his Claude session was frozen.

# Signal 4: outbox — newest processed/*/*-from-<agent>-*.json across recipients
outbox_ms=0
shopt -s nullglob
for other_dir in "$CTX_ROOT"/processed/*/; do
  other_base=$(basename "$other_dir")
  [[ "$other_base" == "$agent" ]] && continue
  cand=$(find "$other_dir" -maxdepth 1 -name "*-from-${agent}-*.json" 2>/dev/null \
    | awk -F/ '{print $NF}' | awk -F- 'NF>=2{print $2}' | sort -n | tail -1 || true)
  [[ -z "$cand" ]] && continue
  (( cand > outbox_ms )) && outbox_ms=$cand
done
shopt -u nullglob
if (( outbox_ms > 0 )); then
  outbox_age=$(( now - outbox_ms / 1000 ))
  (( outbox_age >= 0 && outbox_age < out_age )) && out_age=$outbox_age
fi

# Classifier — four-signal divergence detector (classifier > bus > text > file)
state="IDLE"
# STUCK — classic ceiling: silent on both HB and bus, low CPU, long session
if (( hb_age > 7200 || out_age > 7200 )) && (( cpu < 2 )) && (( session_age > 21600 )); then
  state="STUCK"
# STALE-TEXT — heartbeat FILE is cron-fresh but TEXT hasn't changed in a long time AND
# outbound is also silent. This is the feature-dev 2h42m failure shape.
elif (( text_age > 3600 && out_age > 3600 && cpu < 2 )); then
  state="STALE"
elif (( cpu > 5 )) || (( out_age < 300 )); then
  state="WORKING"
elif (( hb_age > 14400 )) || (( out_age > 14400 )); then
  state="STALE"
else
  state="IDLE"
fi

# Human-friendly ages
human_age() {
  local s=$1
  if (( s < 60 )); then printf "%ds" "$s"
  elif (( s < 3600 )); then printf "%dm" $((s/60))
  elif (( s < 86400 )); then printf "%dh%dm" $((s/3600)) $(((s%3600)/60))
  else printf "%dd%dh" $((s/86400)) $(((s%86400)/3600))
  fi
}

if $raw_mode; then
  printf "%s %d %d %d %d %d\n" \
    "$state" "$out_age" "$hb_age" "$text_age" "$cpu" "$session_age"
else
  printf "%s out=%s hb=%s text=%s cpu=%d%% age=%s\n" \
    "$state" "$(human_age "$out_age")" "$(human_age "$hb_age")" "$(human_age "$text_age")" "$cpu" "$(human_age "$session_age")"
fi
