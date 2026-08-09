import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// usage-log читает USAGE_LOG_PATH лениво при каждом вызове, поэтому каждый тест
// выставляет свой путь ДО первого logUsage, а модуль подгружаем динамическим
// import — он возьмёт свежий env. aliasOf от env не зависит, но держим единый стиль.
describe("usage-log", () => {
  let tmpFile: string;

  beforeEach(() => {
    tmpFile = path.join(os.tmpdir(), `usage-${Math.random().toString(36).slice(2)}.jsonl`);
    process.env.USAGE_LOG_PATH = tmpFile;
  });

  afterEach(() => {
    delete process.env.USAGE_LOG_PATH;
    try { fs.unlinkSync(tmpFile); } catch { /* мог не создаться */ }
  });

  it("aliasOf is stable, differs per id, 8 hex chars", async () => {
    const { aliasOf } = await import("../src/usage-log.js");
    expect(aliasOf(111)).toBe(aliasOf(111));
    expect(aliasOf(111)).not.toBe(aliasOf(222));
    expect(aliasOf(111)).toMatch(/^[0-9a-f]{8}$/);
  });

  it("logUsage appends JSON lines with ts and the record fields", async () => {
    const { logUsage } = await import("../src/usage-log.js");
    logUsage({ event: "query", uh: "abc12345", q: "пушкин евгений онегин", len: 20 });
    logUsage({ event: "choose", uh: "abc12345", book_id: 42, title: "Евгений Онегин" });

    const lines = fs.readFileSync(tmpFile, "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);

    const first = JSON.parse(lines[0]);
    expect(first).toMatchObject({ event: "query", uh: "abc12345", q: "пушкин евгений онегин", len: 20 });
    expect(first.ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);

    const second = JSON.parse(lines[1]);
    expect(second).toMatchObject({ event: "choose", book_id: 42 });
    expect(second.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("does not throw when the log path is not writable", async () => {
    process.env.USAGE_LOG_PATH = "/nonexistent-dir-x/usage/usage.jsonl";
    const { logUsage } = await import("../src/usage-log.js");
    expect(() => logUsage({ event: "query", uh: "z" })).not.toThrow();
  });
});
