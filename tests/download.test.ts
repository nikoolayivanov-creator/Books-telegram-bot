import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createDownloader } from "../src/download.js";
import AdmZip from "adm-zip";

describe("downloader", () => {
  const tmp = path.join(os.tmpdir(), `fb-test-${Date.now()}`);
  const origFetch = global.fetch;
  beforeEach(async () => { await fs.mkdir(tmp, { recursive: true }); });
  afterEach(async () => {
    global.fetch = origFetch;
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it("downloads to tmp file, reports size, and deletes it after", async () => {
    global.fetch = vi.fn(async () =>
      new Response("hello-book-content", { status: 200 })
    ) as any;
    let reportedPath = "";
    const onFile = vi.fn(async (p: string) => { reportedPath = p; return { size: 100 }; });
    const d = createDownloader(tmp);
    const meta = await d.fetchThen("https://flibusta.is/b/1/fb2", "book.fb2", onFile);
    expect(meta.size).toBe(100);
    // файл удалён после onFile
    await expect(fs.access(reportedPath)).rejects.toThrow();
  });

  it("throws on non-200", async () => {
    global.fetch = vi.fn(async () => new Response("nope", { status: 404 })) as any;
    const d = createDownloader(tmp);
    await expect(d.fetchThen("https://x/b/1/fb2", "b.fb2", async () => ({ size: 0 })))
      .rejects.toThrow(/404|скачивание/i);
  });

  it("распаковывает fb2.zip и пишет внутренний файл", async () => {
    const zip = new AdmZip();
    zip.addFile("book.fb2", Buffer.from('<?xml version="1.0"?><FictionBook/>'));
    global.fetch = vi.fn(async () => new Response(zip.toBuffer(), { status: 200 })) as any;
    let got = "";
    const onFile = async (p: string) => { got = (await fs.readFile(p)).toString(); return { size: got.length }; };
    const d = createDownloader(tmp);
    await d.fetchThen("https://flibusta.is/b/1/fb2", "Книга.fb2", onFile, "fb2");
    expect(got).toContain("<FictionBook");
  });

  it("не трогает epub (zip — это и есть формат)", async () => {
    const zip = new AdmZip();
    zip.addFile("mimetype", Buffer.from("application/epub+zip"));
    zip.addFile("OEBPS/content.xhtml", Buffer.from("<html/>"));
    global.fetch = vi.fn(async () => new Response(zip.toBuffer(), { status: 200 })) as any;
    let got = Buffer.alloc(0);
    const onFile = async (p: string) => { got = await fs.readFile(p); return { size: got.length }; };
    const d = createDownloader(tmp);
    await d.fetchThen("https://flibusta.is/b/1/epub", "Книга.epub", onFile, "epub");
    expect(got[0]).toBe(0x50); // PK — zip сохранён как есть
  });
});