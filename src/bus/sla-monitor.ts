import { existsSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import type { BusPaths } from '../types/index.js';

export interface SLARule {
  id: string;
  type: 'heartbeat_staleness' | 'event_pair_ordering' | 'event_cadence' | 'response_time';
  agent: string | '*';
  description: string;
  // For heartbeat_staleness: max age in seconds before violation
  max_age_s?: number;
  // For event_pair_ordering: first event must precede second within window
  first_event?: string;
  second_event?: string;
  max_gap_s?: number;
  // For event_cadence: event must fire at least once every N seconds
  event_pattern?: string;
  cadence_s?: number;
}

export interface SLAViolation {
  rule_id: string;
  rule_type: string;
  agent: string;
  description: string;
  details: Record<string, unknown>;
  detected_at: string;
}

/**
 * Load SLA rules from org config.
 */
export function loadSLARules(ctxRoot: string, org: string): SLARule[] {
  const p = join(ctxRoot, 'orgs', org, 'config', 'event-sla-rules.json');
  if (!existsSync(p)) return defaultRules();
  try {
    return JSON.parse(readFileSync(p, 'utf-8'));
  } catch {
    return defaultRules();
  }
}

function defaultRules(): SLARule[] {
  return [
    {
      id: 'heartbeat-staleness',
      type: 'heartbeat_staleness',
      agent: '*',
      description: 'Agent heartbeat must update within 5 hours',
      max_age_s: 18000,
    },
    {
      id: 'pre-commit-precedes-commit',
      type: 'event_pair_ordering',
      agent: '*',
      description: 'pre_commit_symbol_scan must precede commit_made within 5 minutes',
      first_event: 'pre_commit_symbol_scan',
      second_event: 'commit_made',
      max_gap_s: 300,
    },
    {
      id: 'slice-complete-cadence',
      type: 'event_cadence',
      agent: '*',
      description: 'Coding agents should emit slice_complete at least once per 8 hours of active work',
      event_pattern: 'slice_complete',
      cadence_s: 28800,
    },
  ];
}

/**
 * Check all SLA rules against recent events and heartbeats.
 * Returns a list of violations.
 */
export function checkSLA(
  paths: BusPaths,
  ctxRoot: string,
  org: string,
): SLAViolation[] {
  const rules = loadSLARules(ctxRoot, org);
  const violations: SLAViolation[] = [];
  const now = Date.now();

  // Discover agents
  const agents = discoverAgents(ctxRoot, org);

  for (const rule of rules) {
    const targetAgents = rule.agent === '*' ? agents : [rule.agent];

    for (const agent of targetAgents) {
      switch (rule.type) {
        case 'heartbeat_staleness':
          checkHeartbeatStaleness(ctxRoot, agent, rule, now, violations);
          break;
        case 'event_pair_ordering':
          checkEventPairOrdering(paths, agent, rule, violations);
          break;
        case 'event_cadence':
          checkEventCadence(paths, agent, rule, now, violations);
          break;
      }
    }
  }

  return violations;
}

function discoverAgents(ctxRoot: string, org: string): string[] {
  const stateDir = join(ctxRoot, 'state');
  if (!existsSync(stateDir)) return [];
  try {
    return readdirSync(stateDir, { withFileTypes: true })
      .filter(d => d.isDirectory() && d.name !== '.git')
      .map(d => d.name);
  } catch {
    return [];
  }
}

function checkHeartbeatStaleness(
  ctxRoot: string,
  agent: string,
  rule: SLARule,
  now: number,
  violations: SLAViolation[],
): void {
  const hbPath = join(ctxRoot, 'state', agent, 'heartbeat.json');
  if (!existsSync(hbPath)) return;
  try {
    const hb = JSON.parse(readFileSync(hbPath, 'utf-8'));
    const ts = hb.last_heartbeat;
    if (!ts) return;
    const hbTime = new Date(ts).getTime();
    const ageMs = now - hbTime;
    const maxMs = (rule.max_age_s || 18000) * 1000;
    if (ageMs > maxMs) {
      violations.push({
        rule_id: rule.id,
        rule_type: rule.type,
        agent,
        description: rule.description,
        details: {
          last_heartbeat: ts,
          age_s: Math.floor(ageMs / 1000),
          threshold_s: rule.max_age_s,
        },
        detected_at: new Date().toISOString(),
      });
    }
  } catch { /* skip unreadable heartbeat */ }
}

function checkEventPairOrdering(
  paths: BusPaths,
  agent: string,
  rule: SLARule,
  violations: SLAViolation[],
): void {
  if (!rule.first_event || !rule.second_event) return;
  const today = new Date().toISOString().split('T')[0];
  const eventsFile = join(paths.analyticsDir, 'events', agent, `${today}.jsonl`);
  if (!existsSync(eventsFile)) return;

  try {
    const lines = readFileSync(eventsFile, 'utf-8').trim().split('\n').filter(Boolean);
    let lastFirst: string | null = null;

    for (const line of lines) {
      const event = JSON.parse(line);
      if (event.event === rule.first_event) {
        lastFirst = event.timestamp;
      } else if (event.event === rule.second_event) {
        if (!lastFirst) {
          violations.push({
            rule_id: rule.id,
            rule_type: rule.type,
            agent,
            description: `${rule.second_event} fired without preceding ${rule.first_event}`,
            details: { second_event_id: event.id, second_event_ts: event.timestamp },
            detected_at: new Date().toISOString(),
          });
        } else {
          const gap = new Date(event.timestamp).getTime() - new Date(lastFirst).getTime();
          if (gap > (rule.max_gap_s || 300) * 1000) {
            violations.push({
              rule_id: rule.id,
              rule_type: rule.type,
              agent,
              description: `${rule.second_event} fired ${Math.floor(gap / 1000)}s after ${rule.first_event} (max: ${rule.max_gap_s}s)`,
              details: { gap_s: Math.floor(gap / 1000), first_ts: lastFirst, second_ts: event.timestamp },
              detected_at: new Date().toISOString(),
            });
          }
          lastFirst = null;
        }
      }
    }
  } catch { /* skip unreadable events */ }
}

function checkEventCadence(
  paths: BusPaths,
  agent: string,
  rule: SLARule,
  now: number,
  violations: SLAViolation[],
): void {
  if (!rule.event_pattern || !rule.cadence_s) return;
  const eventsDir = join(paths.analyticsDir, 'events', agent);
  if (!existsSync(eventsDir)) return;

  // Find the most recent matching event across recent JSONL files
  let lastMatch: string | null = null;
  try {
    const files = readdirSync(eventsDir).filter(f => f.endsWith('.jsonl')).sort().reverse();
    for (const file of files.slice(0, 3)) { // Check last 3 days
      const lines = readFileSync(join(eventsDir, file), 'utf-8').trim().split('\n').filter(Boolean);
      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          const event = JSON.parse(lines[i]);
          if (event.event === rule.event_pattern) {
            lastMatch = event.timestamp;
            break;
          }
        } catch { continue; }
      }
      if (lastMatch) break;
    }
  } catch { return; }

  if (lastMatch) {
    const age = now - new Date(lastMatch).getTime();
    if (age > rule.cadence_s * 1000) {
      violations.push({
        rule_id: rule.id,
        rule_type: rule.type,
        agent,
        description: rule.description,
        details: {
          last_event_ts: lastMatch,
          age_s: Math.floor(age / 1000),
          cadence_threshold_s: rule.cadence_s,
        },
        detected_at: new Date().toISOString(),
      });
    }
  }
}
