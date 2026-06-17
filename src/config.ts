import { z } from "zod";

const csv = (s: string): number[] =>
  s.split(",").map((x) => Number(x.trim())).filter((n) => !Number.isNaN(n));

const Env = z.object({
  BOT_TOKEN: z.string().min(1),
  ALLOWED_IDS: z.string().optional(),
  ADMIN_IDS: z.string().min(1),
  UNLIMITED_IDS: z.string().optional(),
  ZAI_API_KEY: z.string().min(1),
  ZAI_BASE: z.string().url(),
  MODEL: z.string().min(1),
  FLIBUSTA_BASE: z.string().url(),
  FLIBUSTA_FALLBACK_BASE: z.preprocess(
    // env_file читает пустой KEY= как "" — трактуем как «не задано»
    (v) => (v === "" ? undefined : v),
    z.string().url().optional(),
  ),
  FLIBUSTA_PROXY: z.string().optional(),
  RATE_LIMIT_PER_MIN: z.string().optional(),
  LOG_TTL_DAYS: z.string().optional(),
  SEARCH_CACHE_TTL_SEC: z.string().optional(),
  SEARCH_CACHE_MAX: z.string().optional(),
  MAX_QUERY_LEN: z.string().optional(),
  DOWNLOAD_DAILY_LIMIT: z.string().optional(),
  SEARCH_DAILY_LIMIT: z.string().optional(),
});

export type Config = {
  botToken: string;
  allowedIds: number[];
  adminIds: number[];
  zaiApiKey: string;
  zaiBase: string;
  model: string;
  flibustaBase: string;
  flibustaFallbackBase?: string;
  flibustaProxy?: string;
  rateLimitPerMin: number;
  logTtlDays?: number;
  searchCacheTtlSec: number;
  searchCacheMax: number;
  maxQueryLen: number;
  unlimitedIds: number[];
  downloadDailyLimit: number;
  searchDailyLimit: number;
};

export function loadConfig(): Config {
  const e = Env.parse(process.env);
  return {
    botToken: e.BOT_TOKEN,
    allowedIds: e.ALLOWED_IDS ? csv(e.ALLOWED_IDS) : [],
    unlimitedIds: e.UNLIMITED_IDS ? csv(e.UNLIMITED_IDS) : [],
    adminIds: csv(e.ADMIN_IDS),
    zaiApiKey: e.ZAI_API_KEY,
    zaiBase: e.ZAI_BASE,
    model: e.MODEL,
    flibustaBase: e.FLIBUSTA_BASE,
    flibustaFallbackBase: e.FLIBUSTA_FALLBACK_BASE,
    flibustaProxy: e.FLIBUSTA_PROXY,
    rateLimitPerMin: e.RATE_LIMIT_PER_MIN ? Number(e.RATE_LIMIT_PER_MIN) : 20,
    logTtlDays: e.LOG_TTL_DAYS ? Number(e.LOG_TTL_DAYS) : undefined,
    searchCacheTtlSec: e.SEARCH_CACHE_TTL_SEC ? Number(e.SEARCH_CACHE_TTL_SEC) : 21600,
    searchCacheMax: e.SEARCH_CACHE_MAX ? Number(e.SEARCH_CACHE_MAX) : 2000,
    maxQueryLen: e.MAX_QUERY_LEN ? Number(e.MAX_QUERY_LEN) : 100,
    downloadDailyLimit: e.DOWNLOAD_DAILY_LIMIT ? Number(e.DOWNLOAD_DAILY_LIMIT) : 5,
    searchDailyLimit: e.SEARCH_DAILY_LIMIT ? Number(e.SEARCH_DAILY_LIMIT) : 20,
  };
}