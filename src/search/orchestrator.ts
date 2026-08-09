import type { Llm } from "./llm.js";
import type { Flibusta, FlibustaBook } from "./flibusta.js";

export type SearchResult = { books: FlibustaBook[]; degraded: boolean; lowRelevance?: boolean };

// Прогресс поиска для стриминга в чат. paging/author-found приходят из глубины
// пагинации flibusta (через адаптер), parsing/searching/ranking — из самого
// orchestrator. bot.ts сводит это в тексты статусов с throttle.
export type SearchProgress =
  | { kind: "parsing" }
  | { kind: "searching" }
  | { kind: "splitting" }
  | { kind: "title-search" }
  | { kind: "author-found"; author: string; books: number }
  | { kind: "paging"; page: number; totalPages: number; booksSoFar: number; found?: string }
  | { kind: "ranking"; count: number };

const norm = (s: string): string =>
  s.toLowerCase().replace(/ё/g, "е").replace(/[«»"'!.,?;:()\[\]]/g, " ").replace(/\s+/g, " ").trim();

// Мягкий порог релевантности. Если лучшее совпадение слабее (ни название, ни
// автор не попали) — выдача помечается lowRelevance, бот показывает «по приближению».
// Граница 50: совпадение автора (+60) и слова названия (+15×N) перешагивают её,
// автор-only поиск остаётся нормальной выдачей, а не «по приближению».
const MIN_RELEVANCE = 50;

// Левенштейн (DP, два ряда) + нормализованное сходство 1 - dist/maxLen.
// Нужен для fuzzy-матча названия с опечаткой: gpt-4.1-nano не правит «Таяс»→
// «Таис», а триграммы на 4-буквенных словах дают 0 (у {тая,аяс} и {таи,аис}
// нет пересечения). Левенштейн ловит 1 замену: sim(«таяс»,«таис»)=0.75.
function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  let curr = new Array<number>(n + 1);
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n];
}
function similarity(a: string, b: string): number {
  const maxLen = Math.max(a.length, b.length);
  return maxLen ? 1 - levenshtein(a, b) / maxLen : 1;
}

