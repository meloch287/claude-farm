// Event bus for "Клауд Ферма": stamps seq/ts, keeps in-memory history,
// best-effort JSONL log, never lets a bad subscriber break the pipeline.

import { appendFile } from 'node:fs';

const HISTORY_LIMIT = 500;

/**
 * Create an event bus.
 * @param {{logFile?: string}} [options]
 * @returns {{emit(partialEvent: object): object, subscribe(fn: Function): () => void, history(): object[]}}
 */
export function createEventBus({ logFile } = {}) {
  let seq = 0;
  const events = [];
  const subscribers = new Set();

  function emit(partialEvent) {
    // Stamps go last so a partial event can never override seq/ts.
    const event = {
      ...partialEvent,
      seq: ++seq,
      ts: new Date().toISOString(),
    };

    // Keep only the last HISTORY_LIMIT events in memory.
    events.push(event);
    if (events.length > HISTORY_LIMIT) {
      events.splice(0, events.length - HISTORY_LIMIT);
    }

    // Best-effort JSONL append: fs errors are deliberately ignored.
    if (logFile) {
      try {
        appendFile(logFile, JSON.stringify(event) + '\n', () => {});
      } catch {
        // ignore fs errors (missing dir, permissions, etc.)
      }
    }

    // Notify subscribers; iterate over a snapshot so that unsubscribing
    // mid-notification is safe, and swallow subscriber errors.
    for (const fn of [...subscribers]) {
      try {
        fn(event);
      } catch {
        // a broken subscriber must never break the farm
      }
    }

    return event;
  }

  function subscribe(fn) {
    subscribers.add(fn);
    return () => {
      subscribers.delete(fn);
    };
  }

  function history() {
    return events.slice();
  }

  return { emit, subscribe, history };
}
