import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import type { BusPaths, Priority } from '../types/index.js';
import { atomicWriteSync, ensureDir } from '../utils/atomic.js';
import { randomString } from '../utils/random.js';
import { sendMessage } from './message.js';

export interface EventSubscription {
  id: string;
  subscriber: string;
  event_pattern: string;
  category: string; // '*' for any category
  priority: Priority;
  created_by: string;
  created_at: string;
}

function subscriptionsFilePath(ctxRoot: string, org: string): string {
  return join(ctxRoot, 'orgs', org, 'config', 'event-subscriptions.json');
}

export function getSubscriptions(ctxRoot: string, org: string): EventSubscription[] {
  const p = subscriptionsFilePath(ctxRoot, org);
  if (!existsSync(p)) return [];
  try {
    return JSON.parse(readFileSync(p, 'utf-8'));
  } catch {
    return [];
  }
}

export function addSubscription(
  ctxRoot: string,
  org: string,
  subscriber: string,
  eventPattern: string,
  category: string,
  priority: Priority,
  createdBy: string,
): string {
  const subs = getSubscriptions(ctxRoot, org);
  const existing = subs.find(s =>
    s.subscriber === subscriber &&
    s.event_pattern === eventPattern &&
    s.category === category,
  );
  if (existing) return existing.id;

  const id = `sub_${randomString(8)}`;
  subs.push({
    id,
    subscriber,
    event_pattern: eventPattern,
    category,
    priority,
    created_by: createdBy,
    created_at: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
  });
  const p = subscriptionsFilePath(ctxRoot, org);
  ensureDir(join(p, '..'));
  atomicWriteSync(p, JSON.stringify(subs, null, 2) + '\n');
  return id;
}

export function removeSubscription(
  ctxRoot: string,
  org: string,
  subscriber: string,
  eventPattern: string,
): boolean {
  const subs = getSubscriptions(ctxRoot, org);
  const idx = subs.findIndex(s =>
    s.subscriber === subscriber && s.event_pattern === eventPattern,
  );
  if (idx === -1) return false;
  subs.splice(idx, 1);
  const p = subscriptionsFilePath(ctxRoot, org);
  atomicWriteSync(p, JSON.stringify(subs, null, 2) + '\n');
  return true;
}

/**
 * Check subscriptions and route matching events to subscriber inboxes.
 * Called by logEvent() after writing the event to disk. Failures are
 * silently caught — event logging must never fail due to subscription
 * notification errors.
 */
export function notifySubscribers(
  paths: BusPaths,
  org: string,
  fromAgent: string,
  event: {
    category: string;
    event: string;
    severity: string;
    id: string;
    metadata: Record<string, unknown>;
  },
): void {
  let subs: EventSubscription[];
  try {
    subs = getSubscriptions(paths.ctxRoot, org);
  } catch {
    return;
  }
  if (subs.length === 0) return;

  for (const sub of subs) {
    if (sub.subscriber === fromAgent) continue;

    if (sub.category !== '*' && sub.category !== event.category) continue;

    if (sub.event_pattern !== '*' && sub.event_pattern !== event.event) {
      if (sub.event_pattern.endsWith('*')) {
        const prefix = sub.event_pattern.slice(0, -1);
        if (!event.event.startsWith(prefix)) continue;
      } else {
        continue;
      }
    }

    const envelope =
      `=== EVENT NOTIFICATION [${event.id}] ===\n` +
      `From: ${fromAgent}\n` +
      `Event: ${event.category}/${event.event} (${event.severity})\n` +
      `Metadata: ${JSON.stringify(event.metadata)}\n` +
      `---\n` +
      `Matched subscription "${sub.event_pattern}" (category: ${sub.category}).\n` +
      `Process and ACK via: cortextos bus ack-inbox <msg_id>\n`;

    try {
      sendMessage(paths, fromAgent, sub.subscriber, sub.priority, envelope);
    } catch {
      // Subscription notification must not break event logging
    }
  }
}
