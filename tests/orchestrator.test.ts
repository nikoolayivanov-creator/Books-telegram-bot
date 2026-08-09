import { describe, it, expect, vi } from "vitest";
import { createOrchestrator, relevance } from "../src/search/orchestrator.js";

const makeMocks = (books: any[]) => ({
  llm: {
    parseQuery: vi.fn().mockResolvedValue({ authors: ["джек лондон"], title: "белый клык" }),
    rankBooks: vi.fn(),
  },
  flibusta: { searchBooks: vi.fn().mockResolvedValue(books), splitSearchBooks: vi.fn().mockResolvedValue([]) },
});

describe("orchestrator", () => {
  it("ранжирует точное совпадение названия выше остальных (детерминированно, без LLM-rank)", async () => {
    const books = [
      { title: "Быки", author: "Лондон Джек", formats: ["fb2"] },
      { title: "Белый Клык", author: "Лондон Джек", formats: ["fb2"] },
    ];
    const m = makeMocks(books);
    const o = createOrchestrator(m.llm as any, m.flibusta as any);
    const r = await o.search("белый клык джек лондон", 5);
    expect(m.llm.parseQuery).toHaveBeenCalledWith("белый клык джек лондон");
    expect(m.flibusta.searchBooks).toHaveBeenCalled();
    // Ранжирование детерминированное, второй LLM-вызов не нужен
    expect(m.llm.rankBooks).not.toHaveBeenCalled();
    expect(r.books[0].title).toBe("Белый Клык");
    expect(r.degraded).toBe(false);
  });

  it("деградирует к raw-поиску при ошибке LLM-разбора (результаты всё равно сортируются)", async () => {
    const books = [{ title: "X", formats: ["fb2"] }];
    const m = makeMocks(books);
    m.llm.parseQuery.mockRejectedValue(new Error("llm down"));
    const o = createOrchestrator(m.llm as any, m.flibusta as any);
    const r = await o.search("просто текст", 5);
    expect(m.flibusta.searchBooks).toHaveBeenCalledWith(
      { title: "просто текст" },
      expect.any(Function),
      { targetTitle: "просто текст" },
    );
    expect(m.llm.rankBooks).not.toHaveBeenCalled();
    expect(r.degraded).toBe(true);
    expect(r.books[0].title).toBe("X");
  });

  it("возвращает пусто (без throw), если flibusta ничего не нашёл", async () => {
    const m = makeMocks([]);
    const o = createOrchestrator(m.llm as any, m.flibusta as any);
    const r = await o.search("несуществующее", 5);
    expect(r.books).toHaveLength(0);
  });

  it("кэширует повторный запрос: flibusta и LLM дёргаются по одному разу", async () => {
    const books = [{ title: "Белый Клык", author: "Лондон Джек", formats: ["fb2"] }];
    const m = makeMocks(books);
    const o = createOrchestrator(m.llm as any, m.flibusta as any);
    await o.search("белый клык", 5);
    await o.search("белый клык", 5);
    expect(m.flibusta.searchBooks).toHaveBeenCalledTimes(1);
    expect(m.llm.parseQuery).toHaveBeenCalledTimes(1);
  });

  it("ключ кэша нормализован: регистр/пунктуация/пробелы не дают промах", async () => {
    const books = [{ title: "Белый Клык", formats: ["fb2"] }];
    const m = makeMocks(books);
    const o = createOrchestrator(m.llm as any, m.flibusta as any);
    await o.search("Белый, Клык!", 5);
    await o.search("  белый клык  ", 5);
    expect(m.flibusta.searchBooks).toHaveBeenCalledTimes(1);
  });

  it("разные запросы бьют мимо кэша — два обращения к flibusta", async () => {
    const books = [{ title: "X", formats: ["fb2"] }];
    const m = makeMocks(books);
    const o = createOrchestrator(m.llm as any, m.flibusta as any);
    await o.search("пелевин", 5);
    await o.search("акунин", 5);
    expect(m.flibusta.searchBooks).toHaveBeenCalledTimes(2);
  });

  it("деградированный результат не кэшируется: повтор идёт в flibusta заново", async () => {
    const books = [{ title: "X", formats: ["fb2"] }];
    const m = makeMocks(books);
    m.llm.parseQuery.mockRejectedValue(new Error("llm down"));
    const o = createOrchestrator(m.llm as any, m.flibusta as any);
    await o.search("просто текст", 5);
    await o.search("просто текст", 5);
    expect(m.flibusta.searchBooks).toHaveBeenCalledTimes(2);
  });

  it("промах кэша: onProgress звони parsing → searching → splitting → ranking", async () => {
    const books = [{ title: "Белый Клык", formats: ["fb2"] }];
    const m = makeMocks(books);
    const o = createOrchestrator(m.llm as any, m.flibusta as any);
    const kinds: string[] = [];
    await o.search("белый клык", 5, (p) => kinds.push(p.kind));
    // Мок flibusta не звони paging/author-found/title-search (то реальный flibusta,
    // отдельный тест); orchestrator генерирует parsing, searching, splitting
    // (запрос из 2 токенов) и ranking сам.
    expect(kinds).toEqual(["parsing", "searching", "splitting", "ranking"]);
  });

  it("однословный запрос: splitting не звони (split работает от 2 токенов)", async () => {
    const books = [{ title: "X", formats: ["fb2"] }];
    const m = makeMocks(books);
    const o = createOrchestrator(m.llm as any, m.flibusta as any);
    const kinds: string[] = [];
    await o.search("пелевин", 5, (p) => kinds.push(p.kind));
    expect(kinds).toEqual(["parsing", "searching", "ranking"]);
  });

  it("ranking несёт размер пула кандидатов", async () => {
    const books = [{ title: "Белый Клык", formats: ["fb2"] }];
    const m = makeMocks(books);
    const o = createOrchestrator(m.llm as any, m.flibusta as any);
    let rankingCount: number | undefined;
    await o.search("белый клык", 5, (p) => { if (p.kind === "ranking") rankingCount = p.count; });
    expect(rankingCount).toBe(1);
  });

  it("кэш-хит: onProgress не звони ни разу", async () => {
    const books = [{ title: "Белый Клык", formats: ["fb2"] }];
    const m = makeMocks(books);
    const o = createOrchestrator(m.llm as any, m.flibusta as any);
    await o.search("белый клык", 5); // прогрев кэша
    const kinds: string[] = [];
    await o.search("белый клык", 5, (p) => kinds.push(p.kind));
    expect(kinds).toEqual([]);
  });
});

