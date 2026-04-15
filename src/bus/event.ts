import { appendFileSync, existsSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import type { EventCategory, EventSeverity, BusPaths } from '../types/index.js';
import { ensureDir } from '../utils/atomic.js';
import { randomString } from '../utils/random.js';
import { validateEventCategory, validateEventSeverity, isValidJson } from '../utils/validate.js';
import { notifySubscribers } from './subscriptions.js';

/**
 * Log a structured event. Appends JSONL line to daily event file.
 * Identical to bash log-event.sh format.
 *
 * Events are stored at: {analyticsDir}/events/{agent}/{YYYY-MM-DD}.jsonl
 */
export function logEvent(
  paths: BusPaths,
  agentName: string,
  org: string,
  category: EventCategory,
  eventName: string,
  severity: EventSeverity,
  metadata?: Record<string, unknown> | string,
): void {
  validateEventCategory(category);
  validateEventSeverity(severity);

  // Parse metadata if it's a string
  let meta: Record<string, unknown> = {};
  if (typeof metadata === 'string') {
    if (isValidJson(metadata)) {
      meta = JSON.parse(metadata);
    }
  } else if (metadata) {
    meta = metadata;
  }

  const epoch = Math.floor(Date.now() / 1000);
  const rand = randomString(5);
  const eventId = `${epoch}-${agentName}-${rand}`;
  const timestamp = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');

  const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
  const eventsDir = join(paths.analyticsDir, 'events', agentName);
  ensureDir(eventsDir);

  const eventLine = JSON.stringify({
    id: eventId,
    agent: agentName,
    org,
    timestamp,
    category,
    event: eventName,
    severity,
    metadata: meta,
  });

  appendFileSync(join(eventsDir, `${today}.jsonl`), eventLine + '\n', 'utf-8');

  // Route matching events to subscribed agents' inboxes
  notifySubscribers(paths, org, agentName, {
    category,
    event: eventName,
    severity,
    id: eventId,
    metadata: meta,
  });
}

export interface QueryEventsOptions {
  agent?: string;
  eventType?: string;
  category?: string;
  severity?: string;
  days?: number;
  limit?: number;
}

/**
 * Query events from JSONL files with filtering.
 * Returns matching events sorted newest-first.
 */
export function queryEvents(
  analyticsDir: string,
  options: QueryEventsOptions = {},
): Record<string, unknown>[] {
  const { agent, eventType, category, severity, days = 7, limit = 100 } = options;
  const eventsBaseDir = join(analyticsDir, 'events');

  // Determine date range
  const endDate = new Date();
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - days);

  // Collect agent directories to scan
  let agentDirs: string[] = [];
  if (agent) {
    const agentDir = join(eventsBaseDir, agent);
    if (existsSync(agentDir)) agentDirs = [agentDir];
  } else {
    try {
      agentDirs = readdirSync(eventsBaseDir, { withFileTypes: true })
        .filter(d => d.isDirectory())
        .map(d => join(eventsBaseDir, d.name));
    } catch {
      return [];
    }
  }

  const results: Record<string, unknown>[] = [];

  for (const agentDir of agentDirs) {
    // Scan date-named JSONL files within range
    let files: string[];
    try {
      files = readdirSync(agentDir).filter(f => f.endsWith('.jsonl')).sort().reverse();
    } catch {
      continue;
    }

    for (const file of files) {
      const dateStr = file.replace('.jsonl', '');
      const fileDate = new Date(dateStr + 'T00:00:00Z');
      if (fileDate < startDate || fileDate > endDate) continue;

      let lines: string[];
      try {
        lines = readFileSync(join(agentDir, file), 'utf-8').trim().split('\n').filter(Boolean);
      } catch {
        continue;
      }

      // Process lines in reverse (newest first)
      for (let i = lines.length - 1; i >= 0; i--) {
        let event: Record<string, unknown>;
        try {
          event = JSON.parse(lines[i]);
        } catch {
          continue;
        }

        if (eventType && event.event !== eventType) continue;
        if (category && event.category !== category) continue;
        if (severity && event.severity !== severity) continue;

        results.push(event);
        if (results.length >= limit) return results;
      }
    }
  }

  return results;
}
