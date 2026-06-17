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
            const id = authors?.[0]?.id;
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

    downloadUrl(book: FlibustaBook, format: string): string {
      const d = book.downloads.find((x) => x.format === format);
      const link = d?.link ?? book.downloads[0]?.link;
      if (!link) throw new Error(`нет ссылки скачивания для ${book.title}`);
      return link.startsWith("http") ? link : deps.base + link;
    },
  };
}

export type Flibusta = ReturnType<typeof createFlibusta>;