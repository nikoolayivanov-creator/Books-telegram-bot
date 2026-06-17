import type { Llm } from "./llm.js";
import type { Flibusta, FlibustaBook } from "./flibusta.js";

export type SearchResult = { books: FlibustaBook[]; degraded: boolean };

const norm = (s: string): string =>
  s.toLowerCase().replace(/[«»"'!.,?;:()\[\]]/g, " ").replace(/\s+/g, " ").trim();

// Детерминированная релевантность. Оцениваем не по сырому запросу, а по тому,
// что LLM уже отделил: название (title) и авторы (authors). Иначе флексии
// автора («джеком», «лондоном») подтягивали посторонние книги вровень с точным
// совпадением названия. Точное совпадение названия решает однозначно.
function relevance(pt: string, authors: string[], book: FlibustaBook): number {
  const title = norm(book.title);
  const author = norm(book.author ?? "");
  let score = 0;
  if (pt) {
    if (title === pt) score += 1000;
    else if (title.includes(pt)) score += 600;
    else if (pt.includes(title)) score += 400;
    else score += pt.split(" ").filter(Boolean).filter((t) => title.includes(t)).length * 15;
  }
  for (const a of authors) {
    const an = norm(a);
    if (!an) continue;
    if (author.includes(an)) score += 30;
    else score += an.split(" ").filter(Boolean).filter((t) => author.includes(t)).length * 8;
  }
  return score;
}

export function createOrchestrator(
  llm: Llm,
  flibusta: Flibusta,
  opts: { cacheTtlSec?: number; cacheMax?: number } = {},
) {
  // In-memory кэш результатов поиска. Одинаковые запросы разных пользователей
  // («пелевин», «гари поттер») иначе бьют по flibusta и z.ai десятками раз.
  // TTL-кэш отдаёт повторный запрос без единого сетевого вызова. Ранг
  // детерминированный, книги не меняются каждую минуту — кэшировать безопасно.
  // Сбрасывается при рестарте; для поискового кэша персистентность избыточна.
  const ttlMs = (opts.cacheTtlSec ?? 21600) * 1000;
  const max = opts.cacheMax ?? 2000;
  type Entry = { result: SearchResult; expiresAt: number };
  const cache = new Map<string, Entry>();

  const cacheGet = (key: string): SearchResult | undefined => {
    const e = cache.get(key);
    if (!e) return undefined;
    if (Date.now() > e.expiresAt) { cache.delete(key); return undefined; }
    return e.result;
  };
  const cachePut = (key: string, result: SearchResult): void => {
    if (cache.size >= max) {
      const now = Date.now();
      for (const [k, v] of cache) if (now > v.expiresAt) cache.delete(k);
      // Протухших не оказалось — выкидываем самую старую по порядку вставки
      if (cache.size >= max) {
        const oldest = cache.keys().next().value;
        if (oldest !== undefined) cache.delete(oldest);
      }
    }
    cache.set(key, { result, expiresAt: Date.now() + ttlMs });
  };

  return {
    async search(rawQuery: string, topN: number): Promise<SearchResult> {
      const key = norm(rawQuery);
      const hit = cacheGet(key);
      if (hit) return hit;

      let parsed;
      let degraded = false;
      try {
        parsed = await llm.parseQuery(rawQuery);
      } catch (e) {
        // Деградация: запрос целиком как title, без разбора. Сюда же падает
        // таймаут LLM — логируем, чтобы видеть частоту уходов в degraded.
        console.warn("llm parse failed, degraded:", (e as Error).message);
        parsed = { title: rawQuery };
        degraded = true;
      }

      const raw = await flibusta.searchBooks(parsed);
      if (!raw.length) {
        // Пустой результат кэшируем — легитимное «ничего нет», спасает от
        // повторных вызовов на опечатки и несуществующие книги.
        cachePut(key, { books: [], degraded });
        return { books: [], degraded };
      }

      const pt = norm(parsed.title ?? rawQuery);
      const authors = parsed.authors ?? [];
      // При равной релевантности — популярное издание (больше скачиваний) выше.
      const dl = (b: FlibustaBook): number =>
        parseInt(String(b.downloadsCount ?? "").replace(/\D/g, "")) || 0;
      const books = [...raw]
        .map((b) => ({ b, s: relevance(pt, authors, b) }))
        .sort((a, z) => z.s - a.s || dl(z.b) - dl(a.b))
        .slice(0, topN)
        .map((x) => x.b);
      const result: SearchResult = { books, degraded };
      // Деградированный результат НЕ кэшируем: LLM мог отключиться временно,
      // повторный запрос через минуту должен разобраться нормально.
      if (!degraded) cachePut(key, result);
      return result;
    },
  };
}
