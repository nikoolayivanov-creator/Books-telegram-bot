import { Bot, InputFile } from "grammy";
import type { Config } from "./config.js";
import type { Analytics } from "./analytics.js";
import { createAnalytics } from "./analytics.js";
import fs from "node:fs/promises";
import type { Db } from "./db.js";
import { createOrchestrator } from "./search/orchestrator.js";
import { createLlm } from "./search/llm.js";
import { createFlibusta, type Flibusta, type FlibustaBook } from "./search/flibusta.js";
import { createDownloader } from "./download.js";
import { bookListKeyboard, formatsKeyboard, bookListText, bookCardText } from "./keyboards.js";
import { createStatusMessenger, type StatusMessenger, type MsgRef } from "./status.js";

export type HandlerCtx = {
  from?: { id: number };
  message?: { text?: string };
  callbackQuery?: { data?: string };
  reply(text: string, extra?: unknown): Promise<unknown>;
  replyWithPhoto(photo: InputFile | string, extra?: { caption?: string }): Promise<unknown>;
  replyWithDocument(document: InputFile): Promise<unknown>;
  replyWithChatAction?(action: string): Promise<unknown>;
  answerCallbackQuery(): Promise<unknown>;
  editMessageText(text: string, extra?: unknown): Promise<unknown>;
};

// Семафор: ограничивает число параллельных дорогих операций. При неблокирующих
// обработчиках без него спам-очередь выливается в десяток одновременных вызовов
// flibusta/LLM — риск троттлинга и бана upstream.
function makeSemaphore(max: number) {
  let active = 0;
  const queue: (() => void)[] = [];
  return {
    async acquire(): Promise<void> {
      if (active < max) { active++; return; }
      await new Promise<void>((resolve) => queue.push(resolve));
    },
    release(): void {
      const next = queue.shift();
      if (next) next(); // слот переходит ждущему, active не меняется
      else active--;
    },
  };
}

