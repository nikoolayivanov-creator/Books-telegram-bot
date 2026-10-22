# flibusta-telegram-bot

[RU](README.md) · [EN](README.en.md) · **中文** · [Español](README.es.md) · [Français](README.fr.md)

在 [Flibusta](https://flibusta.is) 上搜索并下载图书的 Telegram 机器人。

LLM 在这里只做一件事：把自由文本的查询解析成「作者 + 书名」的结构，让 Flibusta 的 OPDS 搜索准确命中。搜索、排序和下载都是确定性的，不经过 LLM。与 LLM 解析并行还跑着一个确定性的拆分枚举——两个候选池合并后，每本书以两个评分中较高的一个进入结果。

## 功能

- 自由文本搜索（"conan doyle sherlock"、"wite fang london"）：LLM 提取作者和书名，拆分枚举同时在旁兜底。
- 排序后的结果列表，附格式、大小、下载次数和译者；3 页，每页 5 本。
- 图书卡片带简介和格式按钮（fb2、epub、mobi、pdf、txt、rtf、html）。
- 下载并解包：Flibusta 把文本格式打包在 zip 里，机器人取出内部文件，让阅读器能直接打开。
- 搜索过程实时推送到聊天：「解析中」「搜索中」「翻到第 3/10 页」「比对中」。用户看得到机器人在做什么，而不是在沉默中等待。
- 24 小时滑动窗口的每日限额：10 次下载、50 次搜索，另有一份不限量的 ID 列表。
- SQLite 中的统计分析（`/stats`），内存中的搜索缓存保留 6 小时。
- 查询和所选图书记入 JSONL 日志（telegram id 用 sha256 哈希）——方便自己做搜索质量分析。

## LLM 的使用方式

每次未命中缓存的搜索只调用一次 `parseQuery`，把文本转换成 `{authors, title, series, genre}`。之后 LLM 不再参与。

搜索同时走两条路径：

1. **LLM 解析**——`parseQuery` 得到的结构按作者和书名送入 Flibusta 的 OPDS 搜索。
2. **确定性拆分枚举**（`splitSearchBooks`）——把查询拆成各种「作者 + 书名」组合，逐个用搜索验证，不涉及 LLM。

两个候选池合并，每本书按两种解析分别评分并取最大值。拆分枚举覆盖 LLM 失手的情况（只按作者搜索、含杂讯的真实查询），并在服务商故障时兜底：LLM 不可用时，搜索转入降级模式（整个查询当作书名），拆分枚举照常工作。为了速度关闭了 LLM 的 reasoning；命中缓存的查询一次调用都不发起。

在 200 个查询上的测试（100 本书，每本分别用干净和带错的表述）：LLM 与拆分枚举结合后，干净查询的 top-3 精确命中率为 80%，带错查询为 75%；不用 LLM 时，带错查询的搜索跌到 17%——拆分枚举无法从含错别字和杂讯的短语里提取作者和书名。

## 环境要求

- Node 20（用 Docker 最省事）。
- 从 @BotFather 领取的 Telegram 机器人 token。
- OpenAI 兼容 LLM 服务商的 API key（bothub.chat、OpenAI 等）。
- 装有 Docker 的服务器或 VPS。

## 配置

```bash
cp .env.example .env
```

| 变量 | 必填 | 默认值 | 说明 |
|---|---|---|---|
| `BOT_TOKEN` | 是 | - | @BotFather 发的 token |
| `ADMIN_IDS` | 是 | - | 管理员的 Telegram ID，逗号分隔，可查看 `/stats` |
| `LLM_API_KEY` | 是 | - | LLM 服务商的 key |
| `LLM_BASE` | 是 | - | OpenAI 兼容端点，如 `https://openai.bothub.chat/v1` |
| `MODEL` | 是 | - | 模型，如 `gemini-2.5-flash` |
| `FLIBUSTA_BASE` | 是 | - | Flibusta 镜像，如 `https://flibusta.is` |
| `FLIBUSTA_FALLBACK_BASE` | 否 | - | 备用镜像 |
| `ALLOWED_IDS` | 否 | （空） | 白名单；留空表示机器人对公众开放 |
| `UNLIMITED_IDS` | 否 | - | 不受每日限额限制的 ID |
| `DOWNLOAD_DAILY_LIMIT` | 否 | 10 | 每 24 小时的下载次数 |
| `SEARCH_DAILY_LIMIT` | 否 | 50 | 每 24 小时的搜索次数 |
| `RATE_LIMIT_PER_MIN` | 否 | 20 | 每用户每分钟的请求数 |
| `MAX_QUERY_LEN` | 否 | 100 | 查询的最大长度（字符数） |
| `SEARCH_CACHE_TTL_SEC` | 否 | 21600 | 搜索缓存的 TTL |
| `SEARCH_CACHE_MAX` | 否 | 2000 | 搜索缓存的条目数 |
| `USAGE_LOG_PATH` | 否 | `/logs/usage.jsonl` | 查询和选择日志的路径（id 做哈希） |
| `LOG_TTL_DAYS` | 否 | - | 事件在 SQLite 中的保留天数 |

## 运行（Docker）

```bash
docker compose up -d --build
docker compose logs -f
```

## 部署到 VPS

在 `deploy.sh` 里写好 `VPS=user@host`，然后：

```bash
./deploy.sh
```

脚本通过 ssh 同步代码，构建镜像并重启容器。

## 开发

```bash
npm install
npm test
npm run build && npm start
```

## 架构

- `bot.ts`——grammY 的 long polling 处理器，非阻塞：重活转入后台，更新队列不会堆积。流式输出的逻辑也在这里：进度事件汇总成状态文案并做节流，避免刷屏。
- `search/orchestrator.ts`——搜索核心：缓存 → LLM 解析 → 合并 LLM 候选池与拆分枚举 → 确定性排名 → 取 top-N。排名按书名和作者的匹配度计算，用 Levenshtein 做错别字的模糊匹配；得分相同时，更热门的版本排在前面。
- `search/llm.ts`——LLM 客户端（OpenAI 兼容），只有一个方法 `parseQuery`。
- `search/flibusta.ts`——对 npm 包 `flibusta` 的封装：OPDS 搜索、作者书目的分页（多产作者一页放不下）、按热度从同名作者中选择、每个网络调用都有超时。
- `download.ts`——下载到 tmpfs 并解开 zip 外壳。
- `status.ts`——状态消息的文案：搜索的各个阶段、下载进度。
- `usage-log.ts`——查询和所选图书的 JSONL 日志（telegram id 用 sha256 哈希，不存内容）。
- `db.ts` 和 `analytics.ts`——SQLite 中的事件日志和每日限额。

## 法律方面

Flibusta 上图书的版权状态因司法辖区而异。请确认在您所在的辖区有权下载这些内容。LLM 服务商和模型都可配置，请遵守所选服务商的使用条款。

## 许可证

MIT © vonavikon
