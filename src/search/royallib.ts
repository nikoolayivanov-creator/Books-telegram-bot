import type { ParsedQuery } from "./llm.js";
import type { FlibustaBook } from "./flibusta.js";

type Deps = { base: string };

// Таймаут на один сетевой вызов к royallib. Сайт без API — поиск = POST /search/
// + до MAX_CARDS GET карточек параллельно. Одиночная страница ~30-50 КБ, норма
// ~1с; 6с — потолок, дольше — stall (как flibusta: обрываем ожидание вызывающего).
const CALL_TIMEOUT_MS = 6_000;

// Сколько карточек книг тянем для извлечения форматов/аннотации. Royallib —
// вторичный источник (flibusta приоритетна), поэтому обходимся скромным пулом:
// больше карточек = больше параллельных GET без пропорционального роста пользы.
const MAX_CARDS = 8;

const UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

// royallib отдаёт ссылки protocol-relative («//royallib.com/...») — приводим к https.
function abs(u: string): string {
  if (u.startsWith("//")) return "https:" + u;
  if (u.startsWith("http")) return u;
  return u;
}

// Минимальная развёртка HTML-сущностей: названия/аннотации могут содержать
// &nbsp;, &mdash; и т.п. Полный парсер не нужен — покрываем частые случаи.
function decodeHtml(s: string): string {
  return s
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&mdash;/g, "—")
    .replace(/&ndash;/g, "–")
    .replace(/&laquo;/g, "«")
    .replace(/&raquo;/g, "»")
    .replace(/&#\d+;/g, "")
    .replace(/&[a-z]+;/gi, "");
}

function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

async function fetchText(url: string, init?: RequestInit): Promise<string> {
  const res = await fetch(url, {
    ...init,
    headers: {
      "user-agent": UA,
      accept: "text/html,application/xhtml+xml",
      ...(init?.headers ?? {}),
    },
    signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`royallib ${res.status} for ${url}`);
  return res.text();
}

type SearchHit = { href: string; title: string; author: string };

// Разбираем секцию «Книги» страницы результатов поиска. Каждая строка книги:
//   <tr><td><a href="//royallib.com/book/<author>/<title>.html">Название</a></td>
//       <td>&nbsp;</td><td><a href="//royallib.com/author/<author>.html">
//       <font size="-2">Автор</font></a></td></tr>
// Секции «Авторы» и «Серии» отсекаем: ищем только после заголовка «>Книги</h2>».
// Пару (книга → автор) берём из одной строки: нежадный [\s\S]*? от book-ссылки
// до первой author-ссылки (она в той же строке).
function parseSearchResults(html: string): SearchHit[] {
  const idx = html.indexOf(">Книги</h2>");
  if (idx < 0) return [];
  const section = html.slice(idx);
  const out: SearchHit[] = [];
  const rowRe =
    /<a href="([^"]*\/book\/[^"]+\.html)"[^>]*>([^<]+)<\/a>[\s\S]*?<a href="[^"]*\/author\/[^"]+\.html"[^>]*>(?:<font[^>]*>)?([^<]*?)(?:<\/font>)?<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = rowRe.exec(section))) {
    const title = decodeHtml(m[2]).trim();
    const author = decodeHtml(m[3]).trim();
    if (title) out.push({ href: abs(m[1]), title, author: author || "" });
  }
  return out;
}

type Card = {
  coverUrl?: string;
  category?: string;
  description?: string;
  downloads: { link: string; format: string; size?: string }[];
  formats: string[];
};

// Карточка книги /book/<author>/<title>.html: обложка, жанр, аннотация, форматы.
// Форматы — единственное, что критично для скачивания; обложка/жанр/аннотация
// обогащают выдачу. Ссылки скачивания: /get/<fmt>/<author>/<title>.zip.
function parseCard(html: string): Card {
  const cover = html.match(/src="([^"]*\/data\/images\/[^"]*)"/i);
  const coverUrl = cover ? abs(cover[1]) : undefined;

  const genre = html.match(/<b>Жанр:<\/b>[\s\S]*?<a[^>]*>([^<]+)<\/a>/i);
  const category = genre ? decodeHtml(genre[1]).trim() : undefined;

  const ann = html.match(/<b>Аннотация:<\/b>([\s\S]*?)<\/td>/i);
  const description = ann ? stripTags(decodeHtml(ann[1])).slice(0, 2000) : undefined;

  const downloads: Card["downloads"] = [];
  const dlRe =
    /<a href="([^"]*\/get\/([a-z0-9]+)\/[^"]*\.zip)"[^>]*>Скачать[^<]*<\/a>(?:\s*\(Размер:\s*([^)]*)\))?/gi;
  let m: RegExpExecArray | null;
  while ((m = dlRe.exec(html))) {
    downloads.push({
      link: abs(m[1]),
      format: m[2].toLowerCase(),
      size: m[3] ? m[3].trim() : undefined,
    });
  }
  const formats = Array.from(new Set(downloads.map((d) => d.format)));
  return { coverUrl, category, description, downloads, formats };
}

function toBook(h: SearchHit, card: Card | null): FlibustaBook {
  // Размер показываем по fb2 (основной формат) либо по первому доступному —
  // в списке «103 Кб» полезнее всего при первом формате.
  const size =
    card?.downloads.find((d) => d.format === "fb2")?.size ?? card?.downloads[0]?.size;
  return {
    title: h.title,
    author: h.author || undefined,
    category: card?.category,
    description: card?.description,
    coverUrl: card?.coverUrl,
    downloads: card?.downloads ?? [],
    formats: card?.formats ?? [],
    size,
    provider: "royallib",
  };
}

export function createRoyallib(deps: Deps) {
  return {
    // Поиск: один POST /search/ + параллельный доразбор карточек. Без LLM и без
    // пагинации — royallib вторичен, flibusta остаётся основным источником.
    async searchBooks(q: ParsedQuery): Promise<FlibustaBook[]> {
      // «Название + автор», а не только название: royallib ищет по OR, и title-only
      // находит тезку-название вместо нужной книги (живой кейс: «фрегат паллада» →
      // рецензия Добролюбова «Фрегат 'Паллада'», а не гончаровский «Фрегат „Паллада"»).
      // Автор дисциплинирует поиск — подтягивает и биографии/статьи об авторе (шум),
      // но этот шум отсекается в orchestrator штрафом за чужого автора. Без названия
      // (author-only) — по автору.
      const query = (q.title ? [q.title, ...(q.authors ?? [])] : q.authors ?? []).join(" ").trim();
      if (!query) return [];
      const html = await fetchText(`${deps.base}/search/`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ to: "result", q: query }).toString(),
      });
      const hits = parseSearchResults(html).slice(0, MAX_CARDS);
      const books = await Promise.all(
        hits.map(async (h) => {
          try {
            const card = parseCard(await fetchText(h.href));
            return toBook(h, card);
          } catch {
            // Карточка упала — книга всё равно полезна (название + автор), но без
            // форматов скачать нельзя. Оставляем без форматов.
            return toBook(h, null);
          }
        }),
      );
      return books;
    },

    // Ссылка скачивания уже абсолютная (заполнена при разборе карточки) — просто
    // берём нужный формат из downloads.
    downloadUrl(book: FlibustaBook, format: string): string {
      const d = book.downloads.find((x) => x.format === format) ?? book.downloads[0];
      if (!d) throw new Error(`нет ссылки скачивания для ${book.title}`);
      return d.link;
    },
  };
}

export type Royallib = ReturnType<typeof createRoyallib>;
