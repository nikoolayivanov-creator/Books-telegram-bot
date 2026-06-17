import type { Db } from "./db.js";

export type DownloadMeta = {
  book_title: string;
  book_id: number;
  author?: string;
  genre?: string;
  format: string;
  size_bytes: number;
};

export type Analytics = {
  logSearch(userId: number, query: string): void;
  logDownload(userId: number, meta: DownloadMeta): void;
  report(days: number): string;
  countSince(userId: number, eventType: "search" | "download", fromTs: number): number;
};

export function createAnalytics(db: Db): Analytics {
  const ts = () => Math.floor(Date.now() / 1000);

  return {
    logSearch(userId, query) {
      db.logEvent({ ts: ts(), user_id: userId, event_type: "search", query });
    },
    logDownload(userId, meta) {
      db.logEvent({
        ts: ts(), user_id: userId, event_type: "download",
        book_title: meta.book_title, book_id: meta.book_id,
        author: meta.author, genre: meta.genre,
        format: meta.format, size_bytes: meta.size_bytes,
      });
    },
    report(days) {
      const totals = db.getStats(days);
      const books = db.topBooks(days).slice(0, 5);
      const formats = db.topFormats(days);
      const lines: string[] = [
        `Статистика за ${days} дн.`,
        `Поисков: ${totals.totalSearches}`,
        `Скачиваний: ${totals.totalDownloads}`,
        `Активных: ${totals.activeUsers}`,
      ];
      if (books.length) {
        lines.push("", "Топ книг:");
        books.forEach((b, i) => lines.push(`${i + 1}. ${b.book_title} — ${b.cnt}`));
      }
      if (formats.length) {
        lines.push("", "Форматы:");
        formats.forEach((f) => lines.push(`${f.format}: ${f.cnt}`));
      }
      return lines.join("\n");
    },
    countSince(userId, eventType, fromTs) {
      return db.countSince(userId, eventType, fromTs);
    },
  };
}