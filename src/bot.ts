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
// flibusta/z.ai — риск троттлинга и бана upstream.
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
) {
  // Кеш последних результатов поиска по user_id (в памяти, TTL через неактивность — для MVP достаточно)
  const lastResults = new Map<number, FlibustaBook[]>();
  // Последний запрос пользователя — чтобы перерисовать список из карточки.
  const lastQuery = new Map<number, string>();
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
    // Дневной лимит поисков — защита квоты z.ai и от абьюза на публичном боте.
    // Считаем сырые поиски за скользящие 24ч. Безлимитные юзеры проходят.
    if (!unlimited(id) && analytics.countSince(id, "search", dayAgo()) >= cfg.searchDailyLimit) {
      await ctx.reply(`Лимит поисков исчерпан: ${cfg.searchDailyLimit} за 24 часа. Попробуй через несколько часов — лимит обновляется постепенно.`);
      return;
    }

    analytics.logSearch(id, text);
    // Поиск идёт в фоне, обработчик сразу возвращается. Иначе grammY держит
    // очередь апдейтов на ~секунды LLM+OPDS, и остальные юзеры ждут; тот же
    // корень был у дублей скачивания и слабого лимита под нагрузкой.
    void track(runSearch(ctx, id, text));
  }

  async function runSearch(ctx: HandlerCtx, id: number, text: string) {
    // Поиск идёт несколько секунд — держим нативный индикатор «печатает»,
    // чтобы пользователь видел, что бот работает, даже пока стоит в очереди семафора.
    const fire = () => Promise.resolve(ctx.replyWithChatAction?.("typing")).catch(() => {});
    await fire();
    const typing = setInterval(fire, 4000);
    try {
      let books: FlibustaBook[] = [];
      let degraded = false;
      await searchSem.acquire();
      try {
        const r = await orchestrator.search(text, 5);
        books = r.books;
        degraded = r.degraded;
      } finally {
        searchSem.release();
      }

      if (!books.length) {
        await ctx.reply(degraded ? "Ничего не нашёл (поиск без LLM). Уточни запрос." : "Ничего не нашёл. Уточни запрос.");
        return;
      }
      lastResults.set(id, books);
      lastQuery.set(id, text);
      await ctx.reply(bookListText(books, text), { reply_markup: bookListKeyboard(books), parse_mode: "HTML" });
    } catch (e) {
      console.error("search error:", (e as Error).message, "| query:", text);
      await ctx.reply("Поиск сломался. Попробуй ещё раз.").catch(() => {});
    } finally {
      clearInterval(typing);
    }
  }

  async function onCallback(ctx: HandlerCtx) {
    const id = ctx.from?.id;
    if (!id) return;
    const data = ctx.callbackQuery?.data ?? "";
    const results = lastResults.get(id) ?? [];

    if (data === "list") {
      await ctx.editMessageText(bookListText(results, lastQuery.get(id)), { reply_markup: bookListKeyboard(results), parse_mode: "HTML" });
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
        await ctx.reply(`Дневной лимит скачиваний исчерпан: ${cfg.downloadDailyLimit} за 24 часа. Попробуй через несколько часов — лимит обновляется постепенно.`);
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
    try {
      await downloadSem.acquire();
      try {
        const meta = await downloader.fetchThen(url, filename, async (filePath) => {
          const { size } = await fs.stat(filePath);
          // grammY требует InputFile (или строку), не «сырой» объект — иначе
          // отправка файла молча падала в catch без лога.
          await ctx.replyWithDocument(new InputFile(filePath, filename));
          return { size };
        }, fmt);
        lastDownload.set(gkey, Date.now());
        analytics.logDownload(id, {
          book_title: book.title, book_id: extractBookId(book, url),
          author: book.author, genre: book.category, format: fmt, size_bytes: meta.size,
        });
      } finally {
        downloadSem.release();
      }
    } catch (e) {
      // Раньше ошибка глоталась без лога — отсюда пустые логи. Теперь видно причину.
      console.error("download fail:", (e as Error).message, "| url:", url, "| fmt:", fmt, "| book:", book.title);
      await ctx.reply("Не удалось скачать файл. Попробуй другой формат.").catch(() => {});
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

// Приветствие для /start и /help.
const WELCOME_TEXT = `Привет. Это бот для поиска и скачивания книг.

Пришли название, автора или то и другое. Например:
• белый клык лондон
• пелевин

Получишь список книг с форматами, размером, числом скачиваний и переводчиком. Нажми номер — откроется описание, там выберешь формат для скачивания (fb2, epub, mobi, pdf, txt…).

Поиск занимает несколько секунд.

«Просвещение — это выход человека из состояния своего несовершеннолетия, в котором он находится по собственной вине».`;


// Точка входа — собирает всё из конфига и запускает polling
export function buildApp(cfg: Config, db: Db) {
  const llm = createLlm({ zaiBase: cfg.zaiBase, zaiApiKey: cfg.zaiApiKey, model: cfg.model });
  const flibusta = createFlibusta({ base: cfg.flibustaBase, fallbackBase: cfg.flibustaFallbackBase });
  const orchestrator = createOrchestrator(llm, flibusta, {
    cacheTtlSec: cfg.searchCacheTtlSec,
    cacheMax: cfg.searchCacheMax,
  });
  const analytics = createAnalytics(db);
  const downloader = createDownloader("/tmp/flibusta-downloads");
  const handlers = createBotHandlers(cfg, orchestrator, analytics, downloader, flibusta);

  const bot = new Bot(cfg.botToken);
  // ctx в grammY содержит токен бота. При ошибке логируем только сообщение и
  // update_id — не весь ctx, иначе токен попадает в постоянные логи.
  bot.catch((err) => {
    console.error("bot error:", err.message, "| update_id:", err.ctx?.update?.update_id);
  });
  bot.command("stats", (ctx) => handlers.onStats(ctx as unknown as HandlerCtx));
  // /start и /help — текстовое приветствие с лимитами.
  const welcome = async (c: HandlerCtx) => {
    const id = c.from?.id;
    if (!id) return;
    const text = `${WELCOME_TEXT}\n\nЛимиты: ${cfg.downloadDailyLimit} скачиваний и ${cfg.searchDailyLimit} поисков за 24 часа.`;
    await c.reply(text);
  };
  bot.command("start", (ctx) => welcome(ctx as unknown as HandlerCtx));
  bot.command("help", (ctx) => welcome(ctx as unknown as HandlerCtx));
  bot.on("message:text", (ctx) => handlers.onText(ctx as unknown as HandlerCtx));
  bot.on("callback_query:data", (ctx) => handlers.onCallback(ctx as unknown as HandlerCtx));
  return { bot, handlers, db };
}