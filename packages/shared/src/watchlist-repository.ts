import type { WatchlistRecord } from "@signal-console/domain";

import {
  currentTimestamp,
  executeDatabaseOperation,
  getDatabase,
} from "./db-core";

export function getWatchlist(): WatchlistRecord[] {
  return executeDatabaseOperation("watchlist.list", () => {
    const db = getDatabase();
    return db
      .prepare(
        `
          SELECT
            event_id AS eventId,
            priority,
            status,
            note,
            updated_at AS updatedAt
          FROM watchlist
          ORDER BY updated_at DESC
        `
      )
      .all() as WatchlistRecord[];
  });
}

export function upsertWatchlist(entry: {
  eventId: string;
  priority?: number | null;
  status?: "queued" | "monitoring";
  note?: string | null;
}) {
  executeDatabaseOperation(
    "watchlist.upsert",
    () => {
      const db = getDatabase();
      const updatedAt = currentTimestamp();
      db.prepare(
        `
          INSERT INTO watchlist (event_id, priority, status, note, updated_at)
          VALUES (@eventId, @priority, @status, @note, @updatedAt)
          ON CONFLICT(event_id) DO UPDATE SET
            priority = excluded.priority,
            status = excluded.status,
            note = excluded.note,
            updated_at = excluded.updated_at
        `
      ).run({
        eventId: entry.eventId,
        priority: entry.priority ?? null,
        status: entry.status ?? "queued",
        note: entry.note ?? null,
        updatedAt,
      });
    },
    {
      eventId: entry.eventId,
      status: entry.status ?? "queued",
    }
  );
}

export function deleteWatchlist(eventId: string) {
  executeDatabaseOperation(
    "watchlist.delete",
    () => {
      const db = getDatabase();
      db.prepare("DELETE FROM watchlist WHERE event_id = ?").run(eventId);
    },
    {
      eventId,
    }
  );
}
