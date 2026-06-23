import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { loadConfig } from "../src/config.js";

describe("loadConfig", () => {
  const backup = { ...process.env };
  beforeEach(() => { process.env = { ...backup }; });
  afterEach(() => { process.env = { ...backup }; });

  it("parses valid env into typed Config", () => {
    Object.assign(process.env, {
      BOT_TOKEN: "123:abc",
      ALLOWED_IDS: "111,222",
      ADMIN_IDS: "111",
      LLM_API_KEY: "key",
      LLM_BASE: "https://openai.bothub.chat/v1",
      MODEL: "gpt-4o-mini",
      FLIBUSTA_BASE: "https://flibusta.is",
      RATE_LIMIT_PER_MIN: "20",
    });
    const cfg = loadConfig();
    expect(cfg.botToken).toBe("123:abc");
    expect(cfg.allowedIds).toEqual([111, 222]);
    expect(cfg.adminIds).toEqual([111]);
    expect(cfg.rateLimitPerMin).toBe(20);
  });

  it("throws on missing BOT_TOKEN", () => {
    delete process.env.BOT_TOKEN;
    expect(() => loadConfig()).toThrow();
  });

  it("applies defaults for optional fields", () => {
    Object.assign(process.env, {
      BOT_TOKEN: "t", ALLOWED_IDS: "1", ADMIN_IDS: "1",
      LLM_API_KEY: "k", LLM_BASE: "https://openai.bothub.chat/v1", MODEL: "m", FLIBUSTA_BASE: "https://flibusta.is",
    });
    const cfg = loadConfig();
    expect(cfg.rateLimitPerMin).toBe(20);
    expect(cfg.flibustaFallbackBase).toBeUndefined();
  });
});