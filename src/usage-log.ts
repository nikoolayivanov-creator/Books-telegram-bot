// usage-log — structured-лог запросов и выборов пользователей для замера
// качества поиска на реальном трафике (Часть A плана железобетонного замера).
// JSONL append в USAGE_LOG_PATH (дефолт /logs/usage.jsonl внутри контейнера).
// telegram id хешируется — приватность: в логе стабильный псевдоним, не сам id.
// logUsage никогда не бросает: логирование не должно влиять на обработку запроса.
import fs from "node:fs";
import crypto from "node:crypto";

// Путь читаем лениво при каждом вызове, а не один раз на старте модуля: так тесты
// задают USAGE_LOG_PATH во временный файл, а путь можно сменить без пересборки.
function logPath(): string {
  return process.env.USAGE_LOG_PATH || "/logs/usage.jsonl";
}

// Стабильный псевдоним telegram id: sha256, первые 8 hex-символов. Достаточно,
// чтобы различать пользователей и считать уникальные, не храня сам id.
export function aliasOf(id: number): string {
  return crypto.createHash("sha256").update(String(id)).digest("hex").slice(0, 8);
}

// Дописать запись в JSONL. ts ISO — время события для последующего отбора по
// периоду. appendFileSync блокирующий, но RPS бота низкий (rate limit + дневные
// лимиты); для масштаба персонального бота sync append проще и надёжнее буфера.
export function logUsage(rec: Record<string, unknown>): void {
  try {
    fs.appendFileSync(logPath(), JSON.stringify({ ts: new Date().toISOString(), ...rec }) + "\n", "utf8");
  } catch {
    // молча: упавший лог не должен ронять поиск/скачивание
  }
}
