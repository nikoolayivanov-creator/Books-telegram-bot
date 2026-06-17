import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createLlm } from "../src/search/llm.js";

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
    const llm = createLlm({ zaiBase: "https://api.z.ai", zaiApiKey: "k", model: "glm-4.5-air" });
    const q = await llm.parseQuery("конан дойл шерлок холи");
    expect(q.authors).toEqual(["конан дойл"]);
    expect(q.title).toBe("шерлок");
  });

  it("parseQuery returns empty on malformed LLM output (no throw)", async () => {
    const { f } = mockFetch(["not json at all"]);
    global.fetch = f as any;
    const llm = createLlm({ zaiBase: "https://api.z.ai", zaiApiKey: "k", model: "glm-4.5-air" });
    const q = await llm.parseQuery("мусор");
    expect(q.authors).toBeUndefined();
  });

  it("rankBooks returns top-N in given order from LLM indices", async () => {
    const books = [
      { title: "A", author: "x" }, { title: "B", author: "y" }, { title: "C", author: "z" },
    ] as any;
    const { f } = mockFetch([JSON.stringify({ ranking: [2, 0] })]);
    global.fetch = f as any;
    const llm = createLlm({ zaiBase: "https://api.z.ai", zaiApiKey: "k", model: "glm-4.5-air" });
    const ranked = await llm.rankBooks("query", books, 2);
    expect(ranked.map((b) => b.title)).toEqual(["C", "A"]);
  });
});