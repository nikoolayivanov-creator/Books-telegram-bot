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
    expect(m.flibusta.searchBooks).toHaveBeenCalledWith({ title: "просто текст" });
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

  it("промах кэша: onProgress звони parsing → searching по порядку", async () => {
    const books = [{ title: "Белый Клык", formats: ["fb2"] }];
    const m = makeMocks(books);
    const o = createOrchestrator(m.llm as any, m.flibusta as any);
    const phases: string[] = [];
    await o.search("белый клык", 5, (p) => phases.push(p));
    expect(phases).toEqual(["parsing", "searching"]);
  });

  it("кэш-хит: onProgress не звони ни разу", async () => {
    const books = [{ title: "Белый Клык", formats: ["fb2"] }];
    const m = makeMocks(books);
    const o = createOrchestrator(m.llm as any, m.flibusta as any);
    await o.search("белый клык", 5); // прогрев кэша
    const phases: string[] = [];
    await o.search("белый клык", 5, (p) => phases.push(p));
    expect(phases).toEqual([]);
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