describe("relevance: серия", () => {
  it("бонус +60 за точное совпадение серии", () => {
    const base = relevance("белый клык", [], undefined, { title: "Белый Клык" } as any);
    const scored = relevance("белый клык", [], "детство", { title: "Белый Клык", series: "Детство" } as any);
    expect(scored - base).toBe(60);
  });

  it("бонус +30 за частичное совпадение серии (включение)", () => {
    const base = relevance("белый клык", [], "песнь льда", { title: "Белый Клык" } as any);
    const scored = relevance("белый клык", [], "песнь льда", { title: "Белый Клык", series: "Песнь льда и пламени" } as any);
    expect(scored - base).toBe(30);
  });

  it("точное совпадение названия доминирует над серией конкурента", () => {
    const series = "песнь льда и пламени";
    // A: точное название, чужая серия
    const a = relevance("игра престолов", [], series, { title: "Игра престолов", series: "Другая" } as any);
    // B: неточное название, но нужная серия
    const b = relevance("игра престолов", [], series, { title: "Игра", series: "Песнь льда и пламени" } as any);
    expect(a).toBeGreaterThan(b);
  });

  it("серия не учитывается, если в запросе её не задали", () => {
    const withSeries = relevance("белый клык", [], undefined, { title: "Белый Клык", series: "Детство" } as any);
    const noSeries = relevance("белый клык", [], undefined, { title: "Белый Клык" } as any);
    expect(withSeries).toBe(noSeries);
  });
});

describe("relevance: нормализация ё/е", () => {
  // Flibusta хранит имена без ё («Федор»), пользователи пишут с ё («Фёдор»).
  // Без приведения ё→е автор-матч ломается и фильтр тезок в split отсекает
  // книги самого автора: title-токен «фёдор» не находил «федор» в авторе книги.
  it("«Фёдор» в запросе матчит «Федор» в авторе книги", () => {
    const score = relevance("", ["Достоевский Фёдор"], undefined, {
      title: "Бесы",
      author: "Достоевский Федор Михайлович",
    } as any);
    expect(score).toBeGreaterThanOrEqual(60);
  });
});

describe("relevance: автор, обратный порядок слов", () => {
  // Дефект D: LLM отдаёт автора как «Имя Фамилия» (Лев Толстой), Flibusta хранит
  // «Фамилия Имя Отчество» (Толстой Лев Николаевич). Точного вхождения нет
  // (подстрока не матчится из-за порядка), остаётся токен-матч — 2 токена × 8 =
  // 16 < порога lowRelevance (50). Точный поиск по автору помечался «по
  // приближению». Полное покрытие токенов = те же имена в другом порядке, это
  // надёжное совпадение автора — приравниваем к точному (60).
  it("полное покрытие токенов автора = 60 даже при обратном порядке слов", () => {
    const score = relevance("", ["Лев Толстой"], undefined, {
      title: "Анна Каренина",
      author: "Толстой Лев Николаевич",
    } as any);
    expect(score).toBeGreaterThanOrEqual(60);
  });

  it("частичное покрытие (один из двух токенов) — слабый сигнал, ниже точного", () => {
    const full = relevance("", ["Лев Толстой"], undefined, {
      title: "X",
      author: "Толстой Лев Николаевич",
    } as any);
    const partial = relevance("", ["Лев Толстой"], undefined, {
      title: "X",
      author: "Толстой Алексей Николаевич",
    } as any);
    expect(full).toBeGreaterThan(partial);
  });
});

