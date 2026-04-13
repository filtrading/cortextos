// cortextOS Dashboard - Chokidar file watcher singleton
// Monitors CTX_ROOT for JSON/JSONL changes, syncs to SQLite, emits SSE events.

import { EventEmitter } from 'events';
import { watch, type FSWatcher } from 'chokidar';
import fs from 'fs';
import path from 'path';
import { CTX_ROOT, getOrgs } from './config';
import { syncFile, syncAll, extractOrgFromPath } from './sync';
import type { SSEEvent } from './types';

// ---------------------------------------------------------------------------
// globalThis singleton pattern (survives Next.js hot reloads)
// ---------------------------------------------------------------------------

const globalForWatcher = globalThis as unknown as {
  __cortextos_emitter: EventEmitter | undefined;
  __cortextos_watcher: FSWatcher | undefined;
};

export const emitter: EventEmitter =
  globalForWatcher.__cortextos_emitter ?? new EventEmitter();
emitter.setMaxListeners(100); // support many concurrent SSE clients

if (process.env.NODE_ENV !== 'production') {
  globalForWatcher.__cortextos_emitter = emitter;
}

// ---------------------------------------------------------------------------
// Per-event tail-diff state (slice_003 RC-3 fix)
// ---------------------------------------------------------------------------

// Per-file line count, used to compute the [prevCount, currentCount) window
// of newly-appended JSONL records on each chokidar change event. Process-local;
// re-seeded from disk by seedEventLineCounts() on first initWatcher() call.
const eventLineCount = new Map<string, number>();

// SSEEvent.type is `EventType | 'sync'`. We can only emit values from this
// set; unknown event categories are normalized to 'action' so the live feed
// still renders them with the generic icon.
const KNOWN_EVENT_TYPES = new Set<string>([
  'action',
  'message',
  'task',
  'approval',
  'error',
  'milestone',
  'heartbeat',
]);

function normalizeSseType(
  category: string | undefined,
  fallback: string | undefined,
): SSEEvent['type'] {
  const cat = category ?? fallback ?? 'action';
  return (KNOWN_EVENT_TYPES.has(cat) ? cat : 'action') as SSEEvent['type'];
}

// Read an event JSONL file, diff against the last known line count, and emit
// one SSE per newly-appended line with the canonical EventFeed shape.
// First sighting (no prevCount) records the count and emits nothing — the
// initial backfill is handled by seedEventLineCounts() during initWatcher().
// Truncation/rotation (length-shrink) resets the count and emits nothing.
function emitNewEventRecords(filePath: string): void {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf-8');
  } catch {
    return;
  }
  const lines = raw.split('\n').filter((l) => l.trim());
  const prevCount = eventLineCount.get(filePath);

  if (prevCount === undefined) {
    eventLineCount.set(filePath, lines.length);
    return;
  }
  if (lines.length < prevCount) {
    eventLineCount.set(filePath, lines.length);
    return;
  }

  const org = extractOrgFromPath(filePath) ?? '';
  for (let i = prevCount; i < lines.length; i++) {
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    const metadata =
      (event.metadata as Record<string, unknown> | undefined) ??
      (event.data as Record<string, unknown> | undefined) ??
      {};
    const sseEvent: SSEEvent = {
      type: normalizeSseType(
        event.category as string | undefined,
        event.type as string | undefined,
      ),
      timestamp:
        (event.timestamp as string | undefined) ?? new Date().toISOString(),
      data: {
        ...metadata,
        agent: event.agent ?? '',
        org,
        category: event.category ?? '',
        severity: event.severity ?? 'info',
        message: event.event ?? event.message ?? '',
      },
    };
    emitter.emit('sse', sseEvent);
  }
  eventLineCount.set(filePath, lines.length);
}

