# flibusta-telegram-bot

[RU](README.md) · **EN** · [中文](README.zh.md) · [Español](README.es.md) · [Français](README.fr.md)

A Telegram bot for searching and downloading books from [Flibusta](https://flibusta.is).

The LLM does one thing here: it parses a free-form query into an "author + title" structure so that Flibusta's OPDS search hits the mark. Search, ranking, and downloading are deterministic and run without an LLM. In parallel with the LLM parse, a deterministic split enumeration runs — both candidate pools are merged, and each book enters the results with the better of the two scores.

## Features

- Free-text search ("conan doyle sherlock", "wite fang london"): the LLM pulls out the author and the title, while the split enumeration covers it in parallel.
- A ranked list with formats, size, download count, and translator; 3 pages of 5 books each.
- A book card with a description and format buttons (fb2, epub, mobi, pdf, txt, rtf, html).
- Download with unpacking: Flibusta serves text formats inside a zip, and the bot extracts the inner file so that your reader app can open it.
- Streaming search progress into the chat: "parsing", "searching", "browsing page 3/10", "comparing". The user sees what the bot is doing instead of waiting in silence.
- Daily limits on a rolling 24-hour window: 10 downloads, 50 searches, plus a list of unlimited IDs.
- Analytics in SQLite (`/stats`), an in-memory search cache for 6 hours.
- A JSONL log of queries and chosen books (Telegram id hashed with sha256) — for your own search-quality analytics.

## How the LLM is used

For every uncached search there is one `parseQuery` call that converts the text into `{authors, title, series, genre}`. The LLM takes no part after that.

Search runs along two paths at once:

1. **LLM parse** — the structure from `parseQuery` goes into Flibusta's OPDS search by author and title.
2. **Deterministic split enumeration** (`splitSearchBooks`) — the query is broken into "author + title" variants, and each variant is checked by search, without an LLM.

The candidate pools are merged, each book is scored under both parses, and the maximum of the two scores wins. The enumeration covers the cases where the LLM misses (author-only search, messy real-world queries) and backs the bot up when the provider fails: if the LLM is unavailable, search drops to a degraded mode (the whole query is treated as a title), and the enumeration still does its job. LLM reasoning is turned off for speed; cached queries make no calls at all.

A benchmark on 200 queries (100 books, each phrased once cleanly and once messily): combining the LLM and the enumeration yields 80% exact hits in the top 3 on clean queries and 75% on messy ones; without the LLM, search on messy queries drops to 17% — the enumeration cannot pull the author and the title out of a phrase with typos and noise.

## Requirements

- Node 20 (Docker is the easiest route).
- A Telegram bot token from @BotFather.
- An API key for an OpenAI-compatible LLM provider (bothub.chat, OpenAI, etc.).
- A server or VPS with Docker.

## Configuration

```bash
cp .env.example .env
```

| Variable | Req. | Default | Description |
|---|---|---|---|
| `BOT_TOKEN` | yes | - | token from @BotFather |
| `ADMIN_IDS` | yes | - | comma-separated Telegram IDs of admins; they can see `/stats` |
| `LLM_API_KEY` | yes | - | LLM provider key |
| `LLM_BASE` | yes | - | OpenAI-compatible endpoint, e.g. `https://openai.bothub.chat/v1` |
| `MODEL` | yes | - | model, e.g. `gemini-2.5-flash` |
| `FLIBUSTA_BASE` | yes | - | Flibusta mirror, e.g. `https://flibusta.is` |
| `FLIBUSTA_FALLBACK_BASE` | no | - | fallback mirror |
| `ALLOWED_IDS` | no | (empty) | whitelist; empty means the bot is public |
| `UNLIMITED_IDS` | no | - | IDs without daily limits |
| `DOWNLOAD_DAILY_LIMIT` | no | 10 | downloads per 24 h |
| `SEARCH_DAILY_LIMIT` | no | 50 | searches per 24 h |
| `RATE_LIMIT_PER_MIN` | no | 20 | requests per minute per user |
| `MAX_QUERY_LEN` | no | 100 | maximum query length, in characters |
| `SEARCH_CACHE_TTL_SEC` | no | 21600 | search cache TTL |
| `SEARCH_CACHE_MAX` | no | 2000 | entries in the search cache |
| `USAGE_LOG_PATH` | no | `/logs/usage.jsonl` | path to the query and selection log (the id is hashed) |
| `LOG_TTL_DAYS` | no | - | how many days events are kept in SQLite |

## Running (Docker)

```bash
docker compose up -d --build
docker compose logs -f
```

## Deploying to a VPS

In `deploy.sh`, set `VPS=user@host`, then:

```bash
./deploy.sh
```

The script syncs the code over ssh, builds the image, and restarts the container.

## Development

```bash
npm install
npm test
npm run build && npm start
```

## Architecture

- `bot.ts` — grammY handlers on long polling, non-blocking: heavy work goes to the background, so the update queue does not pile up. The streaming logic lives here too: progress events are folded into status texts with throttling, so the chat is not spammed.
- `search/orchestrator.ts` — the search core: cache → LLM parse → merge of the LLM pool and the split enumeration → deterministic rank → top-N. Ranking scores how well the title and the author match, with fuzzy matching of typos via Levenshtein; when scores tie, the more popular edition ranks higher.
- `search/llm.ts` — an LLM client (OpenAI-compatible) with a single method, `parseQuery`.
- `search/flibusta.ts` — a wrapper over the `flibusta` npm package: OPDS search, pagination of an author's bibliography (prolific authors do not fit on the first page), choosing among authors with the same name by popularity, a timeout on every network call.
- `download.ts` — downloading into tmpfs and unpacking the zip wrapper.
- `status.ts` — status message texts: search phases, download progress.
- `usage-log.ts` — a JSONL log of queries and chosen books (the Telegram id is hashed with sha256, content is not stored).
- `db.ts` and `analytics.ts` — the event journal in SQLite and the daily limits.

## Legal notes

Books on Flibusta have different copyright status depending on the jurisdiction. Make sure you have the right to download the content in yours. The LLM provider and the model are configurable, so follow the terms of use of the provider you choose.

## License

MIT © vonavikon