describe("порог lowRelevance", () => {
  it("слабое совпадение (не degraded) → lowRelevance: true, книги не пусты", async () => {
    const books = [{ title: "abc", formats: ["fb2"] }];
    const m = {
      llm: { parseQuery: vi.fn().mockResolvedValue({ title: "xyz" }), rankBooks: vi.fn() },
      flibusta: { searchBooks: vi.fn().mockResolvedValue(books), splitSearchBooks: vi.fn().mockResolvedValue([]) },
    };
    const o = createOrchestrator(m.llm as any, m.flibusta as any);
    const r = await o.search("запрос", 5);
    expect(r.lowRelevance).toBe(true);
    expect(r.books.length).toBeGreaterThan(0);
  });

  it("сильное совпадение → lowRelevance falsy", async () => {
    const books = [{ title: "Белый Клык", author: "Лондон Джек", formats: ["fb2"] }];
    const m = makeMocks(books);
    const o = createOrchestrator(m.llm as any, m.flibusta as any);
    const r = await o.search("белый клык", 5);
    expect(r.lowRelevance).toBeFalsy();
  });

  it("degraded → порог не применяется (lowRelevance falsy)", async () => {
    const books = [{ title: "X", formats: ["fb2"] }];
    const m = makeMocks(books);
    m.llm.parseQuery.mockRejectedValue(new Error("llm down"));
    const o = createOrchestrator(m.llm as any, m.flibusta as any);
    const r = await o.search("просто текст", 5);
    expect(r.degraded).toBe(true);
    expect(r.lowRelevance).toBeFalsy();
    expect(r.books.length).toBeGreaterThan(0);
  });

  it("lowRelevance-результат кэшируется (повтор не бьёт в flibusta)", async () => {
    const books = [{ title: "abc", formats: ["fb2"] }];
    const m = {
      llm: { parseQuery: vi.fn().mockResolvedValue({ title: "xyz" }), rankBooks: vi.fn() },
      flibusta: { searchBooks: vi.fn().mockResolvedValue(books), splitSearchBooks: vi.fn().mockResolvedValue([]) },
    };
    const o = createOrchestrator(m.llm as any, m.flibusta as any);
    await o.search("запрос", 5);
    await o.search("запрос", 5);
    expect(m.flibusta.searchBooks).toHaveBeenCalledTimes(1);
  });
});

describe("author-only поиск (без названия)", () => {
  // Воспроизводит дефект B: при author-only запросе parsed.title нет, и pt
  // приравнивался к сырому запросу. Тогда книги, где имя автора входит в
  // название (биографии, литературоведение чужих авторов), получали +600 за
  // вхождение и обгоняли книги самого автора.
  it("книга с именем автора в названии (чужая) не обгоняет книги самого автора", async () => {
    const books = [
      { title: "Беседы о русской культуре", author: "Лотман Юрий Михайлович", formats: ["fb2"] },
      { title: "Юрий Лотман жизнь", author: "Иванов Иван", formats: ["fb2"] },
    ];
    const m = {
      llm: { parseQuery: vi.fn().mockResolvedValue({ authors: ["Лотман"] }), rankBooks: vi.fn() },
      flibusta: { searchBooks: vi.fn().mockResolvedValue(books), splitSearchBooks: vi.fn().mockResolvedValue([]) },
    };
    const o = createOrchestrator(m.llm as any, m.flibusta as any);
    const r = await o.search("Юрий Лотман", 5);
    expect(r.books[0].author).toBe("Лотман Юрий Михайлович");
  });

  // Воспроизводит дефект C: author-only совпадение (+30) ниже порога
  // MIN_RELEVANCE (50), поэтому точный поиск по автору помечался lowRelevance
  // («по приближению»). Это валидный поиск — пометки быть не должно.
  it("точный поиск по автору не помечается lowRelevance", async () => {
    const books = [
      { title: "Беседы о русской культуре", author: "Лотман Юрий Михайлович", formats: ["fb2"], downloadsCount: "1000" },
    ];
    const m = {
      llm: { parseQuery: vi.fn().mockResolvedValue({ authors: ["Лотман"] }), rankBooks: vi.fn() },
      flibusta: { searchBooks: vi.fn().mockResolvedValue(books), splitSearchBooks: vi.fn().mockResolvedValue([]) },
    };
    const o = createOrchestrator(m.llm as any, m.flibusta as any);
    const r = await o.search("Лотман", 5);
    expect(r.lowRelevance).toBeFalsy();
  });

  // Воспроизводит «Александр Пушкин»: split-разбиение {authors:"александр",
  // title:"пушкин"} находит книги О Пушкине авторов по имени «Александр»
  // (Федута, Гуревич) — title «пушкин» действительно в их названиях. Без штрафа
  // за чужого автора они набирают +600 за title и обгоняют книги Пушкина.
  it("split-книга о авторе (чужой автор, имя автора в названии) не обгоняет книги автора", async () => {
    const llmBooks = [
      { title: "Барышня-крестьянка", author: "Пушкин Александр Сергеевич", formats: ["fb2"], downloadsCount: "35000" },
    ];
    const splitBooks = [
      { book: { title: "Пушкинская эпоха", author: "Федута Александр Иосифович", formats: ["fb2"], downloadsCount: "500" }, pt: "пушкин", authors: ["александр"] },
    ];
    const m = {
      llm: { parseQuery: vi.fn().mockResolvedValue({ authors: ["Пушкин"] }), rankBooks: vi.fn() },
      flibusta: { searchBooks: vi.fn().mockResolvedValue(llmBooks), splitSearchBooks: vi.fn().mockResolvedValue(splitBooks) },
    };
    const o = createOrchestrator(m.llm as any, m.flibusta as any);
    const r = await o.search("Александр Пушкин", 5);
    expect(r.books[0].author).toBe("Пушкин Александр Сергеевич");
  });
});

