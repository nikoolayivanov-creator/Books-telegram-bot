import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createLlm, PARSE_PROMPT, FEW_SHOT } from "../src/search/llm.js";

function mockFetch(responses: string[]) {
  const calls: any[] = [];
  let i = 0;
  const f = vi.fn(async (url: any, init: any) => {
    calls.push({ url: String(url), body: init?.body });
    const content = responses[i++] ?? "";
    return new Response(JSON.stringify({
      choices: [{ message: { content } }],
    }), { status: 200, headers: { "content-type": "application/json" } });
  });
  return { f, calls };
}

describe("llm", () => {
  const orig = global.fetch;
  afterEach(() => { global.fetch = orig; });

  it("parseQuery extracts structured fields from JSON", async () => {
    const { f } = mockFetch([JSON.stringify({ authors: ["конан дойл"], title: "шерлок" })]);
    global.fetch = f as any;
    const llm = createLlm({ llmBase: "https://openai.bothub.chat/v1", llmApiKey: "k", model: "gpt-4o-mini" });
    const q = await llm.parseQuery("конан дойл шерлок холи");
    expect(q.authors).toEqual(["конан дойл"]);
    expect(q.title).toBe("шерлок");
  });

  it("parseQuery returns empty on malformed LLM output (no throw)", async () => {
    const { f } = mockFetch(["not json at all"]);
    global.fetch = f as any;
    const llm = createLlm({ llmBase: "https://openai.bothub.chat/v1", llmApiKey: "k", model: "gpt-4o-mini" });
    const q = await llm.parseQuery("мусор");
    expect(q.authors).toBeUndefined();
  });

  it("rankBooks returns top-N in given order from LLM indices", async () => {
    const books = [
      { title: "A", author: "x" }, { title: "B", author: "y" }, { title: "C", author: "z" },
    ] as any;
    const { f } = mockFetch([JSON.stringify({ ranking: [2, 0] })]);
    global.fetch = f as any;
    const llm = createLlm({ llmBase: "https://openai.bothub.chat/v1", llmApiKey: "k", model: "gpt-4o-mini" });
    const ranked = await llm.rankBooks("query", books, 2);
    expect(ranked.map((b) => b.title)).toEqual(["C", "A"]);
  });

  it("PARSE_PROMPT просит нормализовать опечатки в названии", () => {
    expect(PARSE_PROMPT.toLowerCase()).toContain("назван");
  });

  it("FEW_SHOT непуст и содержит пример с серией", () => {
    expect(FEW_SHOT.length).toBeGreaterThan(0);
    const hasSeries = FEW_SHOT.some((ex) => ex.assistant.includes('"series"'));
    expect(hasSeries).toBe(true);
  });

  it("parseQuery шлёт few-shot turn-ы в теле запроса", async () => {
    const { f, calls } = mockFetch([JSON.stringify({ title: "x" })]);
    global.fetch = f as any;
    const llm = createLlm({ llmBase: "https://openai.bothub.chat/v1", llmApiKey: "k", model: "gpt-4o-mini" });
    await llm.parseQuery("какой-то запрос");
    const body = JSON.parse(calls[0].body);
    const userMsgs = body.messages.filter((m: any) => m.role === "user").map((m: any) => m.content);
    // есть example-юзер из few-shot (не только финальный запрос)
    expect(userMsgs.some((c: string) => c.includes("пелевин") || c.includes("мартин"))).toBe(true);
    // финальный запрос тоже на месте
    expect(userMsgs.some((c: string) => c.includes("какой-то запрос"))).toBe(true);
  });
});