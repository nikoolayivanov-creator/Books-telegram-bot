import * as FlibustaNS from "flibusta";
import type { ParsedQuery } from "./llm.js";

// Пакет flibusta собран webpack как CommonJS/UMD. При ESM-импорте его default
// оборачивается в namespace-объект, и конструктор лежит в .default.default.
// Под моком vitest (vi.mock → { default: mock }) — в .default. Берём оба варианта.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const FlibustaAPI: any = (FlibustaNS as any).default?.default ?? (FlibustaNS as any).default;

export type FlibustaBook = {
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
  return {
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
  return s.toLowerCase().replace(/[«»"'!.,?;:()\[\]]/g, " ").replace(/\s+/g, " ").trim();
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

export function createFlibusta(deps: Deps) {
  const makeClient = (base: string) =>
    new FlibustaAPI(base, deps.httpAgent ? { httpAgent: deps.httpAgent } : undefined);

  return {
    async searchBooks(q: ParsedQuery): Promise<FlibustaBook[]> {
      const client = makeClient(deps.base);
      const out: FlibustaBook[] = [];

      // По автору: сначала найти id, потом книги автора
      if (q.authors?.length) {
        for (const a of q.authors) {
          try {
            const authors = await (client as any).getAuthors(a);
            const id = chooseAuthorId(a, authors ?? []);
            if (id) {
              const list = await (client as any).getBooksByAuthorOpds(id);
              if (Array.isArray(list)) out.push(...list.map((r) => normalize(r, deps.base)));
            }
          } catch { /* автор не найден — пропускаем */ }
        }
      }

      // По названию
      if (q.title) {
        try {
          const list = await (client as any).getBooksByNameFromOpds(q.title);
          if (Array.isArray(list)) out.push(...list.map((r) => normalize(r, deps.base)));
        } catch { /* зеркало упало — fallback ниже */ }
      }

      // Дедуп по title
      const seen = new Set<string>();
      const deduped = out.filter((b) => {
        if (seen.has(b.title)) return false;
        seen.add(b.title);
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
        for (const book of books) {
          if (authorTokens.length) {
            const ba = normName(book.author ?? "").split(" ").filter(Boolean);
            if (!authorTokens.some((t) => ba.includes(t))) continue;
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