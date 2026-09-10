import { z } from "zod";

export type ParsedQuery = {
  authors?: string[];
  title?: string;
  series?: string;
  genre?: string;
};

export type BookLite = { title: string; author?: string };

type LlmDeps = { llmBase: string; llmApiKey: string; model: string };

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

export const PARSE_PROMPT = `Ты парсер поискового запроса к библиотеке.
Верни ТОЛЬКО JSON без пояснений: {"authors":["..."], "title":"...", "series":"...", "genre":"..."}.
Поля опускай, если их нет в запросе. Нормализуй опечатки в именах авторов и в названии книги (например «гари потер» → «Гарри Поттер»). Серию («Песнь льда и пламени», «Сумерки») выноси в поле series, не включай её в title. genre — только если пользователь явно указал жанр.
title — это НАЗВАНИЕ книги, authors — ФАМИЛИЯ или имя автора. Не путай их: если в запросе нет фамилии автора (одно название), поле authors опускай. «Таис Афинская» — название романа Ивана Ефремова, а не имя автора.`;

// few-shot: примеры разбора. Учим разделять автора/название, править опечатки
// в названии, выносить серию и НЕ заносить название в authors (путаница на
// запросе из названия без автора). Turn-ы user/assistant вставляются между system
// и финальным запросом — канонический способ, надёжнее вписывания примеров в system.
export const FEW_SHOT: readonly { user: string; assistant: string }[] = [
  { user: "пелевин чапаев и пустота", assistant: '{"authors":["Пелевин"],"title":"Чапаев и Пустота"}' },
  { user: "гари потер и филосовский камень роулинг", assistant: '{"authors":["Роулинг"],"title":"Гарри Поттер и философский камень"}' },
  { user: "стругацкие пикник на обочине", assistant: '{"authors":["Стругацкие"],"title":"Пикник на обочине"}' },
  { user: "джордж мартин игра престолов песнь льда и пламени", assistant: '{"authors":["Мартин"],"title":"Игра престолов","series":"Песнь льда и пламени"}' },
  { user: "таяс афинская ефремов", assistant: '{"authors":["Ефремов"],"title":"Таис Афинская"}' },
  { user: "таис афинская", assistant: '{"title":"Таис Афинская"}' },
];

const RANK_PROMPT = `Ты ранжируешь результаты поиска книг по релевантности запросу.
Дан запрос и список книг (title + author). Верни ТОЛЬКО JSON: {"ranking":[индексы от наиболее релевантного]}.
Индексы — позиции в массиве (0-based). Без дубликатов.`;

// Жёсткий потолок одного LLM-вызова. Reasoning выключен, норма 2-3с; апстрим
// изредка зависает — без таймаута пользователь ждёт минутами. По превышению
// throw → orchestrator уходит в degraded-поиск (без LLM). 8с: с запасом над
// нормой, но быстрее отдаёт degraded-путь при зависшем апстриме.
const LLM_TIMEOUT_MS = 8_000;

export function createLlm(deps: LlmDeps) {
  async function complete(
    system: string,
    user: string,
    fewShot?: readonly { user: string; assistant: string }[],
  ): Promise<string> {
    const messages: { role: string; content: string }[] = [
      { role: "system", content: system },
    ];
    if (fewShot) {
      for (const ex of fewShot) {
        messages.push({ role: "user", content: ex.user });
        messages.push({ role: "assistant", content: ex.assistant });
      }
    }
    messages.push({ role: "user", content: user });
    const res = await fetch(`${deps.llmBase}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${deps.llmApiKey}`,
      },
      body: JSON.stringify({
        model: deps.model,
        messages,
        temperature: 0,
        max_tokens: 1024,
        // reasoning-модели думают по умолчанию и съедают бюджет токенов ради
        // парсинга одной строки. Выключаем (OpenAI-стиль, bothub): ~6с → ~2-3с.
        reasoning_effort: "none",
      }),
      // Жёсткий потолок вызова. При зависании апстрима abort → throw →
      // orchestrator уходит в degraded-поиск (без LLM), вместо минут ожидания.
      signal: AbortSignal.timeout(LLM_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`llm ${res.status}: ${await res.text()}`);
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
      const out = await complete(PARSE_PROMPT, `Запрос: ${raw}`, FEW_SHOT);
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