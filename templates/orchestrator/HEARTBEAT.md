# Heartbeat Checklist - EXECUTE EVERY STEP. SKIP NOTHING.

This runs on your heartbeat cron (every 4 hours). Execute EVERY step in order.
Skipping steps = broken system. The dashboard monitors your compliance.

## Step 1: Update heartbeat (DO THIS FIRST)

```bash
cortextos bus update-heartbeat "<1-sentence summary of current work>"
```

If this fails, your agent shows as DEAD on the dashboard. Fix it before anything else.

## Step 2: Sweep inbox for un-ACK'd messages

Messages arrive in real time via the fast-checker daemon — you don't need to poll for them. This step is a safety sweep for anything that wasn't ACK'd (e.g. a crash mid-processing).

Full reference: `.claude/skills/comms/SKILL.md`

```bash
cortextos bus check-inbox
```

For any messages returned: process and ACK each one:

```bash
cortextos bus ack-inbox "<message_id>"
```

Un-ACK'd messages are re-delivered after 5 minutes. Target: 0 un-ACK'd after this sweep.

## Step 3: Fleet health check (ORCHESTRATOR — do this before your own tasks)

Full reference: `.claude/skills/agent-management/SKILL.md`
Approvals reference: `.claude/skills/approvals/SKILL.md`
Human tasks reference: `.claude/skills/human-tasks/SKILL.md`

```bash
# Check all agent heartbeats
cortextos bus read-all-heartbeats

# Check all pending approvals
cortextos bus list-approvals --format json 2>/dev/null

# Check stale human tasks
cortextos bus list-tasks --project human-tasks --status pending 2>/dev/null
```

For each agent: if heartbeat is older than 5 hours, send an alert to that agent and flag in memory.

For any pending approval older than 4 hours: ping the user via Telegram.
For any [HUMAN] task pending longer than 4 hours: ping the user via Telegram.

```bash
# Example: ping user about stale approval or human task
cortextos bus send-telegram $CTX_TELEGRAM_CHAT_ID "Pending approval needs your decision: <title> — check dashboard"
cortextos bus send-telegram $CTX_TELEGRAM_CHAT_ID "[HUMAN] task waiting on you: <title> — blocking <agent> on <parent task>"
```

## Step 3a: Spawn Cascade Mode (ORCHESTRATOR — only fires when cascade active)

Full reference: `.claude/skills/agent-management/SKILL.md`

This step runs ONLY when the cascade-polling cron is firing (every 5m) AND `config.json .spawn_cascade_active` is `true`. The cron prompt already checks the flag and no-ops on false — so if you are reading this step, the flag is true and you are inside an active spawn cascade window.

**Why this step exists:** Root cause fix for the coordination deadlock pattern where the orchestrator and newly-spawned specialists wait passively on state transitions that never resolve. The passive 4h heartbeat cadence is too slow to catch spawn-time deadlocks. During active cascade windows this step tightens the cadence to 5m and proactively drives three behaviors: Phase 1 hello to new agents, tight fleet polling, and a 20-min staleness alarm.

Execute the three sub-steps in order.

**Sub-step (a): Phase 1 hello to newly-spawned agents (5-min SLA from daemon start)**

Compare the current agent roster against the cached "seen" set. Any agent in current but not seen is new — send them a Phase 1 hello with role context from their `goals.json`:

