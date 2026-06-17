import { describe, it, expect, vi } from "vitest";
import { createOrchestrator } from "../src/search/orchestrator.js";

const makeMocks = (books: any[]) => ({
  llm: {
    parseQuery: vi.fn().mockResolvedValue({ authors: ["джек лондон"], title: "белый клык" }),
    rankBooks: vi.fn(),
  },
  flibusta: { searchBooks: vi.fn().mockResolvedValue(books) },
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
});
