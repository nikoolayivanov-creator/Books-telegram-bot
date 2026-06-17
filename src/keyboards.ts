import { InlineKeyboard } from "grammy";
import type { FlibustaBook } from "./search/flibusta.js";

// Тексты рендерятся как HTML (parse_mode: "HTML" в вызывающей стороне).
// Динамические значения экранируем — иначе <, >, & в названиях ломают разбор.

const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// «15349» → «15 349» — разделитель разрядов, удобнее сравнивать популярность.
const fmtNum = (s: string): string => s.replace(/\B(?=(\d{3})+(?!\d))/g, " ");

// Текст ранжированного списка с контрастом: жирный заголовок-якорь,
// жирное число скачиваний (метрика «какая лучше»), курсив — переводчик/серия.
export function bookListText(books: FlibustaBook[], query?: string): string {
  const header = query ? `Найдено по запросу «${esc(query)}»:` : "Что нашёл:";
  const items = books.map((b, i) => listItem(i + 1, b));
  return [header, "", items.join("\n\n"), "", "<i>Нажми номер, чтобы открыть книгу и скачать.</i>"].join("\n");
}

function listItem(n: number, b: FlibustaBook): string {
  const lines = [`<b>${n}. ${esc(b.title)}</b>${b.author ? ` — ${esc(b.author)}` : ""}`];
  const facts: string[] = [];
  if (b.formats.length) facts.push(b.formats.map((f) => f.toUpperCase()).join(", "));
  if (b.size) facts.push(esc(b.size));
  if (b.downloadsCount) facts.push(`<b>${fmtNum(esc(b.downloadsCount))}</b> скач.`);
  if (facts.length) lines.push(facts.join(" · "));
  const extra: string[] = [];
  if (b.translator) extra.push("пер. " + esc(b.translator.slice(0, 40)));
  if (b.series) extra.push(esc(b.series));
  if (extra.length) lines.push("<i>" + extra.join(" · ") + "</i>");
  return lines.join("\n");
}

// Карточка книги: жирное название, структурированные метаданные, описание.
export function bookCardText(b: FlibustaBook): string {
  const lines = [`<b>${esc(b.title)}</b>`];
  if (b.author) lines.push(`Автор: ${esc(b.author)}`);
  if (b.category) lines.push(`Жанр: ${esc(b.category)}`);
  const meta: string[] = [];
  if (b.translator) meta.push(`Перевод: ${esc(b.translator)}`);
  if (b.series) meta.push(`Серия: ${esc(b.series)}`);
  if (b.language) meta.push(`Язык: ${esc(b.language)}`);
  if (b.size) meta.push(`Размер: ${esc(b.size)}`);
  if (b.downloadsCount) meta.push(`Скачиваний: <b>${fmtNum(esc(b.downloadsCount))}</b>`);
  if (meta.length) { lines.push(""); lines.push(meta.join("\n")); }
  if (b.description) { lines.push(""); lines.push(esc(b.description.slice(0, 900))); }
  lines.push("");
  lines.push(b.formats.length ? "Выбери формат для скачивания:" : "Форматы не определены.");
  return lines.join("\n");
}

// Кнопки-номера: однозначно сопоставлены со списком выше.
export function bookListKeyboard(books: FlibustaBook[]): InlineKeyboard {
  const kb = new InlineKeyboard();
  books.forEach((_b, i) => kb.text(String(i + 1), `book:${i}`));
  return kb;
}

// Форматы книги + возврат к списку.
export function formatsKeyboard(book: FlibustaBook, index: number): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const fmt of book.formats) kb.text(fmt.toUpperCase(), `fmt:${index}:${fmt}`);
  kb.row();
  kb.text("← Назад к списку", "list");
  return kb;
}