```bash
SEEN_FILE="$CTX_ROOT/state/$CTX_AGENT_NAME/cascade-seen-agents.json"
mkdir -p "$(dirname "$SEEN_FILE")"
current=$(cortextos bus read-all-heartbeats --format json | jq -r '.[].agent')
seen=""
[[ -f "$SEEN_FILE" ]] && seen=$(jq -r '.[]' "$SEEN_FILE" 2>/dev/null || true)

for agent in $current; do
  if ! echo "$seen" | grep -qx "$agent"; then
    # New agent — send Phase 1 hello
    goals_json="$CTX_FRAMEWORK_ROOT/orgs/$CTX_ORG/agents/$agent/goals.json"
    focus=$(jq -r '.focus // "(awaiting goal configuration)"' "$goals_json" 2>/dev/null || echo "(no goals yet)")
    goals_list=$(jq -r '(.goals // []) | map("- \(.)") | join("\n")' "$goals_json" 2>/dev/null || echo "")
    hello_text=$(cat <<HELLO
Welcome. I am $CTX_AGENT_NAME, orchestrator for $CTX_ORG. I see you booted at $(date -u +%Y-%m-%dT%H:%M:%SZ).

Your initial role: $focus

Primary responsibilities:
$goals_list

Ping me via \`cortextos bus send-message $CTX_AGENT_NAME normal\` if you hit blockers. Expect your first heartbeat cron fire within 4h.

Reply with a 1-line current status so I can confirm you are receiving bus messages.
HELLO
)
    cortextos bus send-message "$agent" normal "$hello_text"
    cortextos bus log-event action phase_1_hello_sent info \
      --meta "{\"agent\":\"$agent\",\"orchestrator\":\"$CTX_AGENT_NAME\"}"
  fi
done

# Update seen set atomically
echo "$current" | jq -R -s 'split("\n") | map(select(length > 0))' > "$SEEN_FILE.tmp" \
  && mv "$SEEN_FILE.tmp" "$SEEN_FILE"
```

**Sub-step (b): Fleet health poll (5m cadence during cascade, replaces 4h heartbeat poll)**

Log the poll fire event so the activity feed shows active cascade coverage:

```bash
cortextos bus log-event action cascade_poll_fire info \
  --meta "{\"orchestrator\":\"$CTX_AGENT_NAME\"}"
```

The iteration in sub-step (c) below doubles as the fleet health sweep — every agent gets a state check on every fire. No additional polling call needed here.

**Sub-step (c): 20-min staleness alarm via Telegram**

For each live agent, call `scripts/fleet-state.sh <agent> --raw` to get integer-second ages across all four signal sources. If `MIN(out_age, hb_age)` exceeds 1200 seconds (20 min) AND the agent hasn't been alarmed in the last 15 min, page the user via Telegram. Rate-limiting prevents alarm storms on persistently-stale agents.

```bash
ALARM_FILE="$CTX_ROOT/state/$CTX_AGENT_NAME/cascade-alarm-state.json"
mkdir -p "$(dirname "$ALARM_FILE")"
[[ -f "$ALARM_FILE" ]] || echo '{"last_alarm_ts":{}}' > "$ALARM_FILE"
now=$(date +%s)

for agent in $current; do
  read -r state out_age hb_age text_age cpu session_age \
    < <(scripts/fleet-state.sh "$agent" --raw 2>/dev/null || echo "ERROR 0 0 0 0 0")
  [[ "$state" == "OFF" || "$state" == "ERROR" ]] && continue  # skip offline / lookup failures

  # MIN(out_age, hb_age) — composite activity signal per calibration #4 semantics
  min_age=$(( out_age < hb_age ? out_age : hb_age ))
  if (( min_age > 1200 )); then
    last_alarm=$(jq -r ".last_alarm_ts[\"$agent\"] // 0" "$ALARM_FILE")
    if (( now - last_alarm > 900 )); then
      # Fire alarm: min_age > 20min AND last alarm > 15min ago
      human="$(( min_age / 60 ))m"
      cortextos bus send-telegram "$CTX_TELEGRAM_CHAT_ID" \
        "Spawn cascade alarm: $agent silent for $human (min of hb_age=${hb_age}s, out_age=${out_age}s, text_age=${text_age}s). Check dashboard."
      # Update alarm state atomically
      jq --arg a "$agent" --argjson t "$now" \
        '.last_alarm_ts[$a] = $t' "$ALARM_FILE" > "$ALARM_FILE.tmp" \
        && mv "$ALARM_FILE.tmp" "$ALARM_FILE"
      cortextos bus log-event action cascade_staleness_alarm warning \
        --meta "{\"agent\":\"$agent\",\"min_age_s\":$min_age,\"hb_age_s\":$hb_age,\"out_age_s\":$out_age,\"text_age_s\":$text_age}"
    fi
  fi
done
```

