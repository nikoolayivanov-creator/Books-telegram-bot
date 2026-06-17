import Database from "better-sqlite3";

export type EventInput = {
  ts: number;
  user_id: number;
  event_type: "search" | "download";
  query?: string;
  book_title?: string;
  book_id?: number;
  author?: string;
  genre?: string;
  format?: string;
  size_bytes?: number;
};

export type Db = {
  logEvent(e: EventInput): void;
  countEventsSince(userId: number, fromTs: number, toTs: number): number;
  countSince(userId: number, eventType: "search" | "download", fromTs: number): number;
  topBooks(days: number): { book_title: string; cnt: number }[];
  topAuthors(days: number): { author: string; cnt: number }[];
  topFormats(days: number): { format: string; cnt: number }[];
  activeUsers(days: number): { user_id: number; cnt: number }[];
  getStats(days: number): {
    totalSearches: number; totalDownloads: number; activeUsers: number;
  };
  cleanupOldEvents(olderThanTs: number): number;
  close(): void;
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  query TEXT,
  book_title TEXT,
  book_id INTEGER,
  author TEXT,
  genre TEXT,
  format TEXT,
  size_bytes INTEGER
);
CREATE INDEX IF NOT EXISTS idx_events_user_ts ON events(user_id, ts);
CREATE INDEX IF NOT EXISTS idx_events_type_ts ON events(event_type, ts);
`;

export function createDb(path: string): Db {
  const d = new Database(path);
  d.exec(SCHEMA);

  const insert = d.prepare(`INSERT INTO events
    (ts, user_id, event_type, query, book_title, book_id, author, genre, format, size_bytes)
    VALUES (@ts, @user_id, @event_type, @query, @book_title, @book_id, @author, @genre, @format, @size_bytes)`);

  const sinceTs = (days: number): number =>
    Math.floor(Date.now() / 1000) - days * 86400;

  return {
    logEvent(e) {
      insert.run({
        ts: e.ts, user_id: e.user_id, event_type: e.event_type,
        query: e.query ?? null, book_title: e.book_title ?? null,
        book_id: e.book_id ?? null, author: e.author ?? null,
        genre: e.genre ?? null, format: e.format ?? null,
        size_bytes: e.size_bytes ?? null,
      });
    },
    countEventsSince(userId, fromTs, toTs) {
      const r = d.prepare(
        `SELECT COUNT(*) c FROM events WHERE user_id=? AND ts>=? AND ts<?`
      ).get(userId, fromTs, toTs) as { c: number };
      return r.c;
    },
    countSince(userId, eventType, fromTs) {
      const r = d.prepare(
        `SELECT COUNT(*) c FROM events WHERE user_id=? AND event_type=? AND ts>=?`
      ).get(userId, eventType, fromTs) as { c: number };
      return r.c;
    },
    topBooks(days) {
      return d.prepare(
        `SELECT book_title, COUNT(*) cnt FROM events
         WHERE event_type='download' AND book_title IS NOT NULL AND ts>=?
         GROUP BY book_title ORDER BY cnt DESC LIMIT 10`
      ).all(sinceTs(days)) as { book_title: string; cnt: number }[];
    },
    topAuthors(days) {
      return d.prepare(
        `SELECT author, COUNT(*) cnt FROM events
         WHERE event_type='download' AND author IS NOT NULL AND ts>=?
         GROUP BY author ORDER BY cnt DESC LIMIT 10`
      ).all(sinceTs(days)) as { author: string; cnt: number }[];
    },
    topFormats(days) {
      return d.prepare(
        `SELECT format, COUNT(*) cnt FROM events
         WHERE event_type='download' AND format IS NOT NULL AND ts>=?
         GROUP BY format ORDER BY cnt DESC`
      ).all(sinceTs(days)) as { format: string; cnt: number }[];
    },
    activeUsers(days) {
      return d.prepare(
        `SELECT user_id, COUNT(*) cnt FROM events WHERE ts>=?
         GROUP BY user_id ORDER BY cnt DESC LIMIT 10`
      ).all(sinceTs(days)) as { user_id: number; cnt: number }[];
    },
    getStats(days) {
      const f = sinceTs(days);
      const s = d.prepare(
        `SELECT SUM(event_type='search') sc, SUM(event_type='download') dl,
                COUNT(DISTINCT user_id) au FROM events WHERE ts>=?`
      ).get(f) as { sc: number | null; dl: number | null; au: number | null };
      return {
        totalSearches: s.sc ?? 0, totalDownloads: s.dl ?? 0, activeUsers: s.au ?? 0,
      };
    },
    cleanupOldEvents(olderThanTs) {
      const r = d.prepare(`DELETE FROM events WHERE ts<?`).run(olderThanTs);
      return r.changes;
    },
    close() { d.close(); },
  };
}