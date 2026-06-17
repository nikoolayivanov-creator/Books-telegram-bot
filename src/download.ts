import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import AdmZip from "adm-zip";

export type DownloadMeta = { size: number };
type OnFile = (filePath: string) => Promise<DownloadMeta>;

// flibusta заворачивает эти форматы в zip: /b/ID/fb2 отдаёт application/zip с
// одним .fb2 внутри. Если отправить такой zip под именем «Книга.fb2», читалка
// ждёт XML и файл не открывается — отсюда впечатление, что «работает только
// mobi» (он идёт сырым файлом). Распаковываем внутренний файл перед отправкой.
// epub/pdf/mobi НЕ трогаем: epub сам по себе zip (вскрывать нельзя), pdf и mobi
// приходят уже готовым файлом.
const WRAP_FORMATS = new Set(["fb2", "txt", "rtf", "html", "doc"]);

function unwrapZip(buf: Buffer): Buffer {
  if (!(buf[0] === 0x50 && buf[1] === 0x4b)) return buf; // PK — не zip
  try {
    const datas = new AdmZip(buf)
      .getEntries()
      .filter((e) => !e.entryName.endsWith("/"))
      .map((e) => e.getData());
    if (!datas.length) return buf;
    // flibusta: один внутренний файл. Если несколько — крупнейший, это сама книга.
    datas.sort((a, b) => b.length - a.length);
    return datas[0];
  } catch {
    return buf; // битый zip — лучше отправить как есть, чем уронить скачивание
  }
}

export function createDownloader(tmpDir: string) {
  return {
    async fetchThen(
      url: string,
      filename: string,
      onFile: OnFile,
      fmt?: string,
    ): Promise<DownloadMeta> {
      const res = await fetch(url);
      if (!res.ok || !res.body) {
        throw new Error(`скачивание не удалось: ${res.status} для ${url}`);
      }
      let buf: Buffer = Buffer.from(await res.arrayBuffer());
      if (fmt && WRAP_FORMATS.has(fmt)) buf = unwrapZip(buf);
      const safeName = filename.replace(/[^\w.-]+/g, "_");
      const file = path.join(tmpDir, `${crypto.randomUUID()}-${safeName}`);
      await fs.writeFile(file, buf);
      try {
        return await onFile(file);
      } finally {
        await fs.unlink(file).catch(() => {});
      }
    },
  };
}