// Детерминированная релевантность. Оцениваем не по сырому запросу, а по тому,
// что LLM уже отделил: название (title) и авторы (authors). Иначе флексии
// автора («джеком», «лондоном») подтягивали посторонние книги вровень с точным
// совпадением названия. Точное совпадение названия решает однозначно.
export function relevance(pt: string, authors: string[], series: string | undefined, book: FlibustaBook): number {
  const title = norm(book.title);
  const author = norm(book.author ?? "");
  let titleScore = 0;
  if (pt) {
    if (title === pt) titleScore += 1000;
    else if (title.includes(pt)) titleScore += 600;
    else if (pt.includes(title)) titleScore += 400;
    else titleScore += pt.split(" ").filter(Boolean).filter((t) => title.includes(t)).length * 15;
  }
  // Fuzzy-матч названия с опечаткой (RC2): LLM не правит «Таяс»→«Таис», и строгое
  // вхождение слова (+15) не набирается. Сравниваем пословно Левенштейном: слово
  // запроса, которого нет в названии точно, но близкое к слову названия (sim>0.7)
  // — считаем опечаткой и даём бонус. Слабее точного вхождения (600), но поднимает
  // книгу над author-only хвостом. Только когда нет сильного совпадения (<100):
  // иначе точное/вхождение уже решили однозначно.
  if (pt && titleScore < 100) {
    const ptWords = pt.split(" ").filter(Boolean);
    const titleWords = title.split(" ").filter(Boolean);
    if (titleWords.length) {
      let fuzzyHits = 0;
      for (const w of ptWords) {
        if (titleWords.includes(w)) continue; // точное слово уже учтено в titleScore
        let best = 0;
        for (const tw of titleWords) best = Math.max(best, similarity(w, tw));
        if (best > 0.7) fuzzyHits++;
      }
      if (fuzzyHits > 0) titleScore += 300 * Math.min(fuzzyHits, 2);
    }
  }
  // Совпадение автора — основной сигнал author-only поиска: не слабее серии
  // (+60) и превышает порог lowRelevance (50), иначе точный поиск по автору
  // помечался бы «по приближению».
  let authorScore = 0;
  let authorMatched = false;
  for (const a of authors) {
    const an = norm(a);
    if (!an) continue;
    if (author.includes(an)) { authorScore += 60; authorMatched = true; }
    else {
      const at = an.split(" ").filter(Boolean);
      const hit = at.filter((t) => author.includes(t));
      if (hit.length) {
        // Полное покрытие токенов — те же имена в другом порядке/с отчеством
        // (LLM «Лев Толстой» vs Flibusta «Толстой Лев Николаевич»). Это надёжное
        // совпадение автора, приравниваем к точному. Частичное — слабый сигнал.
        authorScore += hit.length === at.length ? 60 : hit.length * 8;
        authorMatched = true;
      }
    }
  }
  // Штраф за чужого автора: в запросе есть автор, но книга — не его. Типичный
  // случай — книги ОБ авторе (биографии, литературоведение: «Пушкинская эпоха»
  // Федуты при поиске «Александр Пушкин»), набирающие title-бонус за имя автора
  // в названии. Подавляем title-сигнал — книга опускается ниже любой книги
  // самого автора. title-only запросы (authors пуст) штрафа не получают.
  if (authors.length && !authorMatched && titleScore > 15) titleScore = 15;
  let seriesScore = 0;
  // Серия: конкретный сигнал, слабее совпадения названия, сильнее авторских
  // токенов. Срабатывает только если LLM вытащил серию из запроса — иначе ветка
  // пропускается и на ранг нулевой эффект (старые тесты, серия не задана).
  if (series) {
    const sn = norm(series);
    const bn = norm(book.series ?? "");
    if (sn && bn) {
      if (bn === sn) seriesScore += 60;
      else if (bn.includes(sn) || sn.includes(bn)) seriesScore += 30;
    }
  }
  return titleScore + authorScore + seriesScore;
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
      onProgress?: (p: SearchProgress) => void,
    ): Promise<SearchResult> {
      const key = norm(rawQuery);
      const hit = cacheGet(key);
      if (hit) return hit; // кэш-хит — onProgress не зовётся, быстрый путь без статуса

      let parsed;
      let degraded = false;
      try {
        onProgress?.({ kind: "parsing" });
        parsed = await llm.parseQuery(rawQuery);
      } catch (e) {
        // Деградация: запрос целиком как title, без разбора. Сюда же падает
        // таймаут LLM — логируем, чтобы видеть частоту уходов в degraded.
        console.warn("llm parse failed, degraded:", (e as Error).message);
        parsed = { title: rawQuery };
        degraded = true;
      }

      // pt вычисляем до поиска: нужен как targetTitle для сигнала «нашёл» в
      // пагинации (пользователь видит, что нужная книга попалась на странице) и
      // для ранжирования. Если LLM не дал title (author-only поиск), pt пуст:
      // нельзя подставлять сырой запрос — он содержит имя автора, и чужие книги с
      // этим именем в названии (биографии, литературоведение) получат +600 и
      // обгонят книги самого автора.
      const pt = norm(parsed.title ?? "");
      // RC3: LLM занёс название в authors (путаница сущностей на запросе из
      // названия без автора: «Таис Афинская» → authors:["Таис Афинская"]). Авторский
      // поиск тогда идёт вхолостую + срабатывает штраф за «чужого автора» и топит
      // нужную книгу с #1 на #3. Если единственный «автор» совпадает с названием —
      // убираем: это название, не автор. Биография «Пушкин» (author!=title) и
      // несколько авторов не затрагиваются.
      let authors = parsed.authors ?? [];
      if (authors.length === 1 && pt && norm(authors[0]) === pt) authors = [];

      onProgress?.({ kind: "searching" });
      // split работает от 2 токенов и идёт параллельно как страховка; стримим
      // отдельный статус, чтобы title-only путь не молчал от «Ищу...» до «Сравниваю...».
      if (key.split(" ").filter(Boolean).length >= 2) onProgress?.({ kind: "splitting" });
      // UNION: LLM-разбор и детерминированный split-search — параллельно.
      // split покрывает кейсы, где LLM промахивается (author-only, грязные
      // реальные запросы) и служит страховкой при падении LLM. Каждый пул
      // оценивается своим разбором; в общий пул книга идёт с максимумом оценок
      // — «лучший сценарий» её нахождения. ~80% rel@3 против 69% у LLM-соло.
      // Адаптер пробрасывает прогресс пагинации flibusta в общий колбэк.
      const [llmRaw, splitRaw] = await Promise.all([
        flibusta
          .searchBooks(parsed, (fp) => onProgress?.(fp), { targetTitle: pt })
          .catch(() => [] as FlibustaBook[]),
        flibusta
          .splitSearchBooks(rawQuery)
          .catch(() => [] as Array<{ book: FlibustaBook; pt: string; authors: string[] }>),
      ]);

      // При равной релевантности — популярное издание (больше скачиваний) выше.
      const dl = (b: FlibustaBook): number =>
        parseInt(String(b.downloadsCount ?? "").replace(/\D/g, "")) || 0;
      const pool = new Map<string, { b: FlibustaBook; s: number }>();
      const merge = (b: FlibustaBook, s: number): void => {
        // Дедуп по id книги: одно и то же издание из LLM- и split-пула берём с
        // максимумом оценок. Fallback на title|author, если id не извлёкся.
        const k = b.id != null ? `id:${b.id}` : norm(b.title) + "|" + norm(b.author ?? "");
        const ex = pool.get(k);
        if (!ex || s > ex.s) pool.set(k, { b, s });
      };
      for (const b of llmRaw) merge(b, relevance(pt, authors, parsed.series, b));
      // split-книги ранжируем по LLM-авторам, когда LLM их дал: это единая правда
      // об авторе запроса. Разбиение split («александр») иначе матчит чужих
      // авторов по совпадению имени и пропускает книги о Пушкине авторов-Александров.
      // Без LLM-авторов (title-only, degraded) — по разбиению split, как раньше.
      for (const r of splitRaw) {
        const ra = authors.length ? authors : r.authors;
        merge(r.book, relevance(r.pt, ra, undefined, r.book));
      }

      if (!pool.size) {
        // Пустой результат кэшируем — легитимное «ничего нет», спасает от
        // повторных вызовов на опечатки и несуществующие книги.
        cachePut(key, { books: [], degraded });
        return { books: [], degraded };
      }

      onProgress?.({ kind: "ranking", count: pool.size });
      const scored = [...pool.values()].sort((a, z) => z.s - a.s || dl(z.b) - dl(a.b));
      const books = scored.slice(0, topN).map((x) => x.b);
      // Мягкий порог: лучшее совпадение слабое — помечаем выдачу, но книги не режем.
      // В degraded не применяется: там title = сырой запрос, score всегда низкий.
      const bestScore = scored[0]?.s ?? 0;
      const lowRelevance = !degraded && bestScore < MIN_RELEVANCE;
      const result: SearchResult = lowRelevance
        ? { books, degraded, lowRelevance: true }
        : { books, degraded };
      // Диагностика: слабая выдача (ни название, ни автор не попали) — видна в
      // docker logs, чтобы отслеживать класс «почти не нашлось» после фикса.
      if (lowRelevance) {
        console.warn(`lowRelevance query="${key}" bestScore=${bestScore} candidates=${scored.length}`);
      }
      // Деградированный результат НЕ кэшируем: LLM мог отключиться временно,
      // повторный запрос через минуту должен разобраться нормально.
      if (!degraded) cachePut(key, result);
      return result;
    },
  };
}
