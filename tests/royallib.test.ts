import { describe, it, expect, vi, afterEach } from "vitest";
import { createRoyallib } from "../src/search/royallib.js";

// Минимальные HTML-сниппеты, повторяющие реальную структуру royallib (см. дампы
// /tmp/royallib_search.html и /tmp/royallib_card.html). Важно: секции «Авторы» и
// «Серии» идут ДО «Книги» — парсер должен брать только книги.
const SEARCH_HTML = `<html><body>
<table>
  <tr><td><h2 class=viewbook>Авторы</h2></td></tr>
  <tr><td><a href="//royallib.com/author/tolstoy_lev.html">Толстой Лев</a></td></tr>
  <tr><td><h2 class=viewbook>Книги</h2></td></tr>
  <tr>
    <td><a href="//royallib.com/book/tolstoy_lev/smert_ivana_ilicha.html">Смерть Ивана Ильича</a></td>
    <td style="width:25px;">&nbsp;</td>
    <td style="width:115px;"><a href="//royallib.com/author/tolstoy_lev.html"><font size="-2">Толстой Лев</font></a></td>
  </tr>
  <tr>
    <td><a href="//royallib.com/book/ribakov_vyacheslav/smert_ivana_ilicha.html">Смерть Ивана Ильича</a></td>
    <td>&nbsp;</td>
    <td><a href="//royallib.com/author/ribakov_vyacheslav.html"><font size="-2">Рыбаков Вячеслав</font></a></td>
  </tr>
</table>
</body></html>`;

const CARD_HTML = `<html><body>
<h1 align=center class="viewbook">Толстой Лев - Смерть Ивана Ильича</h1>
<img width="205px" src="//royallib.com/data/images/192/cover_192617.jpg" />
<table>
<tr><td><b>Автор:</b><a href="//royallib.com/author/tolstoy_lev.html">Толстой Лев</a></td></tr>
<tr><td><b>Жанр:</b><a href="//royallib.com/genre/nauchnaya_fantastika/">Научная фантастика</a></td></tr>
<tr><td valign="top"><b>Аннотация:</b><br>В повести &laquo;Смерть Ивана Ильича&raquo; Толстой рассказывает историю.</td></tr>
</table>
Доступные форматы для скачивания:<br><br><a href="//royallib.com/get/fb2/tolstoy_lev/smert_ivana_ilicha.zip">Скачать в формате FB2</a> (Размер: 103 Кб)
<br><br><a href="//royallib.com/get/epub/tolstoy_lev/smert_ivana_ilicha.zip">Скачать в формате EPUB</a> (Размер: 118кб)
</body></html>`;

describe("royallib", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("searchBooks: парсит книги из секции «Книги» и добирает форматы из карточек", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      const u = String(url);
      if (u.includes("/search/")) {
        return new Response(SEARCH_HTML, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
      }
      if (u.includes("/book/")) {
        return new Response(CARD_HTML, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
      }
      return new Response("", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const r = createRoyallib({ base: "https://royallib.com" });
    const books = await r.searchBooks({ title: "смерть ивана ильича" });

    // Обе книги из секции «Книги» (Толстой + Рыбаков), секция «Авторы» не попала.
    expect(books).toHaveLength(2);
    expect(books[0].title).toBe("Смерть Ивана Ильича");
    expect(books[0].author).toBe("Толстой Лев");
    expect(books[1].author).toBe("Рыбаков Вячеслав");

    // Форматы и обложка/жанр/аннотация подтянуты из карточки.
    expect(books[0].provider).toBe("royallib");
    expect(books[0].formats).toContain("fb2");
    expect(books[0].formats).toContain("epub");
    expect(books[0].downloads[0].link).toMatch(/^https:\/\/royallib\.com\/get\//);
    expect(books[0].category).toBe("Научная фантастика");
    expect(books[0].coverUrl).toMatch(/\/data\/images\/192\/cover_192617\.jpg$/);
    expect(books[0].description).toContain("Смерть Ивана Ильича");
    expect(books[0].size).toBe("103 Кб");
  });

  it("searchBooks: без title и authors — пусто, POST не уходит", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const r = createRoyallib({ base: "https://royallib.com" });
    const books = await r.searchBooks({});
    expect(books).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("downloadUrl: возвращает абсолютную ссылку нужного формата", () => {
    const r = createRoyallib({ base: "https://royallib.com" });
    const book = {
      title: "X",
      formats: ["fb2", "epub"],
      downloads: [
        { link: "https://royallib.com/get/fb2/a/b.zip", format: "fb2" },
        { link: "https://royallib.com/get/epub/a/b.zip", format: "epub" },
      ],
    };
    expect(r.downloadUrl(book as any, "epub")).toBe("https://royallib.com/get/epub/a/b.zip");
  });

  it("downloadUrl: бросает, если ссылок нет", () => {
    const r = createRoyallib({ base: "https://royallib.com" });
    expect(() => r.downloadUrl({ title: "X", formats: [], downloads: [] } as any, "fb2")).toThrow();
  });
});