describe("relevance: fuzzy-матч названия с опечаткой (RC2)", () => {
  // gpt-4.1-nano не правит «Таяс»→«Таис»; строгое вхождение слова (+15) не
  // набирается, книга тонет. Пословный Левенштейн ловит опечатку и даёт бонус.
  it("«Таяс Афинская» fuzzy-матчит «Таис Афинская» (≥300)", () => {
    const s = relevance("таяс афинская", ["ефремов"], undefined, {
      title: "Таис Афинская", author: "Ефремов Иван",
    } as any);
    expect(s).toBeGreaterThanOrEqual(300);
  });

  it("«афинскаф» fuzzy-матчит «афинская» в составе названия (≥300)", () => {
    const s = relevance("афинскаф", ["ефремов"], undefined, {
      title: "Таис Афинская", author: "Ефремов Иван",
    } as any);
    expect(s).toBeGreaterThanOrEqual(300);
  });

  it("чужое название не получает fuzzy-бонус (0)", () => {
    const s = relevance("тараканы", [], undefined, { title: "Чапаев и Пустота" } as any);
    expect(s).toBe(0);
  });

  it("точное совпадение не уходит в fuzzy-ветку (1000)", () => {
    const s = relevance("белый клык", [], undefined, { title: "Белый Клык" } as any);
    expect(s).toBe(1000);
  });
});

describe("RC3: путаница author/title", () => {
  // LLM на запросе из названия без автора занёс его в authors → ложный
  // author-поиск + штраф. Если единственный «автор» = названию — убираем его.
  it("LLM занёс название в authors → author убран, книга top-1 без lowRelevance", async () => {
    const books = [{ title: "Таис Афинская", author: "Ефремов Иван", formats: ["fb2"], downloadsCount: "5000" }];
    const m = {
      llm: { parseQuery: vi.fn().mockResolvedValue({ authors: ["Таис Афинская"], title: "Таис Афинская" }), rankBooks: vi.fn() },
      flibusta: { searchBooks: vi.fn().mockResolvedValue(books), splitSearchBooks: vi.fn().mockResolvedValue([]) },
    };
    const o = createOrchestrator(m.llm as any, m.flibusta as any);
    const r = await o.search("Таис Афинская", 5);
    expect(r.books[0].title).toBe("Таис Афинская");
    expect(r.lowRelevance).toBeFalsy();
  });

  it("биография «Пушкин» (author-only, author!=title) не затрагивается", async () => {
    const books = [{ title: "Пушкинская эпоха", author: "Федута", formats: ["fb2"] }];
    const m = {
      llm: { parseQuery: vi.fn().mockResolvedValue({ authors: ["Пушкин"] }), rankBooks: vi.fn() },
      flibusta: { searchBooks: vi.fn().mockResolvedValue(books), splitSearchBooks: vi.fn().mockResolvedValue([]) },
    };
    const o = createOrchestrator(m.llm as any, m.flibusta as any);
    const r = await o.search("Пушкин", 5);
    expect(r.books[0].title).toBe("Пушкинская эпоха"); // author-поиск сохранился
  });
});
