import type { Llm } from "./llm.js";
import type { Flibusta, FlibustaBook } from "./flibusta.js";

export type SearchResult = { books: FlibustaBook[]; degraded: boolean; lowRelevance?: boolean };

const norm = (s: string): string =>
  s.toLowerCase().replace(/[«»"'!.,?;:()\[\]]/g, " ").replace(/\s+/g, " ").trim();

// Мягкий порог релевантности. Если лучшее совпадение слабее (ни название, ни
// автор не попали) — выдача помечается lowRelevance, бот показывает «по приближению».
// Граница 50 выше авторских токенов (~16) и автор-includes (30) — legit-случаи
// вроде запроса только по автору или по слову названия остаются в нормальной выдаче.
const MIN_RELEVANCE = 50;

// Детерминированная релевантность. Оцениваем не по сырому запросу, а по тому,
// что LLM уже отделил: название (title) и авторы (authors). Иначе флексии
// автора («джеком», «лондоном») подтягивали посторонние книги вровень с точным
// совпадением названия. Точное совпадение названия решает однозначно.
export function relevance(pt: string, authors: string[], series: string | undefined, book: FlibustaBook): number {
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
  // Серия: конкретный сигнал, слабее совпадения названия, сильнее авторских
  // токенов. Срабатывает только если LLM вытащил серию из запроса — иначе ветка
  // пропускается и на ранг нулевой эффект (старые тесты, серия не задана).
  if (series) {
    const sn = norm(series);
    const bn = norm(book.series ?? "");
    if (sn && bn) {
      if (bn === sn) score += 60;
      else if (bn.includes(sn) || sn.includes(bn)) score += 30;
    }
  }
  return score;
}

export function createOrchestrator(
  llm: Llm,
  flibusta: Flibusta,
  opts: { cacheTtlSec?: number; cacheMax?: number } = {},
) {
  // In-memory кэш результатов поиска. Одинаковые запросы разных пользователей
  // («пелевин», «гари поттер») иначе бьют по flibusta и LLM десятками раз.
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
    async search(
      rawQuery: string,
      topN: number,
      onProgress?: (phase: "parsing" | "searching") => void,
    ): Promise<SearchResult> {
      const key = norm(rawQuery);
      const hit = cacheGet(key);
      if (hit) return hit; // кэш-хит — onProgress не зовётся, быстрый путь без статуса

      let parsed;
      let degraded = false;
      try {
        onProgress?.("parsing");
        parsed = await llm.parseQuery(rawQuery);
      } catch (e) {
        // Деградация: запрос целиком как title, без разбора. Сюда же падает
        // таймаут LLM — логируем, чтобы видеть частоту уходов в degraded.
        console.warn("llm parse failed, degraded:", (e as Error).message);
        parsed = { title: rawQuery };
        degraded = true;
      }

      onProgress?.("searching");
      // UNION: LLM-разбор и детерминированный split-search — параллельно.
      // split покрывает кейсы, где LLM промахивается (author-only, грязные
      // реальные запросы) и служит страховкой при падении LLM. Каждый пул
      // оценивается своим разбором; в общий пул книга идёт с максимумом оценок
      // — «лучший сценарий» её нахождения. ~80% rel@3 против 69% у LLM-соло.
      const [llmRaw, splitRaw] = await Promise.all([
        flibusta.searchBooks(parsed).catch(() => [] as FlibustaBook[]),
        flibusta
          .splitSearchBooks(rawQuery)
          .catch(() => [] as Array<{ book: FlibustaBook; pt: string; authors: string[] }>),
      ]);

      const pt = norm(parsed.title ?? rawQuery);
      const authors = parsed.authors ?? [];
      // При равной релевантности — популярное издание (больше скачиваний) выше.
      const dl = (b: FlibustaBook): number =>
        parseInt(String(b.downloadsCount ?? "").replace(/\D/g, "")) || 0;
      const pool = new Map<string, { b: FlibustaBook; s: number }>();
      const merge = (b: FlibustaBook, s: number): void => {
        const k = norm(b.title) + "|" + norm(b.author ?? "");
        const ex = pool.get(k);
        if (!ex || s > ex.s) pool.set(k, { b, s });
      };
      for (const b of llmRaw) merge(b, relevance(pt, authors, parsed.series, b));
      for (const r of splitRaw) merge(r.book, relevance(r.pt, r.authors, undefined, r.book));

      if (!pool.size) {
        // Пустой результат кэшируем — легитимное «ничего нет», спасает от
        // повторных вызовов на опечатки и несуществующие книги.
        cachePut(key, { books: [], degraded });
        return { books: [], degraded };
      }

      const scored = [...pool.values()].sort((a, z) => z.s - a.s || dl(z.b) - dl(a.b));
      const books = scored.slice(0, topN).map((x) => x.b);
      // Мягкий порог: лучшее совпадение слабое — помечаем выдачу, но книги не режем.
      // В degraded не применяется: там title = сырой запрос, score всегда низкий.
      const bestScore = scored[0]?.s ?? 0;
      const lowRelevance = !degraded && bestScore < MIN_RELEVANCE;
      const result: SearchResult = lowRelevance
        ? { books, degraded, lowRelevance: true }
        : { books, degraded };
      // Деградированный результат НЕ кэшируем: LLM мог отключиться временно,
      // повторный запрос через минуту должен разобраться нормально.
      if (!degraded) cachePut(key, result);
      return result;
    },
  };
}
