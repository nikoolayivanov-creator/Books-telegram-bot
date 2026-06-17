import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createDb, type Db } from "../src/db.js";

describe("db", () => {
  let db: Db;
  // Окна topBooks/getStats и т.п. считают от Date.now(). Фиксируем now=epoch,
  // чтобы sinceTs(days) стал отрицательным и события с маленькими ts попадали в окно.
  beforeEach(() => { vi.useFakeTimers({ now: new Date(0) }); db = createDb(":memory:"); });
  afterEach(() => { db.close(); vi.useRealTimers(); });

  it("inserts and counts a search event", () => {
    db.logEvent({ ts: 1000, user_id: 42, event_type: "search", query: "шерлок" });
    expect(db.countEventsSince(42, 999, 1001)).toBe(1);
  });

  it("inserts a download event with book fields", () => {
    db.logEvent({
      ts: 2000, user_id: 42, event_type: "download",
      book_title: "Глория Скотт", book_id: 214600, author: "Конан Дойль",
      genre: "детектив", format: "fb2", size_bytes: 62000,
    });
    const rows = db.topBooks(30);
    expect(rows[0].book_title).toBe("Глория Скотт");
    expect(rows[0].cnt).toBe(1);
  });

  it("rate limit counter sums search+download in window", () => {
    db.logEvent({ ts: 100, user_id: 7, event_type: "search", query: "a" });
    db.logEvent({ ts: 110, user_id: 7, event_type: "download", book_title: "b", book_id: 1 });
    expect(db.countEventsSince(7, 0, 120)).toBe(2);
  });

  it("cleanupOldEvents removes rows older than ttl", () => {
    db.logEvent({ ts: 1, user_id: 1, event_type: "search", query: "old" });
    db.logEvent({ ts: 9999, user_id: 1, event_type: "search", query: "new" });
    const removed = db.cleanupOldEvents(5000);
    expect(removed).toBe(1);
  });

  it("getStats aggregates totals", () => {
    db.logEvent({ ts: 100, user_id: 1, event_type: "search", query: "x" });
    db.logEvent({ ts: 100, user_id: 2, event_type: "download", book_title: "y", book_id: 1, format: "epub", size_bytes: 10 });
    const s = db.getStats(30);
    expect(s.totalSearches).toBe(1);
    expect(s.totalDownloads).toBe(1);
    expect(s.activeUsers).toBe(2);
  });
});