import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// flibusta-api default export — мокаем через vi.mock
vi.mock("flibusta", () => {
  const mock = vi.fn();
  return { default: mock };
});

import FlibustaAPI from "flibusta";
import { createFlibusta, chooseAuthorId } from "../src/search/flibusta.js";

describe("chooseAuthorId", () => {
  it("точное совпадение имени предпочтительнее первого в списке", () => {
    const id = chooseAuthorId("Джек Лондон", [
      { id: 1, name: "Джон Лондон" },
      { id: 2, name: "Джек Лондон" },
    ]);
    expect(id).toBe(2);
  });

  it("совпадение по включению, если точного нет", () => {
    const id = chooseAuthorId("Лондон", [
      { id: 1, name: "Лондон Джек" },
      { id: 2, name: "Джон Смит" },
    ]);
    expect(id).toBe(1);
  });

  it("fallback на первого, если ничего не совпало (старое поведение)", () => {
    const id = chooseAuthorId("Абракадабра", [
      { id: 1, name: "Кто-то" },
      { id: 2, name: "Другой" },
    ]);
    expect(id).toBe(1);
  });

  it("пустой список → undefined", () => {
    expect(chooseAuthorId("X", [])).toBeUndefined();
  });

  it("по токенам, когда слова те же, но в другом порядке (ни точного, ни включения)", () => {
    const id = chooseAuthorId("джек лондон", [
      { id: 1, name: "другой писатель" },
      { id: 2, name: "лондон джек писатель" },
    ]);
    expect(id).toBe(2);
  });
});

describe("flibusta wrapper", () => {
  afterEach(() => vi.clearAllMocks());

  it("searchBooks combines author-by-id + by-name results and dedups by title", async () => {
    (FlibustaAPI as any).mockImplementation(() => ({
      getAuthors: vi.fn().mockResolvedValue([{ id: 6116, name: "Конан Дойль", books: 1 }]),
      getBooksByAuthorOpds: vi.fn().mockResolvedValue([
        { title: "Шерлок", author: [{ name: "Конан Дойль" }], categories: ["детектив"], downloads: [{ link: "/b/1/fb2", type: "application/fb2+zip" }] },
      ]),
      getBooksByNameFromOpds: vi.fn().mockResolvedValue([
        { title: "Шерлок", author: [{ name: "Конан Дойль" }], categories: ["детектив"], downloads: [{ link: "/b/1/fb2", type: "application/fb2+zip" }] },
        { title: "Другая", author: [{ name: "Кто-то" }], categories: [], downloads: [{ link: "/b/2/fb2", type: "application/fb2+zip" }] },
      ]),
    }));

    const f = createFlibusta({ base: "https://flibusta.is" });
    const books = await f.searchBooks({ authors: ["конан дойл"], title: "шерлок" });
    const titles = books.map((b) => b.title);
    expect(titles).toContain("Шерлок");
    expect(titles).toContain("Другая");
    expect(titles.filter((t) => t === "Шерлок")).toHaveLength(1); // дедуп
  });

  it("searchBooks works with only title (no author)", async () => {
    (FlibustaAPI as any).mockImplementation(() => ({
      getAuthors: vi.fn(),
      getBooksByAuthorOpds: vi.fn(),
      getBooksByNameFromOpds: vi.fn().mockResolvedValue([
        { title: "X", author: [], categories: [], downloads: [{ link: "/b/9/fb2", type: "application/fb2+zip" }] },
      ]),
    }));
    const f = createFlibusta({ base: "https://flibusta.is" });
    const books = await f.searchBooks({ title: "что-то" });
    expect(books[0].title).toBe("X");
    expect(books[0].formats).toEqual(["fb2"]);
  });

  it("downloadUrl returns absolute url for a format", async () => {
    (FlibustaAPI as any).mockImplementation(() => ({
      getAuthors: vi.fn(), getBooksByAuthorOpds: vi.fn(),
      getBooksByNameFromOpds: vi.fn().mockResolvedValue([
        { title: "X", author: [], categories: [], downloads: [
          { link: "/b/9/fb2", type: "application/fb2+zip" },
          { link: "/b/9/epub", type: "application/epub+zip" },
        ] },
      ]),
    }));
    const f = createFlibusta({ base: "https://flibusta.is" });
    const books = await f.searchBooks({ title: "x" });
    expect(f.downloadUrl(books[0], "epub")).toBe("https://flibusta.is/b/9/epub");
  });
});