import { loadConfig } from "./config.js";
import { createDb } from "./db.js";
import { buildApp } from "./bot.js";

const cfg = loadConfig();
const db = createDb("/data/flibusta-bot.db");

if (cfg.logTtlDays) {
  const day = 86400;
  const cutoff = Math.floor(Date.now() / 1000) - cfg.logTtlDays * day;
  db.cleanupOldEvents(cutoff);
}

const { bot } = buildApp(cfg, db);

// Docker шлёт SIGTERM при stop/restart. Закрываем SQLite чисто.
const shutdown = () => {
  db.close();
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

bot.start({
  onStart: () => console.log("flibusta-bot started"),
});
