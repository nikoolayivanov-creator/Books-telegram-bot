import * as FlibustaNS from "flibusta";
import type { ParsedQuery } from "./llm.js";

// Пакет flibusta собран webpack как CommonJS/UMD. При ESM-импорте его default
// оборачивается в namespace-объект, и конструктор лежит в .default.default.
// Под моком vitest (vi.mock → { default: mock }) — в .default. Берём оба варианта.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const FlibustaAPI: any = (FlibustaNS as any).default?.default ?? (FlibustaNS as any).default;

export type FlibustaBook = {
  id?: number;
  title: string;
  author?: string;
  category?: string;
  description?: string;
  coverUrl?: string;
  downloads: { link: string; format: string }[];
  formats: string[];
  // Извлекаются из хвоста описания («Перевод: … Размер: … Скачиваний: …»).
  size?: string;
  downloadsCount?: string;
  series?: string;
  translator?: string;
  language?: string;
};

type Deps = { base: string; fallbackBase?: string; httpAgent?: unknown };

const FORMAT_RE = /\/b\/\d+\/([a-z0-9]+)/i;
// /b/ID/... — числовой идентификатор книги в flibusta. Нужен для дедупа по id
// (а не по title: разные издания одной книги или одноимённые книги разных
// авторов не должны схлопываться) и для cross-check между LLM- и split-пулом.
const BOOK_ID_RE = /\/b\/(\d+)/i;

// Метки хвоста описания у flibusta. Капителлизированы и фиксированы —
// поэтому матчим регистрочувствительно, чтобы не цеплять слова из аннотации.
const META_LABELS = ["Перевод", "Формат", "Язык", "Размер", "Скачиваний", "Серия", "Год издания"];
type BookMeta = Pick<FlibustaBook, "size" | "downloadsCount" | "series" | "translator" | "language">;

// Описание = аннотация + блок «Метка: значение Метка: значение …».
// Разрезаем по первой метке: слева — аннотация для показа, справа — метаданные.
function parseDescription(desc: string | undefined): { annotation?: string; meta: BookMeta } {
  if (!desc) return { meta: {} };
  const text = desc.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  const start = text.search(new RegExp(`(?:${META_LABELS.join("|")}):`));
  const metaText = start >= 0 ? text.slice(start) : "";
  const annotation = start >= 0 ? text.slice(0, start).trim() : text;
  const labelAlt = META_LABELS.join("|");
  const take = (label: string): string | undefined => {
    const m = metaText.match(new RegExp(`${label}:\\s*(.+?)(?=\\s+(?:${labelAlt}):|$)`));
    return m ? m[1].trim() : undefined;
  };
  return {
    annotation: annotation || undefined,
    meta: {
      size: take("Размер"),
      downloadsCount: take("Скачиваний"),
      series: take("Серия"),
      translator: take("Перевод"),
      language: take("Язык"),
    },
  };
}

function normalize(raw: any, base: string): FlibustaBook {
  const downloads: { link: string; format: string }[] = (raw.downloads ?? [])
    .filter((d: any) => d?.link)
    .map((d: any) => {
      const m = String(d.link).match(FORMAT_RE);
      // /b/ID/download — дефолтный формат flibusta (fb2 в zip). Нормализуем к fb2.
      const fmt = m ? m[1] : "";
      return { link: String(d.link), format: fmt === "download" ? "fb2" : fmt };
    });
  const formats = Array.from(new Set(downloads.map((d) => d.format)))
    .filter((f) => f && f !== "unknown");
  const { annotation, meta } = parseDescription(raw.description);
  // id книги — из первой download-ссылки вида /b/<id>/...
  const idLink = downloads[0]?.link;
  const idMatch = idLink ? String(idLink).match(BOOK_ID_RE) : null;
  return {
    id: idMatch ? Number(idMatch[1]) : undefined,
    title: raw.title ?? "Без названия",
    author: raw.author?.[0]?.name,
    category: raw.categories?.[0],
    description: annotation,
    coverUrl: raw.cover ? base + raw.cover : undefined,
    downloads,
    formats,
    ...meta,
  };
}