export function createBotHandlers(
  cfg: Config,
  orchestrator: ReturnType<typeof createOrchestrator>,
  analytics: Analytics,
  downloader: ReturnType<typeof createDownloader>,
  flibusta: Flibusta,
  messenger?: StatusMessenger,
) {
  // Статус-сообщения (прогресс скачивания, фазы поиска). Опционально: тестам,
  // которым статус не нужен, передавать фейк не требуется — no-op по умолчанию.
  const msg: StatusMessenger = messenger ?? {
    async send() { return { chatId: 0, msgId: 0 }; },
    async edit() {},
    async delete() {},
  };
  // Кеш последних результатов поиска по user_id (в памяти, TTL через неактивность — для MVP достаточно)
  const lastResults = new Map<number, FlibustaBook[]>();
  // Последний запрос пользователя — чтобы перерисовать список из карточки.
  const lastQuery = new Map<number, string>();
  // Текущая страница списка (пагинация по 5, до 3 стр) — «Назад к списку»
  // возвращает пользователя на ту страницу, где он был, а не на первую.
  const lastPage = new Map<number, number>();
  // Rate limit в памяти. Отклонение от спеки (там был SQLite): для скользящего окна 60с
  // персистентность избыточна. При росте >100 юзеров перенести в db.countEventsSince.
  const hits = new Map<number, number[]>();
  // Повторные клики «скачать», пока файл ещё качается: ключ `${userId}:${url}`.
  const inflight = new Set<string>();
  // Кулдаун после успешного скачивания того же файла тем же юзером. grammY ждёт
  // каждый обработчик, поэтому клики из разных батчей приходят уже после загрузки
  // и без кулдауна каждый плодил бы дубль файла.
  const lastDownload = new Map<string, number>();
  const DOWNLOAD_COOLDOWN_MS = 10_000;
  // Ограничители параллельности дорогих операций (защита upstream). 5 — потолок
  // одновременных LLM-вызовов и параллельных скачиваний flibusta.
  const searchSem = makeSemaphore(5);
  const downloadSem = makeSemaphore(5);
  // Реестр фоновых задач: обработчик запускает поиск/скачивание в фоне и сразу
  // возвращается, grammY эту работу не ждёт. idle() позволяет тестам дождаться
  // завершения (и при желании — аккуратно закрыться при остановке).
  const pending = new Set<Promise<unknown>>();
  function track<T>(p: Promise<T>): Promise<T> {
    pending.add(p);
    p.then(() => pending.delete(p), () => pending.delete(p));
    return p;
  }
  async function idle(): Promise<void> {
    while (pending.size) await Promise.allSettled([...pending]);
  }

  // Allowlist выключен — бот публичный. «Безлимитные» юзеры обходят дневные
  // лимиты (поиск/скачивание): это UNLIMITED_IDS плюс админы.
  function unlimited(id: number): boolean {
    return cfg.unlimitedIds.includes(id) || cfg.adminIds.includes(id);
  }
  const dayAgo = () => Math.floor(Date.now() / 1000) - 86400;

  function rateLimited(id: number): boolean {
    const now = Date.now();
    const arr = (hits.get(id) ?? []).filter((t) => now - t < 60_000);
    arr.push(now);
    hits.set(id, arr);
    return arr.length > cfg.rateLimitPerMin;
  }

  async function onText(ctx: HandlerCtx) {
    const id = ctx.from?.id;
    if (!id) return;
    if (rateLimited(id)) { await ctx.reply("Слишком много запросов, подожди минуту."); return; }

    const text = ctx.message?.text?.trim();
    if (!text) return;
    // Защита от вставки длинного текста: иначе весь кусок улетает в LLM
    // (дорогой вызов, возможен таймаут). Реальные запросы к книгам короткие.
    if (text.length > cfg.maxQueryLen) {
      await ctx.reply(`Слишком длинный запрос — ${text.length} символов. Пришли название или автора, до ${cfg.maxQueryLen} символов.`);
      return;
    }
    // Дневной лимит поисков — защита квоты LLM и от абьюза на публичном боте.
    // Считаем сырые поиски за скользящие 24ч. Безлимитные юзеры проходят.
    if (!unlimited(id) && analytics.countSince(id, "search", dayAgo()) >= cfg.searchDailyLimit) {
      await ctx.reply(`Лимит поисков исчерпан: ${cfg.searchDailyLimit} за 24 часа. Попробуй через несколько часов.`);
      return;
    }

    analytics.logSearch(id, text);
    // Поиск идёт в фоне, обработчик сразу возвращается. Иначе grammY держит
    // очередь апдейтов на ~секунды LLM+OPDS, и остальные юзеры ждут; тот же
    // корень был у дублей скачивания и слабого лимита под нагрузкой.
    void track(runSearch(ctx, id, text));
  }

  async function runSearch(ctx: HandlerCtx, id: number, text: string) {
    // Ленивый статус: на быстром пути (кэш-хит / быстрый промах < 700 мс) не
    // показываем ничего — иначе статус мерцал бы («появился → тут же список»).
    // Один нативный typing закрывает ленивое окно до 700 мс.
    void ctx.replyWithChatAction?.("typing").catch(() => {});
    let ref: MsgRef | null = null;
    let pendingSend: Promise<MsgRef> | null = null;
    let resolved = false;
    let currentPhase: "parsing" | "searching" = "parsing";
    const phaseText = (p: "parsing" | "searching") =>
      p === "parsing" ? "Разбираю запрос…" : "Ищу у себя в библиотеке…";

    const lazy = setTimeout(() => {
      if (resolved) return;
      pendingSend = msg.send(id, phaseText(currentPhase));
      pendingSend.then((r) => { if (!resolved) ref = r; }).catch(() => {});
    }, 700);

    // Если статус уже в полёте (send запущен, но не завершился к моменту ответа) —
    // дождаться его и положить финальный текст в то же сообщение, а не отдельным
    // reply. Иначе на переходном окне 700–1000 мс статус и список были бы двумя
    // сообщениями (мерцание).
    const ensureRef = async (): Promise<MsgRef | null> => {
      if (ref) return ref;
      if (pendingSend) { ref = await pendingSend.catch(() => null); return ref; }
      return null;
    };

    try {
      let books: FlibustaBook[] = [];
      let degraded = false;
      let lowRelevance = false;
      await searchSem.acquire();
      try {
        const r = await orchestrator.search(text, 15, (phase) => {
          currentPhase = phase;
          if (ref) void msg.edit(ref, phaseText(phase));
        });
        books = r.books;
        degraded = r.degraded;
        lowRelevance = r.lowRelevance === true;
      } finally {
        searchSem.release();
      }
      resolved = true;
      clearTimeout(lazy);

      if (!books.length) {
        const emptyText = "К сожалению ничего не нашёл. Попробуй написать запрос точнее, добавив автора или полное название книги.";
        const r = await ensureRef();
        if (r) await msg.edit(r, emptyText);
        else await ctx.reply(emptyText);
        return;
      }
      lastResults.set(id, books);
      lastQuery.set(id, text);
      lastPage.set(id, 0);
      const r = await ensureRef();
      // Слабое совпадение — пометка, чтобы пользователь не принял приближение за точный ответ.
      const hint = lowRelevance ? "Я не нашёл конкретно, что ты просил, но у меня есть похожие экземпляры.\n\n" : "";
      const listText = hint + bookListText(books, text, 0);
      const listExtra = { reply_markup: bookListKeyboard(books, 0), parse_mode: "HTML" };
      if (r) await msg.edit(r, listText, listExtra);
      else await ctx.reply(listText, listExtra);
    } catch (e) {
      resolved = true;
      clearTimeout(lazy);
      console.error("search error:", (e as Error).message, "| query:", text);
      const r = await ensureRef();
      if (r) await msg.edit(r, "Поиск сломался. Извините.").catch(() => {});
      else await ctx.reply("Поиск сломался. Извините.").catch(() => {});
    }
  }

  async function onCallback(ctx: HandlerCtx) {
    const id = ctx.from?.id;
    if (!id) return;
    const data = ctx.callbackQuery?.data ?? "";
    const results = lastResults.get(id) ?? [];

    if (data === "list") {
      const page = lastPage.get(id) ?? 0;
      await ctx.editMessageText(bookListText(results, lastQuery.get(id), page), { reply_markup: bookListKeyboard(results, page), parse_mode: "HTML" });
      await ctx.answerCallbackQuery();
      return;
    }

    if (data.startsWith("page:")) {
      const page = Number(data.slice(5));
      const pages = Math.min(3, Math.ceil(results.length / 5));
      await ctx.answerCallbackQuery();
      if (Number.isNaN(page) || page < 0 || page >= pages) return;
      lastPage.set(id, page);
      await ctx.editMessageText(bookListText(results, lastQuery.get(id), page), { reply_markup: bookListKeyboard(results, page), parse_mode: "HTML" });
      return;
    }

    if (data === "noop") {
      await ctx.answerCallbackQuery();
      return;
    }

    if (data.startsWith("book:")) {
      const idx = Number(data.slice(5));
      const book = results[idx];
      if (!book) return;
      await ctx.editMessageText(bookCardText(book), { reply_markup: formatsKeyboard(book, idx), parse_mode: "HTML" });
      await ctx.answerCallbackQuery();
      return;
    }

    if (data.startsWith("fmt:")) {
      await ctx.answerCallbackQuery();
      if (rateLimited(id)) { await ctx.reply("Слишком много запросов, подожди минуту."); return; }
      const [, idxStr, fmt] = data.split(":");
      const idx = Number(idxStr);
      const book = results[idx];
      if (!book) return;

      let url: string;
      try {
        url = flibusta.downloadUrl(book, fmt);
      } catch (e) {
        console.error("download url fail:", (e as Error).message, "| book:", book.title, "| fmt:", fmt);
        await ctx.reply("Нет ссылки на этот формат. Выбери другой.");
        return;
      }
      const filename = `${book.title}.${fmt}`.replace(/[\\/:*?"<>|]/g, "_");
      // Дневной лимит скачиваний (скользящие 24ч). Безлимитные юзеры проходят.
      if (!unlimited(id) && analytics.countSince(id, "download", dayAgo()) >= cfg.downloadDailyLimit) {
        await ctx.reply(`Дневной лимит скачиваний исчерпан: ${cfg.downloadDailyLimit} за 24 часа. Попробуй через несколько часов.`);
        return;
      }
      // Защита от повторных кликов «скачать». Два слоя:
      // 1) inflight — файл прямо сейчас качается. Ключ ставится синхронно в
      //    обработчике и живёт до завершения фоновой загрузки, поэтому ловит
      //    повторы из любых батчей (раньше — только из одного: обработчик
      //    блокировался и ключ снимался до прихода следующего клика).
      // 2) кулдаун — файл только что скачан (клики после завершения).
      const gkey = `${id}:${url}`;
      if (inflight.has(gkey)) {
        await ctx.reply("Эта книга уже скачивается, подожди немного.");
        return;
      }
      const done = lastDownload.get(gkey);
      if (done && Date.now() - done < DOWNLOAD_COOLDOWN_MS) {
        await ctx.reply("Эта книга уже была скачана. Подожди пару секунд, прежде чем повторить скачивание.");
        return;
      }
      inflight.add(gkey);
      // Скачивание в фоне — обработчик сразу возвращается, очередь апдейтов не стоит.
      void track(runDownload(ctx, id, book, url, filename, fmt, gkey));
      return;
    }
  }

  async function runDownload(ctx: HandlerCtx, id: number, book: FlibustaBook, url: string, filename: string, fmt: string, gkey: string) {
    let ref: MsgRef | null = null;
    try {
      await downloadSem.acquire();
      try {
        ref = await msg.send(id, `Скачиваю «${book.title}»…`);
        const meta = await downloader.fetchThen(url, filename, async (filePath) => {
          const { size } = await fs.stat(filePath);
          // Перед отправкой документа меняем статус, чтобы пользователь видел
          // переход от скачивания к отправке.
          await msg.edit(ref!, "Отправляю…");
          // grammY требует InputFile (или строку), не «сырой» объект — иначе
          // отправка файла молча падала в catch без лога.
          await ctx.replyWithDocument(new InputFile(filePath, filename));
          return { size };
        }, fmt, (p) => { void msg.edit(ref!, formatProgress(p)); });
        lastDownload.set(gkey, Date.now());
        analytics.logDownload(id, {
          book_title: book.title, book_id: extractBookId(book, url),
          author: book.author, genre: book.category, format: fmt, size_bytes: meta.size,
        });
        // Документ отправлен — статус больше не нужен, убираем.
        await msg.delete(ref);
      } finally {
        downloadSem.release();
      }
    } catch (e) {
      // Раньше ошибка глоталась без лога — отсюда пустые логи. Теперь видно причину.
      console.error("download fail:", (e as Error).message, "| url:", url, "| fmt:", fmt, "| book:", book.title);
      // Если статус уже отправлен — правим его на текст ошибки; иначе обычный reply.
      if (ref) await msg.edit(ref, "Не удалось скачать. Попробуй другой формат.").catch(() => {});
      else await ctx.reply("Не удалось скачать файл. Попробуй другой формат.").catch(() => {});
    } finally {
      inflight.delete(gkey);
    }
  }

  async function onStats(ctx: HandlerCtx) {
    const id = ctx.from?.id;
    if (!id || !cfg.adminIds.includes(id)) return;
    const days = Number(ctx.message?.text?.split(/\s+/)[1]) || 30;
    await ctx.reply(analytics.report(days));
  }

  return { onText, onCallback, onStats, lastResults, idle };
}

function extractBookId(book: FlibustaBook, url: string): number {
  const m = url.match(/\/b\/(\d+)/);
  return m ? Number(m[1]) : 0;
}

// Байты → МБ (1024-based, 1 знак). Для прогресса скачивания.
function mb(bytes: number): string {
  return (bytes / 1024 / 1024).toFixed(1);
}
function formatProgress(p: { downloaded: number; total: number | null }): string {
  if (p.total && p.total > 0) {
    const pct = Math.min(100, Math.round((p.downloaded / p.total) * 100));
    return `Скачано ${pct}% · ${mb(p.downloaded)} / ${mb(p.total)} МБ`;
  }
  // Content-Length неизвестен (chunked/zip) — проценты не считаем, только объём.
  return `Скачано ${mb(p.downloaded)} МБ`;
}

// Приветствие для /start и /help. Только для allowlist-пользователей:
// посторонним бот молчит, чтобы не раскрывать своё существование.
// Картинка встроена в образ (assets/welcome.jpg).
const WELCOME_IMG = "/app/assets/welcome.jpg";
const WELCOME_TEXT = `Привет. Это бот для поиска и скачивания книг.

Работает он просто: пришли название книги, автора или то и другое. Например:
• белый клык лондон
• пелевин

Получишь список книг с форматами, размером, числом скачиваний и переводом. Нажми на нужный тебе номер, и откроется описание, там выберешь формат для скачивания (fb2, epub, mobi, pdf, txt и другие).

Поиск занимает 2-3 секунды.

«Просвещение — это выход человека из состояния своего несовершеннолетия, в котором он находится по собственной вине».`;


// Точка входа — собирает всё из конфига и запускает polling
export function buildApp(cfg: Config, db: Db) {
  const llm = createLlm({ llmBase: cfg.llmBase, llmApiKey: cfg.llmApiKey, model: cfg.model });
  const flibusta = createFlibusta({ base: cfg.flibustaBase, fallbackBase: cfg.flibustaFallbackBase });
  const orchestrator = createOrchestrator(llm, flibusta, {
    cacheTtlSec: cfg.searchCacheTtlSec,
    cacheMax: cfg.searchCacheMax,
  });
  const analytics = createAnalytics(db);
  const downloader = createDownloader("/tmp/book-search-downloads");
  const bot = new Bot(cfg.botToken);
  // messenger берёт уже собранный bot.api: статус правит наши собственные
  // сообщения по id через bot.api.editMessageText, а не входящее через ctx.
  const messenger = createStatusMessenger(bot.api);
  const handlers = createBotHandlers(cfg, orchestrator, analytics, downloader, flibusta, messenger);
  // ctx в grammY содержит токен бота. При ошибке логируем только сообщение и
  // update_id — не весь ctx, иначе токен попадает в постоянные логи.
  bot.catch((err) => {
    console.error("bot error:", err.message, "| update_id:", err.ctx?.update?.update_id);
  });
  bot.command("stats", (ctx) => handlers.onStats(ctx as unknown as HandlerCtx));
  // /start и /help — фото с подписью, только для своих. Если фото не отправилось
  // (например, файл пропал из образа) — падаем на текст, чтобы не терять онбординг.
  const welcome = async (c: HandlerCtx) => {
    const id = c.from?.id;
    if (!id) return;
    const text = `${WELCOME_TEXT}\n\nЛимиты: ${cfg.downloadDailyLimit} скачиваний и ${cfg.searchDailyLimit} поисков за 24 часа.`;
    try {
      await c.replyWithPhoto(new InputFile(WELCOME_IMG), { caption: text });
    } catch (e) {
      console.error("welcome photo fail:", (e as Error).message);
      await c.reply(text);
    }
  };
  bot.command("start", (ctx) => welcome(ctx as unknown as HandlerCtx));
  bot.command("help", (ctx) => welcome(ctx as unknown as HandlerCtx));
  bot.on("message:text", (ctx) => handlers.onText(ctx as unknown as HandlerCtx));
  bot.on("callback_query:data", (ctx) => handlers.onCallback(ctx as unknown as HandlerCtx));
  return { bot, handlers, db };
}