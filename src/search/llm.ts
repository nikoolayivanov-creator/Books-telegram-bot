import { z } from "zod";

export type ParsedQuery = {
  authors?: string[];
  title?: string;
  series?: string;
  genre?: string;
};

export type BookLite = { title: string; author?: string };

type LlmDeps = { zaiBase: string; zaiApiKey: string; model: string };

// LLM возвращает JSON, но не гарантирует схему — валидируем рантаймом.
const ParsedQuerySchema = z.object({
  authors: z.array(z.string()).optional(),
  title: z.string().optional(),
  series: z.string().optional(),
  genre: z.string().optional(),
});

const RankSchema = z.object({
  ranking: z.array(z.number()).optional(),
});

const PARSE_PROMPT = `Ты парсер поискового запроса к библиотеке.
верни ТОЛЬКО JSON без пояснений: {"authors":["..."], "title":"...", "series":"...", "genre":"..."}.
Поля опускай если их нет в запросе. Нормализуй опечатки в именах авторов.
Запрос: `;

const RANK_PROMPT = `Ты ранжируешь результаты поиска книг по релевантности запросу.
Дан запрос и список книг (title + author). Верни ТОЛЬКО JSON: {"ranking":[индексы от наиболее релевантного]}.
Индексы — позиции в массиве (0-based). Без дубликатов.`;

// Жёсткий потолок одного LLM-вызова. Thinking выключен, норма 2-3с; z.ai изредка
// зависает — без таймаута пользователь ждёт минутами. По превышению throw →
// orchestrator уходит в degraded-поиск (без LLM).
const LLM_TIMEOUT_MS = 15_000;

export function createLlm(deps: LlmDeps) {
  async function complete(system: string, user: string): Promise<string> {
    const res = await fetch(`${deps.zaiBase}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${deps.zaiApiKey}`,
      },
      body: JSON.stringify({
        model: deps.model,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        temperature: 0,
        max_tokens: 1024,
        // GLM-4.5 включает thinking по умолчанию — ради парсинга одной строки в
        // JSON модель «размышляла» ~4-5с. Выключаем: запрос падает с ~6с до ~2-3с.
        thinking: { type: "disabled" },
      }),
      // Жёсткий потолок вызова. При зависании z.ai abort → throw → orchestrator
      // уходит в degraded-поиск (без LLM), вместо минут ожидания.
      signal: AbortSignal.timeout(LLM_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`z.ai ${res.status}: ${await res.text()}`);
    const data = (await res.json()) as {
      choices: { message: { content: string } }[];
    };
    return data.choices[0].message.content;
  }

  function extractJson(text: string): unknown | null {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start === -1 || end === -1) return null;
    try {
      return JSON.parse(text.slice(start, end + 1));
    } catch {
      return null;
    }
  }

  return {
    async parseQuery(raw: string): Promise<ParsedQuery> {
      const out = await complete(PARSE_PROMPT, raw);
      const parsed = ParsedQuerySchema.safeParse(extractJson(out));
      return parsed.success ? parsed.data : {};
    },

    async rankBooks(query: string, books: BookLite[], topN: number): Promise<BookLite[]> {
      const catalog = books.map((b, i) => `${i}. ${b.title} — ${b.author ?? "?"}`).join("\n");
      const out = await complete(RANK_PROMPT, `Запрос: ${query}\nКниги:\n${catalog}`);
      const parsed = RankSchema.safeParse(extractJson(out));
      const order = parsed.success ? (parsed.data.ranking ?? []) : [];
      const result: BookLite[] = [];
      for (const idx of order) {
        if (typeof idx === "number" && idx >= 0 && idx < books.length) {
          result.push(books[idx]);
        }
        if (result.length >= topN) break;
      }
      return result.length ? result : books.slice(0, topN);
    },
  };
}

export type Llm = ReturnType<typeof createLlm>;