// Локальная нормализация имени для сравнения: lowercase, убрать пунктуацию,
// сжать пробелы. Аналог norm из orchestrator.ts, но здесь своего norm нет,
// тянуть общую утиль ради одной функции избыточно.
function normName(s: string): string {
  return s.toLowerCase().replace(/ё/g, "е").replace(/[«»"'!.,?;:()\[\]]/g, " ").replace(/\s+/g, " ").trim();
}

// Таймаут на одиночный вызов к Flibusta. Пакет под капотом гоняет axios без
// per-request timeout: под rate-limit одиночный запрос висит на TCP-уровне
// минутами, и пользователь видит вечное «Ищу...». Promise.race обрывает ожидание
// вызывающего (сам axios-запрос догниёт в фоне и соберётся GC). 12с — потолок
// на одну страницу/поиск: нормальная страница ~1с, всё что дольше — stall.
const CALL_TIMEOUT_MS = 12_000;
function withTimeout<T>(p: Promise<T>, ms: number = CALL_TIMEOUT_MS): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const bomb = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`flibusta call timeout after ${ms}ms`)), ms);
  });
  return Promise.race([p, bomb]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

// Выбор автора из списка совпадений Flibusta. getAuthors возвращает несколько
// (одфамильцы, разные переводы имени). Алгоритм: точное совпадение → вхождение
// → пересечение токенов. При РАВЕНСТВЕ совпадения (одфамильцы с одинаковой
// длиной фамилии: «достоевский» → Андрей/Дмитрий/Михаил/Фёдор) — побеждает
// самый плодовитый автор (поле books из getAuthors). Раньше брали первого
// попавшегося — это ловило случайного однофамильца вместо известного автора.
export function chooseAuthorId(
  requested: string,
  authors: { id: number; name: string; books?: number }[],
): number | undefined {
  if (!authors.length) return undefined;
  const req = normName(requested);
  // Нет запроса или ничего не совпало — самый плодовитый, не «первый в выдаче».
  const byPopularity = () =>
    [...authors].sort((a, b) => (b.books ?? 0) - (a.books ?? 0))[0].id;
  if (!req) return byPopularity();

  const exact = authors.find((a) => normName(a.name) === req);
  if (exact) return exact.id;

  let bestInc: { id: number; len: number; books: number } | null = null;
  for (const a of authors) {
    const n = normName(a.name);
    if (n && (n.includes(req) || req.includes(n))) {
      const len = Math.min(n.length, req.length);
      const bk = a.books ?? 0;
      if (!bestInc || len > bestInc.len || (len === bestInc.len && bk > bestInc.books)) {
        bestInc = { id: a.id, len, books: bk };
      }
    }
  }
  if (bestInc) return bestInc.id;

  const reqTokens = req.split(" ").filter(Boolean);
  let bestTok: { id: number; score: number; books: number } | null = null;
  for (const a of authors) {
    const n = normName(a.name);
    if (!n) continue;
    const nameTokens = n.split(" ").filter(Boolean);
    const hit = reqTokens.filter((t) => nameTokens.includes(t)).length;
    const bk = a.books ?? 0;
    if (hit > 0 && (!bestTok || hit > bestTok.score || (hit === bestTok.score && bk > bestTok.books))) {
      bestTok = { id: a.id, score: hit, books: bk };
    }
  }
  if (bestTok) return bestTok.id;

  return byPopularity();
}

// Полная библиография автора постранично. getBooksByAuthorOpds отдаёт только
// 1-ю страницу OPDS (20 книг); у плодовитых авторов (Ефремов 189, Стругацкие)
// основные романы лежат на страницах 2-10 и были недоступны — поиск по автору
// молча терял большинство книг. Перебираем страницы, пока есть next-link.
//
// Бюджет ограничивает нагрузку и латентность: потолок страниц и потолок времени
// на одного автора. 15 страниц × 20 = до 300 записей — покрывает Ефремова (10
// стр.) с запасом. Таймаут 8с: OPDS-страница ~1с, 8с ≈ 8 страниц — хватает до
// page 6-7, где у плодовитых авторов лежат основные романы (у Ефремова «Таис
// Афинская» на page 6). Меньше — теряем книги; больше — пользователь ждёт.
// Повторные запросы берутся из кэша orchestrator (6ч).
// Прогресс поиска для стриминга в чат. author-found — выбрали автора из списка
// тезок, знаем объём его библиографии; paging — перебор страниц с накопленным
// числом книг и сигналом «нашёл», если цель попалась на текущей странице.
export type FlibustaProgress =
  | { kind: "author-found"; author: string; books: number }
  | { kind: "paging"; page: number; totalPages: number; booksSoFar: number; found?: string }
  | { kind: "title-search" };

async function searchBooksByAuthor(
  client: any,
  id: number,
  base: string,
  budget: { maxPages: number; maxTimeMs: number },
  opts?: { booksCount?: number; targetTitle?: string; onProgress?: (p: FlibustaProgress) => void },
): Promise<FlibustaBook[]> {
  const out: FlibustaBook[] = [];
  const start = Date.now();
  let page = 0;
  // Цель для сигнала «нашёл»: нормализованное название из запроса. На каждой
  // странице проверяем, не появилась ли книга с этим названием — попадание
  // сообщаем один раз, чтобы пользователь видел, что нужная книга в сборе.
  const target = opts?.targetTitle ? normName(opts.targetTitle) : "";
  let foundReported = false;
  let booksSoFar = 0;
  let pageSize = 20; // дефолт; уточняем по первой странице
  let totalPages = opts?.booksCount ? Math.ceil(opts.booksCount / pageSize) : 0;
  while (page < budget.maxPages) {
    if (Date.now() - start > budget.maxTimeMs) break;
    let res: { items?: any[]; hasNextPage?: boolean };
    try {
      res = await client.getBooksByAuthorOpdsPaginated(id, page, 50);
    } catch {
      break; // страница упала — берём что есть, не роняем весь поиск
    }
    if (!res) break;
    const items = Array.isArray(res.items) ? res.items : [];
    if (page === 0 && items.length) {
      pageSize = items.length;
      if (opts?.booksCount) totalPages = Math.ceil(opts.booksCount / pageSize);
    }
    booksSoFar += items.length;
    let found: string | undefined;
    if (target && !foundReported) {
      const hit = items.find((r: any) => normName(r.title ?? "").includes(target));
      if (hit) { found = hit.title; foundReported = true; }
    }
    opts?.onProgress?.({ kind: "paging", page: page + 1, totalPages, booksSoFar, found });
    for (const r of items) out.push(normalize(r, base));
    if (!res.hasNextPage) break;
    page++;
  }
  // Диагностика RC1: если перешли за 1-ю страницу — пагинация отработала.
  // Логируем для видимости в docker logs (плодовитый автор: раньше эти книги
  // молча терялись на первой странице). Кэш orchestrator (6ч) гасит повторы.
  if (page > 0) console.warn(`pagination author id=${id}: ${out.length} books across ${page + 1} pages`);
  return out;
}

export function createFlibusta(deps: Deps) {
  // Клиент с таймаутом на каждом сетевом вызове. axios внутри пакета не прерывает
  // stall сам, поэтому оборачиваем 4 метода в withTimeout: вызов отваливается
  // через CALL_TIMEOUT_MS, ловится catch в searchBooks/split и идёт дальше.
  const makeClient = (base: string): any => {
    const c: any = new FlibustaAPI(base, deps.httpAgent ? { httpAgent: deps.httpAgent } : undefined);
    const timed = (name: string) => {
      const fn = c?.[name];
      if (typeof fn !== "function") return undefined;
      return (...args: unknown[]) => withTimeout(fn.apply(c, args));
    };
    return {
      getAuthors: timed("getAuthors"),
      getBooksByAuthorOpdsPaginated: timed("getBooksByAuthorOpdsPaginated"),
      getBooksByNameFromOpds: timed("getBooksByNameFromOpds"),
      getBooksByAuthorOpds: timed("getBooksByAuthorOpds"),
    };
  };

  return {
    async searchBooks(
      q: ParsedQuery,
      onProgress?: (p: FlibustaProgress) => void,
      opts?: { targetTitle?: string },
    ): Promise<FlibustaBook[]> {
      const client = makeClient(deps.base);
      const out: FlibustaBook[] = [];

      // По автору: сначала найти id, потом тянуть полную библиографию
      // (пагинация OPDS, иначе у плодовитых авторов доступна только 1-я страница)
      if (q.authors?.length) {
        for (const a of q.authors) {
          try {
            const authors = await (client as any).getAuthors(a);
            const list = authors ?? [];
            const id = chooseAuthorId(a, list);
            if (id) {
              const authorObj = list.find((x: any) => x.id === id);
              const booksCount = authorObj?.books;
              if (booksCount != null) {
                onProgress?.({ kind: "author-found", author: authorObj?.name ?? a, books: booksCount });
              }
              const found = await searchBooksByAuthor(client as any, id, deps.base, {
                maxPages: 15,
                maxTimeMs: 8000,
              }, { booksCount, targetTitle: opts?.targetTitle, onProgress });
              out.push(...found);
            }
          } catch { /* автор не найден — пропускаем */ }
        }
      }

      // По названию
      if (q.title) {
        // Стримим отдельный статус: title-only поиск иначе молчит от «Ищу...»
        // до «Сравниваю...», пока ждёт одиночный getBooksByNameFromOpds.
        onProgress?.({ kind: "title-search" });
        try {
          const list = await (client as any).getBooksByNameFromOpds(q.title);
          if (Array.isArray(list)) out.push(...list.map((r) => normalize(r, deps.base)));
        } catch { /* зеркало упало — fallback ниже */ }
      }

      // Дедуп по id книги: разные издания (один /b/id) — схлопываем, но
      // одноимённые книги разных авторов и разные тома сохраняем. Fallback на
      // title+author, если id не извлёкся (запись без download-ссылки).
      const seen = new Set<string>();
      const dedupKey = (b: FlibustaBook): string =>
        b.id != null ? `id:${b.id}` : `${normName(b.title)}|${normName(b.author ?? "")}`;
      const deduped = out.filter((b) => {
        const k = dedupKey(b);
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });

      if (deduped.length) return deduped;

      // Fallback на запасное зеркало если основной пуст
      if (deps.fallbackBase) {
        return this.searchBooksOn(q, deps.fallbackBase);
      }
      return [];
    },

    async searchBooksOn(q: ParsedQuery, base: string): Promise<FlibustaBook[]> {
      const client = makeClient(base);
      const out: FlibustaBook[] = [];
      if (q.title) {
        const list = await (client as any).getBooksByNameFromOpds(q.title);
        if (Array.isArray(list)) out.push(...list.map((r) => normalize(r, base)));
      }
      return out;
    },

    // Детерминированный разбор перебором разбиений (без LLM). Запрос дробится
    // на (автор-префикс, название-остаток) и наоборот; для каждого разбиения —
    // поиск по автору + по названию. Для каждой книги запоминаем её лучшее
    // разбиение (с самым длинным автором = конкретнее). Возвращает пул с
    // (pt, authors) для max-relevance merge в orchestrator. Покрывает кейсы,
    // где LLM промахивается (author-only, грязные реальные запросы) и служит
    // страховкой при падении LLM. lim=4 ограничивает перебор → нагрузку на Flibusta.
    async splitSearchBooks(
      query: string,
    ): Promise<Array<{ book: FlibustaBook; pt: string; authors: string[] }>> {
      const tokens = normName(query).split(" ").filter(Boolean);
      if (tokens.length < 2) return []; // split имеет смысл от 2 токенов
      const lim = Math.min(tokens.length, 4);
      type Split = { authors: string; title: string };
      const seen = new Set<string>();
      const splits: Split[] = [];
      for (let k = 1; k < tokens.length; k++) {
        if (k > lim && tokens.length - k > lim) continue;
        const cands: Split[] = [
          { authors: tokens.slice(0, k).join(" "), title: tokens.slice(k).join(" ") },
          { authors: tokens.slice(k).join(" "), title: tokens.slice(0, k).join(" ") },
        ];
        for (const s of cands) {
          const kk = s.authors + "|" + s.title;
          if (!s.authors || !s.title || seen.has(kk)) continue;
          seen.add(kk);
          splits.push(s);
        }
      }
      const client = makeClient(deps.base);
      const results = await Promise.all(
        splits.map(async (sp) => {
          try {
            const books: FlibustaBook[] = [];
            const list = await (client as any).getAuthors(sp.authors);
            const id = chooseAuthorId(
              sp.authors,
              (list ?? []).map((x: any) => ({ id: x.id, name: x.name, books: x.books })),
            );
            if (id) {
              const bl = await (client as any).getBooksByAuthorOpds(id);
              if (Array.isArray(bl)) books.push(...bl.map((r: any) => normalize(r, deps.base)));
            }
            const tl = await (client as any).getBooksByNameFromOpds(sp.title);
            if (Array.isArray(tl)) books.push(...tl.map((r: any) => normalize(r, deps.base)));
            return { sp, books };
          } catch {
            return { sp, books: [] as FlibustaBook[] };
          }
        }),
      );
      // Для каждой книги — best разбиение (длиннее автор = конкретнее).
      // Фильтр: книга валидна для разбиения, только если author-часть матчит
      // автора книги (≥1 токен). Иначе разбиение для неё бессмысленно: напр.
      // биография «Конан Дойл / Чертанов» при разбиении «шерлок холмс»+«конан
      // дойл» — title совпадёт точно, но автор не тот, книга нерелевантна.
      const best = new Map<string, { book: FlibustaBook; pt: string; authors: string[]; authorLen: number }>();
      for (const { sp, books } of results) {
        const pt = normName(sp.title);
        const authorLen = normName(sp.authors).length;
        const authorTokens = normName(sp.authors).split(" ").filter(Boolean);
        const titleTokens = pt.split(" ").filter(Boolean);
        for (const book of books) {
          const ba = normName(book.author ?? "").split(" ").filter(Boolean);
          // author-часть разбиения должна матчить автора книги.
          if (authorTokens.length && !authorTokens.some((t) => ba.includes(t))) continue;
          // Title-часть должна объясняться — входить в название или в автора.
          // Иначе книга попала только по author-части (тезка по имени/фамилии),
          // а остальной запрос к ней отношения не имеет: «юрий»→Никитин при
          // запросе «юрий лотман» — «лотман» ни в названии, ни в авторе Никитина.
          if (titleTokens.length) {
            const tn = normName(book.title);
            if (!titleTokens.every((t) => tn.includes(t) || ba.includes(t))) continue;
          }
          const k = normName(book.title) + "|" + normName(book.author ?? "");
          const ex = best.get(k);
          if (!ex || authorLen > ex.authorLen) best.set(k, { book, pt, authors: [sp.authors], authorLen });
        }
      }
      return [...best.values()].map(({ book, pt, authors }) => ({ book, pt, authors }));
    },

    downloadUrl(book: FlibustaBook, format: string): string {
      const d = book.downloads.find((x) => x.format === format);
      const link = d?.link ?? book.downloads[0]?.link;
      if (!link) throw new Error(`нет ссылки скачивания для ${book.title}`);
      return link.startsWith("http") ? link : deps.base + link;
    },
  };
}

export type Flibusta = ReturnType<typeof createFlibusta>;