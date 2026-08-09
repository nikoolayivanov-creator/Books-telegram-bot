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

  it("searchBooks combines author-by-id + by-name results and dedups by id", async () => {
    (FlibustaAPI as any).mockImplementation(() => ({
      getAuthors: vi.fn().mockResolvedValue([{ id: 6116, name: "Конан Дойль", books: 1 }]),
      getBooksByAuthorOpdsPaginated: vi.fn().mockResolvedValue({
        items: [{ title: "Шерлок", author: [{ name: "Конан Дойль" }], categories: ["детектив"], downloads: [{ link: "/b/1/fb2", type: "application/fb2+zip" }] }],
        currentPage: 0, hasNextPage: false, hasPreviousPage: false,
      }),
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
    expect(titles.filter((t) => t === "Шерлок")).toHaveLength(1); // дедуп по id (обе записи /b/1/)
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

describe("searchBooks: стриминг title-поиска", () => {
  afterEach(() => vi.clearAllMocks());

  // Title-only запрос прежде молчал от «Ищу...» до «Сравниваю...», пока ждёт
  // одиночный getBooksByNameFromOpds. Теперь стримим title-search, чтобы пользователь
  // видел, что бот работает, а не завис.
  it("title-only запрос стримит title-search перед поиском по названию", async () => {
    (FlibustaAPI as any).mockImplementation(() => ({
      getAuthors: vi.fn(),
      getBooksByAuthorOpdsPaginated: vi.fn(),
      getBooksByNameFromOpds: vi.fn().mockResolvedValue([
        { title: "X", author: [], downloads: [{ link: "/b/9/fb2" }] },
      ]),
    }));
    const f = createFlibusta({ base: "https://flibusta.is" });
    const events: any[] = [];
    await f.searchBooks({ title: "что-то" }, (p) => events.push(p));
    expect(events).toEqual([{ kind: "title-search" }]);
  });

  it("author-only поиск (без title) не стримит title-search", async () => {
    (FlibustaAPI as any).mockImplementation(() => ({
      getAuthors: vi.fn().mockResolvedValue([{ id: 1, name: "Автор", books: 1 }]),
      getBooksByAuthorOpdsPaginated: vi.fn().mockResolvedValue({
        items: [{ title: "Роман", author: [{ name: "Автор" }], downloads: [{ link: "/b/1/fb2" }] }],
        currentPage: 0, hasNextPage: false, hasPreviousPage: false,
      }),
      getBooksByNameFromOpds: vi.fn(),
    }));
    const f = createFlibusta({ base: "https://flibusta.is" });
    const events: any[] = [];
    await f.searchBooks({ authors: ["Автор"] }, (p) => events.push(p));
    const kinds = events.map((e) => e.kind);
    expect(kinds).not.toContain("title-search");
    expect(kinds).toContain("author-found");
  });
});

describe("splitSearchBooks: фильтр тезок", () => {
  // Воспроизводит баг «Юрий Лотман»: разбиение «юрий»/«лотман» находило по
  // имени «Юрий» самого плодовитого тезку (Никитина) и тащило все его книги,
  // хотя фамилия «Лотман» из запроса к нему отношения не имеет. Title-часть
  // разбиения («лотман») должна объясняться — входить в название или в автора
  // книги. У книг Никитина она не объясняется → тезка отсекается.
  const mockTnamesake = () => {
    const getAuthors = vi.fn(async (q: string) => {
      if (q.includes("лотман")) return [{ id: 1, name: "Лотман Юрий Михайлович", books: 100 }];
      if (q.includes("юрий")) return [{ id: 2, name: "Никитин Юрий", books: 500 }];
      return [];
    });
    const getBooksByAuthorOpds = vi.fn(async (id: number) => {
      if (id === 1)
        return [
          { title: "Беседы о русской культуре", author: [{ name: "Лотман Юрий Михайлович" }], categories: [], downloads: [{ link: "/b/1/fb2", type: "application/fb2+zip" }] },
        ];
      if (id === 2)
        return [
          { title: "Башня - два", author: [{ name: "Никитин Юрий" }], categories: [], downloads: [{ link: "/b/2/fb2", type: "application/fb2+zip" }] },
        ];
      return [];
    });
    (FlibustaAPI as any).mockImplementation(() => ({
      getAuthors,
      getBooksByAuthorOpds,
      getBooksByNameFromOpds: vi.fn(async () => []),
    }));
  };

  afterEach(() => vi.clearAllMocks());

  it("не заводит тезку по имени: книги Никитина отсутствуют при поиске «Юрий Лотман»", async () => {
    mockTnamesake();
    const f = createFlibusta({ base: "https://flibusta.is" });
    const res = await f.splitSearchBooks("Юрий Лотман");
    const authors = res.map((r) => r.book.author);
    expect(authors).toContain("Лотман Юрий Михайлович");
    expect(authors).not.toContain("Никитин Юрий");
  });
});

describe("searchBooks: пагинация автора (RC1)", () => {
  afterEach(() => vi.clearAllMocks());

  // Воспроизводит баг: getBooksByAuthorOpds отдаёт 1-ю страницу (20 книг), у
  // Ефремова 189 — «Таис Афинская» на 7-й странице была недоступна. Обёртка
  // теперь перебирает страницы, пока hasNextPage=true.
  it("собирает все страницы, пока hasNextPage=true (книга с 2-й страницы доступна)", async () => {
    const pages = [
      { items: [{ title: "Книга A", author: [{ name: "Ефремов" }], downloads: [{ link: "/b/10/fb2" }] }], currentPage: 0, hasNextPage: true, hasPreviousPage: false },
      { items: [{ title: "Таис Афинская", author: [{ name: "Ефремов" }], downloads: [{ link: "/b/11/fb2" }] }], currentPage: 1, hasNextPage: true, hasPreviousPage: true },
      { items: [{ title: "Книга C", author: [{ name: "Ефремов" }], downloads: [{ link: "/b/12/fb2" }] }], currentPage: 2, hasNextPage: false, hasPreviousPage: true },
    ];
    const pag = vi.fn(async (_id: number, page: number) => pages[page]);
    (FlibustaAPI as any).mockImplementation(() => ({
      getAuthors: vi.fn().mockResolvedValue([{ id: 3057, name: "Ефремов Иван", books: 189 }]),
      getBooksByAuthorOpdsPaginated: pag,
      getBooksByNameFromOpds: vi.fn().mockResolvedValue([]),
    }));

    const f = createFlibusta({ base: "https://flibusta.is" });
    const books = await f.searchBooks({ authors: ["Ефремов"] });
    const titles = books.map((b) => b.title);
    expect(titles).toContain("Таис Афинская"); // была на 2-й странице, раньше недоступна
    expect(pag).toHaveBeenCalledTimes(3); // 0, 1, 2 — остановка на hasNextPage=false
    expect(books).toHaveLength(3);
  });

  it("дедуп по id: разные издания одного title (разные /b/id) сохраняются", async () => {
    (FlibustaAPI as any).mockImplementation(() => ({
      getAuthors: vi.fn().mockResolvedValue([{ id: 1, name: "Автор", books: 2 }]),
      getBooksByAuthorOpdsPaginated: vi.fn().mockResolvedValue({
        items: [
          { title: "Роман", author: [{ name: "Автор" }], downloads: [{ link: "/b/100/fb2" }] },
          { title: "Роман", author: [{ name: "Автор" }], downloads: [{ link: "/b/200/fb2" }] },
        ],
        currentPage: 0, hasNextPage: false, hasPreviousPage: false,
      }),
      getBooksByNameFromOpds: vi.fn().mockResolvedValue([]),
    }));
    const f = createFlibusta({ base: "https://flibusta.is" });
    const books = await f.searchBooks({ authors: ["Автор"] });
    expect(books.filter((b) => b.title === "Роман")).toHaveLength(2);
    expect(books.map((b) => b.id).sort()).toEqual([100, 200]);
  });

  it("extracts id из download-ссылки", async () => {
    (FlibustaAPI as any).mockImplementation(() => ({
      getAuthors: vi.fn(),
      getBooksByAuthorOpdsPaginated: vi.fn(),
      getBooksByNameFromOpds: vi.fn().mockResolvedValue([
        { title: "X", author: [], downloads: [{ link: "/b/777/fb2" }] },
      ]),
    }));
    const f = createFlibusta({ base: "https://flibusta.is" });
    const books = await f.searchBooks({ title: "x" });
    expect(books[0].id).toBe(777);
  });
});

describe("searchBooks: стриминг прогресса пагинации", () => {
  afterEach(() => vi.clearAllMocks());

  // Пагинация плодовитого автора стримится в чат: author-found (выбрали автора,
  // знаем объём) → paging на каждой странице с накопленным числом книг и сигналом
  // «нашёл», когда цель попалась. pageSize берём по первой странице (мок даёт по
  // 1 книге → totalPages = ceil(booksCount / 1)).
  it("звони author-found + paging на каждой странице с booksSoFar и found", async () => {
    const pages = [
      { items: [{ title: "Книга A", author: [{ name: "Ефремов" }], downloads: [{ link: "/b/10/fb2" }] }], currentPage: 0, hasNextPage: true, hasPreviousPage: false },
      { items: [{ title: "Таис Афинская", author: [{ name: "Ефремов" }], downloads: [{ link: "/b/11/fb2" }] }], currentPage: 1, hasNextPage: true, hasPreviousPage: true },
      { items: [{ title: "Книга C", author: [{ name: "Ефремов" }], downloads: [{ link: "/b/12/fb2" }] }], currentPage: 2, hasNextPage: false, hasPreviousPage: true },
    ];
    const pag = vi.fn(async (_id: number, page: number) => pages[page]);
    (FlibustaAPI as any).mockImplementation(() => ({
      getAuthors: vi.fn().mockResolvedValue([{ id: 3057, name: "Ефремов Иван", books: 3 }]),
      getBooksByAuthorOpdsPaginated: pag,
      getBooksByNameFromOpds: vi.fn().mockResolvedValue([]),
    }));

    const f = createFlibusta({ base: "https://flibusta.is" });
    const events: any[] = [];
    await f.searchBooks({ authors: ["Ефремов"] }, (p) => events.push(p), { targetTitle: "таис афинская" });

    // author-found первым: выбрали автора из тезок, знаем объём его библиотеки
    expect(events[0]).toEqual({ kind: "author-found", author: "Ефремов Иван", books: 3 });

    const paged = events.filter((e) => e.kind === "paging");
    expect(paged).toHaveLength(3);
    // Страница 1: накопление, цели ещё нет
    expect(paged[0].page).toBe(1);
    expect(paged[0].totalPages).toBe(3); // ceil(3 / pageSize=1)
    expect(paged[0].booksSoFar).toBe(1);
    expect(paged[0].found).toBeUndefined();
    // Страница 2: цель попалась — сообщаем один раз
    expect(paged[1].page).toBe(2);
    expect(paged[1].booksSoFar).toBe(2);
    expect(paged[1].found).toBe("Таис Афинская");
    // Страница 3: found не повторяется (уже сообщён)
    expect(paged[2].booksSoFar).toBe(3);
    expect(paged[2].found).toBeUndefined();
  });

  it("без targetTitle сигнал «нашёл» не срабатывает (found всегда undefined)", async () => {
    const pages = [
      { items: [{ title: "Таис Афинская", author: [{ name: "Ефремов" }], downloads: [{ link: "/b/11/fb2" }] }], currentPage: 0, hasNextPage: false, hasPreviousPage: false },
    ];
    (FlibustaAPI as any).mockImplementation(() => ({
      getAuthors: vi.fn().mockResolvedValue([{ id: 3057, name: "Ефремов Иван", books: 1 }]),
      getBooksByAuthorOpdsPaginated: vi.fn(async () => pages[0]),
      getBooksByNameFromOpds: vi.fn().mockResolvedValue([]),
    }));
    const f = createFlibusta({ base: "https://flibusta.is" });
    const events: any[] = [];
    await f.searchBooks({ authors: ["Ефремов"] }, (p) => events.push(p));
    const paged = events.filter((e) => e.kind === "paging");
    expect(paged).toHaveLength(1);
    expect(paged[0].found).toBeUndefined();
  });
});