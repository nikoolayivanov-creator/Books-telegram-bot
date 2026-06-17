import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createAnalytics } from "../src/analytics.js";
import { createDb, type Db } from "../src/db.js";

describe("analytics", () => {
  let db: Db;
  let now: number;
  beforeEach(() => {
    db = createDb(":memory:");
    now = 1_000_000;
    vi.useFakeTimers();
    vi.setSystemTime(now * 1000);
  });
  afterEach(() => { db.close(); vi.useRealTimers(); });

  it("logs a search with current timestamp", () => {
    const a = createAnalytics(db);
    a.logSearch(5, "пелевин");
    expect(db.countEventsSince(5, now - 1, now + 1)).toBe(1);
  });

  it("logs a download with book fields", () => {
    const a = createAnalytics(db);
    a.logDownload(5, { book_title: "S.N.U.F.F.", book_id: 9, author: "Пелевин", genre: "фантастика", format: "epub", size_bytes: 500000 });
    expect(db.topBooks(30)[0].book_title).toBe("S.N.U.F.F.");
  });

  it("formats a stats report", () => {
    const a = createAnalytics(db);
    a.logSearch(1, "x");
    a.logDownload(2, { book_title: "y", book_id: 1, format: "fb2", size_bytes: 10 });
    const report = a.report(30);
    expect(report).toContain("Поисков: 1");
    expect(report).toContain("Скачиваний: 1");
    expect(report).toContain("Активных: 2");
  });
});