// Pre-populate eventLineCount with the current line count of every event
// JSONL file on disk. Without this seed, the first chokidar change event for
// an existing file would be treated as a backfill and dropped from the live
// feed. Called once from initWatcher() after syncAll().
function seedEventLineCounts(): void {
  const orgs = getOrgs();
  for (const org of orgs) {
    const eventsBaseDir = path.join(CTX_ROOT, 'orgs', org, 'analytics', 'events');
    if (!fs.existsSync(eventsBaseDir)) continue;
    const agentDirs = fs
      .readdirSync(eventsBaseDir, { withFileTypes: true })
      .filter((d) => d.isDirectory());
    for (const dir of agentDirs) {
      const agentEventsDir = path.join(eventsBaseDir, dir.name);
      let files: string[];
      try {
        files = fs.readdirSync(agentEventsDir).filter((f) => f.endsWith('.jsonl'));
      } catch {
        continue;
      }
      for (const file of files) {
        const filePath = path.join(agentEventsDir, file);
        try {
          const raw = fs.readFileSync(filePath, 'utf-8');
          const count = raw.split('\n').filter((l) => l.trim()).length;
          eventLineCount.set(filePath, count);
        } catch {
          // skip unreadable files
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Watch path builder
// ---------------------------------------------------------------------------

function getWatchPaths(): string[] {
  const paths: string[] = [];
  const orgs = getOrgs();

  for (const org of orgs) {
    const orgBase = path.join(CTX_ROOT, 'orgs', org);
    paths.push(path.join(orgBase, 'tasks', '**', '*.json'));
    paths.push(path.join(orgBase, 'approvals', '**', '*.json'));
    paths.push(path.join(orgBase, 'analytics', 'events', '**', '*.jsonl'));
  }

  // Flat paths (not org-scoped)
  paths.push(path.join(CTX_ROOT, 'state', '*', 'heartbeat.json'));
  paths.push(path.join(CTX_ROOT, 'inbox', '**', '*.json'));

  return paths;
}

// ---------------------------------------------------------------------------
// File change handler
// ---------------------------------------------------------------------------

function categorizeFilePath(filePath: string): SSEEvent['type'] {
  if (filePath.includes('/tasks/')) return 'task';
  if (filePath.includes('/approvals/')) return 'approval';
  if (filePath.includes('/heartbeat.json')) return 'heartbeat';
  return 'sync';
}

function handleFileChange(
  filePath: string,
  changeType: 'change' | 'add' | 'remove',
): void {
  console.log(`[watcher] ${changeType}: ${filePath}`);

  // Sync the changed file to SQLite (skip for deletions)
  if (changeType !== 'remove') {
    try {
      syncFile(filePath);
    } catch (err) {
      console.error(`[watcher] Sync failed for ${filePath}:`, err);
    }
  }

  // For event JSONL files, emit per-record SSE so the live feed receives
  // canonical-shape payloads the EventFeed client already reads. For all
  // other paths (tasks, approvals, heartbeats), keep the legacy file-changed
  // notification — those views re-fetch from SQLite on the signal.
  if (
    filePath.includes('/analytics/events/') &&
    filePath.endsWith('.jsonl') &&
    changeType !== 'remove'
  ) {
    emitNewEventRecords(filePath);
    return;
  }

  const sseEvent: SSEEvent = {
    type: categorizeFilePath(filePath),
    data: { filePath, changeType },
    timestamp: new Date().toISOString(),
  };

  emitter.emit('sse', sseEvent);
}

// ---------------------------------------------------------------------------
// Watcher factory
// ---------------------------------------------------------------------------

function createWatcher(): FSWatcher {
  const watchPaths = getWatchPaths();

  if (watchPaths.length === 0) {
    console.warn(
      '[watcher] No paths to watch - CTX_ROOT may not have any orgs yet',
    );
  }

  const watcher = watch(watchPaths, {
    ignoreInitial: true,
    persistent: true,
    awaitWriteFinish: {
      stabilityThreshold: 300,
      pollInterval: 100,
    },
  });

  watcher.on('add', (fp) => handleFileChange(fp, 'add'));
  watcher.on('change', (fp) => handleFileChange(fp, 'change'));
  watcher.on('unlink', (fp) => handleFileChange(fp, 'remove'));
  watcher.on('error', (error) => console.error('[watcher] Error:', error));

  console.log(
    `[watcher] Watching ${watchPaths.length} patterns under ${CTX_ROOT}`,
  );
  return watcher;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Initialize the file watcher singleton.
 * Runs a full sync on first call, then starts watching for incremental changes.
 */
export function initWatcher(): FSWatcher {
  if (globalForWatcher.__cortextos_watcher) {
    return globalForWatcher.__cortextos_watcher;
  }

  console.log('[watcher] Running initial full sync...');
  syncAll();

  // Seed eventLineCount with current line counts so the first chokidar-fired
  // change for an existing file has the correct baseline. Without this, the
  // first append after process start is treated as a backfill and dropped.
  seedEventLineCounts();

  const watcher = createWatcher();

  if (process.env.NODE_ENV !== 'production') {
    globalForWatcher.__cortextos_watcher = watcher;
  }

  return watcher;
}

/**
 * Gracefully close the watcher.
 */
export function stopWatcher(): void {
  if (globalForWatcher.__cortextos_watcher) {
    globalForWatcher.__cortextos_watcher.close();
    globalForWatcher.__cortextos_watcher = undefined;
  }
}

/**
 * Subscribe to SSE events. Returns an unsubscribe function.
 */
export function onSSEEvent(
  handler: (event: SSEEvent) => void,
): () => void {
  emitter.on('sse', handler);
  return () => emitter.off('sse', handler);
}

// Graceful shutdown on process exit
if (typeof process !== 'undefined') {
  const shutdown = () => {
    stopWatcher();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