**Toggling cascade mode:** Edit `config.json` directly. Set `"spawn_cascade_active": true` at the start of a spawn cascade window, `false` when the cascade completes. The `cascade-polling` cron is always defined in `config.json` (fires every 5m) but no-ops at fire time when the flag is false — see the cron entry and `## Spawn Cascade Protocol` section in `AGENTS.md` for the toggle workflow.

## Step 3b: Check own task queue + stale task detection

Full reference: `.claude/skills/tasks/SKILL.md`

```bash
cortextos bus list-tasks --agent $CTX_AGENT_NAME --status pending
cortextos bus list-tasks --agent $CTX_AGENT_NAME --status in_progress
```

- If you have pending tasks: pick the highest priority one
- If you have in_progress tasks older than 2 hours: either complete them NOW or update their status with a note
- If you have NO tasks: check GOALS.md for objectives, generate tasks for specialist agents

Stale tasks are visible on the dashboard. They make you look broken.

## Step 4: Log heartbeat event

Full reference: `.claude/skills/event-logging/SKILL.md`

```bash
cortextos bus log-event heartbeat agent_heartbeat info --meta '{"agent":"'$CTX_AGENT_NAME'"}'
```

## Step 5: Write daily memory

Full reference: `.claude/skills/memory/SKILL.md`

```bash
TODAY=$(date -u +%Y-%m-%d)
LOCAL_TIME=$(date +'%-I:%M %p %Z' 2>/dev/null || date)
MEMORY_DIR="$(pwd)/memory"
mkdir -p "$MEMORY_DIR"
cat >> "$MEMORY_DIR/$TODAY.md" << MEMORY

## Heartbeat Update - $(date -u +%H:%M UTC) / $LOCAL_TIME
- WORKING ON: <task_id or "none">
- Status: <healthy/working/blocked>
- Inbox: <N messages processed>
- Next action: <what you will do next>
MEMORY
```

## Step 6: Check org goals state

Full reference: `.claude/skills/goal-management/SKILL.md`

```bash
cat $CTX_FRAMEWORK_ROOT/orgs/$CTX_ORG/goals.json
```

- If `daily_focus_set_at` is not today AND it is before 10 AM: trigger morning review now — read `.claude/skills/morning-review/SKILL.md`
- If `north_star` is empty: message user via Telegram to set it
- If any agent has an empty `goals.json` (focus and goals both empty): write their goals and regenerate GOALS.md

Also read your own GOALS.md for any manual overrides or notes you left yourself.

## Step 7: Resume work

Full reference: `.claude/skills/tasks/SKILL.md`

Pick your highest priority task and work on it. Tasks should trace back to your current goals.

When starting:
```bash
cortextos bus update-task "<task_id>" in_progress
```

When done:
```bash
cortextos bus complete-task "<task_id>" --result "<summary of what was produced>"
```

## Step 8: Guardrail self-check

Full reference: `.claude/skills/guardrails-reference/SKILL.md`

Ask yourself: did I skip any procedures this cycle? Did I rationalize not doing something I should have?

If yes, log it:
```bash
cortextos bus log-event action guardrail_triggered info --meta '{"guardrail":"<which one>","context":"<what happened>"}'
```

If you discovered a new pattern that should be a guardrail, add it to GUARDRAILS.md now.

## Step 9: Update long-term memory (if applicable)

Full reference: `.claude/skills/memory/SKILL.md`

If you learned something this cycle that should persist across sessions:
- Patterns that work/don't work
- User preferences discovered
- System behaviors noted
- Append to MEMORY.md

## Step 10: Re-ingest memory to knowledge base

Full reference: `.claude/skills/knowledge-base/SKILL.md`

Keep your memory collection searchable and current:

```bash
cortextos bus kb-ingest ./MEMORY.md ./memory/$(date -u +%Y-%m-%d).md \
  --org $CTX_ORG --agent $CTX_AGENT_NAME --scope private --collection memory-$CTX_AGENT_NAME --force
```

This runs automatically on every heartbeat cycle. It ensures past experiences, user preferences, and learned patterns are semantically searchable for future tasks. Skip if GEMINI_API_KEY is not configured.

---

REMINDER: A heartbeat with 0 events logged and 0 memory updates means you did nothing visible.
Target: >= 2 events and >= 1 memory update per heartbeat cycle.
Invisible work is wasted work.
