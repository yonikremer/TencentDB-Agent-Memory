/**
 * config.test.ts — Unit tests for env-based config loading + helper accessors.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  loadConfig,
  getIngestConcurrency,
  getGlobalLlmConcurrency,
  getWikiRetrievalEnabled,
  getWikiRetrievalTopK,
  getWikiRetrievalMaxChars,
  getWikiRetrievalQueryTerms,
} from "./config.js";

const ENV_KEYS = [
  "KNOWLEDGE_CLICKHOUSE_ENABLED", "KNOWLEDGE_CLICKHOUSE_URL", "KNOWLEDGE_CLICKHOUSE_DATABASE",
  "KNOWLEDGE_CLICKHOUSE_TABLE", "KNOWLEDGE_CLICKHOUSE_USER", "KNOWLEDGE_CLICKHOUSE_PASSWORD",
  "KNOWLEDGE_CLICKHOUSE_FLUSH_INTERVAL_MS", "KNOWLEDGE_CLICKHOUSE_FLUSH_THRESHOLD",
  "KNOWLEDGE_CLICKHOUSE_TTL_DAYS", "KNOWLEDGE_CLICKHOUSE_REQUEST_TIMEOUT_MS",
  "PORT", "KNOWLEDGE_DATA_DIR", "KNOWLEDGE_DB_PATH", "LOG_LEVEL", "API_PREFIX",
  "KNOWLEDGE_PUBLIC_BASE_URL", "TMC_CALLBACK_URL", "LLM_MODE", "LLM_PROTOCOL", "LLM_PROVIDER",
  "LLM_API_KEY", "LLM_MODEL", "LLM_BASE_URL", "LLM_MAX_TOKENS", "LLM_TIMEOUT_MS", "LLM_STREAM",
  "KNOWLEDGE_WIKI_INGEST_CONCURRENCY", "KNOWLEDGE_LLM_GLOBAL_CONCURRENCY",
  "KNOWLEDGE_WIKI_RETRIEVAL_ENABLED", "KNOWLEDGE_WIKI_RETRIEVAL_TOP_K",
  "KNOWLEDGE_WIKI_RETRIEVAL_MAX_CHARS", "KNOWLEDGE_WIKI_RETRIEVAL_QUERY_TERMS",
];

function clearEnv() {
  for (const k of ENV_KEYS) delete process.env[k];
}

// Local .env (dotenv) may export keys — strip before AND after so defaults are asserted.
beforeEach(clearEnv);
afterEach(clearEnv);

describe("loadConfig defaults", () => {
  it("applies defaults when no env set", () => {
    const c = loadConfig();
    expect(c.port).toBe(8421);
    expect(c.dataDir).toBe("./data");
    expect(c.dbPath).toBe("./data/knowledge.db");
    expect(c.logLevel).toBe("debug");
    expect(c.apiPrefix).toBe("/v3");
    expect(c.publicBaseUrl).toBe("");
    expect(c.tmcCallbackUrl).toBe("");
    expect(c.clickhouse.enabled).toBe(false);
    expect(c.clickhouse.url).toBe("");
    expect(c.clickhouse.flushIntervalMs).toBe(5000);
    expect(c.clickhouse.flushThreshold).toBe(50);
    expect(c.clickhouse.ttlDays).toBe(90);
    expect(c.clickhouse.requestTimeoutMs).toBe(5000);
    expect(c.llm.mode).toBe("proxy");
    expect(c.llm.protocol).toBe("openai");
    expect(c.llm.provider).toBe("custom");
    expect(c.llm.model).toBe("Memory-Model");
    expect(c.llm.maxTokens).toBe(32768);
    expect(c.llm.timeoutMs).toBe(1200000);
    expect(c.llm.stream).toBe(false);
  });

  it("reads all env overrides + expands ~/ in paths", () => {
    process.env.PORT = "9999";
    process.env.KNOWLEDGE_DATA_DIR = "~/custom";
    process.env.KNOWLEDGE_DB_PATH = "~/db.sqlite";
    process.env.LOG_LEVEL = "warn";
    process.env.API_PREFIX = "/api";
    process.env.KNOWLEDGE_PUBLIC_BASE_URL = "http://x";
    process.env.TMC_CALLBACK_URL = "http://tmc";
    process.env.LLM_MODE = "custom";
    process.env.LLM_PROTOCOL = "anthropic";
    process.env.LLM_PROVIDER = "bedrock";
    process.env.LLM_API_KEY = "k";
    process.env.LLM_MODEL = "m";
    process.env.LLM_BASE_URL = "http://llm";
    process.env.LLM_MAX_TOKENS = "1000";
    process.env.LLM_TIMEOUT_MS = "5000";
    process.env.LLM_STREAM = "true";
    const c = loadConfig();
    expect(c.port).toBe(9999);
    expect(c.dataDir).toMatch(/custom$/);
    expect(c.dbPath).toMatch(/db\.sqlite$/);
    expect(c.logLevel).toBe("warn");
    expect(c.apiPrefix).toBe("/api");
    expect(c.llm.mode).toBe("custom");
    expect(c.llm.protocol).toBe("anthropic");
    expect(c.llm.provider).toBe("bedrock");
    expect(c.llm.apiKey).toBe("k");
    expect(c.llm.model).toBe("m");
    expect(c.llm.baseUrl).toBe("http://llm");
    expect(c.llm.maxTokens).toBe(1000);
    expect(c.llm.timeoutMs).toBe(5000);
    expect(c.llm.stream).toBe(true);
  });

  it("expandHome keeps non-~/ paths unchanged", () => {
    process.env.KNOWLEDGE_DATA_DIR = "relative/data";
    expect(loadConfig().dataDir).toBe("relative/data");
  });
});

describe("clickhouse config validation", () => {
  it("validates a full enabled config", () => {
    process.env.KNOWLEDGE_CLICKHOUSE_ENABLED = "true";
    process.env.KNOWLEDGE_CLICKHOUSE_URL = "http://ch:8123";
    process.env.KNOWLEDGE_CLICKHOUSE_DATABASE = "db1";
    process.env.KNOWLEDGE_CLICKHOUSE_TABLE = "logs";
    process.env.KNOWLEDGE_CLICKHOUSE_USER = "u";
    process.env.KNOWLEDGE_CLICKHOUSE_PASSWORD = "p";
    process.env.KNOWLEDGE_CLICKHOUSE_FLUSH_INTERVAL_MS = "500";
    process.env.KNOWLEDGE_CLICKHOUSE_FLUSH_THRESHOLD = "10";
    process.env.KNOWLEDGE_CLICKHOUSE_TTL_DAYS = "30";
    process.env.KNOWLEDGE_CLICKHOUSE_REQUEST_TIMEOUT_MS = "1000";
    const c = loadConfig();
    expect(c.clickhouse.enabled).toBe(true);
    expect(c.clickhouse.database).toBe("db1");
  });

  it("throws when enabled but URL missing", () => {
    process.env.KNOWLEDGE_CLICKHOUSE_ENABLED = "true";
    expect(() => loadConfig()).toThrow("KNOWLEDGE_CLICKHOUSE_URL is required");
  });

  it("throws on non-http URL", () => {
    process.env.KNOWLEDGE_CLICKHOUSE_ENABLED = "true";
    process.env.KNOWLEDGE_CLICKHOUSE_URL = "ftp://ch";
    expect(() => loadConfig()).toThrow("must use http or https");
  });

  it("throws on invalid database identifier", () => {
    process.env.KNOWLEDGE_CLICKHOUSE_ENABLED = "true";
    process.env.KNOWLEDGE_CLICKHOUSE_URL = "http://ch:8123";
    process.env.KNOWLEDGE_CLICKHOUSE_DATABASE = "bad-db";
    expect(() => loadConfig()).toThrow("Invalid KNOWLEDGE_CLICKHOUSE_DATABASE");
  });

  it("throws on invalid table identifier", () => {
    process.env.KNOWLEDGE_CLICKHOUSE_ENABLED = "true";
    process.env.KNOWLEDGE_CLICKHOUSE_URL = "http://ch:8123";
    process.env.KNOWLEDGE_CLICKHOUSE_TABLE = "bad table";
    expect(() => loadConfig()).toThrow("Invalid KNOWLEDGE_CLICKHOUSE_TABLE");
  });

  it("throws on flush interval < 100", () => {
    process.env.KNOWLEDGE_CLICKHOUSE_ENABLED = "true";
    process.env.KNOWLEDGE_CLICKHOUSE_URL = "http://ch:8123";
    process.env.KNOWLEDGE_CLICKHOUSE_FLUSH_INTERVAL_MS = "50";
    expect(() => loadConfig()).toThrow("FLUSH_INTERVAL_MS");
  });

  it("throws on flush threshold < 1", () => {
    process.env.KNOWLEDGE_CLICKHOUSE_ENABLED = "true";
    process.env.KNOWLEDGE_CLICKHOUSE_URL = "http://ch:8123";
    process.env.KNOWLEDGE_CLICKHOUSE_FLUSH_THRESHOLD = "0";
    expect(() => loadConfig()).toThrow("FLUSH_THRESHOLD");
  });

  it("throws on negative ttl days", () => {
    process.env.KNOWLEDGE_CLICKHOUSE_ENABLED = "true";
    process.env.KNOWLEDGE_CLICKHOUSE_URL = "http://ch:8123";
    process.env.KNOWLEDGE_CLICKHOUSE_TTL_DAYS = "-1";
    expect(() => loadConfig()).toThrow("TTL_DAYS");
  });

  it("throws on request timeout < 100", () => {
    process.env.KNOWLEDGE_CLICKHOUSE_ENABLED = "true";
    process.env.KNOWLEDGE_CLICKHOUSE_URL = "http://ch:8123";
    process.env.KNOWLEDGE_CLICKHOUSE_REQUEST_TIMEOUT_MS = "10";
    expect(() => loadConfig()).toThrow("REQUEST_TIMEOUT_MS");
  });

  it("envBool recognizes truthy variants", () => {
    process.env.KNOWLEDGE_CLICKHOUSE_URL = "http://ch:8123";
    for (const v of ["1", "true", "yes", "on", "TRUE"]) {
      process.env.KNOWLEDGE_CLICKHOUSE_ENABLED = v;
      expect(loadConfig().clickhouse.enabled).toBe(true);
    }
    process.env.KNOWLEDGE_CLICKHOUSE_ENABLED = "false";
    expect(loadConfig().clickhouse.enabled).toBe(false);
  });
});

describe("concurrency / retrieval helpers", () => {
  it("getIngestConcurrency defaults and clamps 1..10", () => {
    expect(getIngestConcurrency({})).toBe(3);
    expect(getIngestConcurrency({ KNOWLEDGE_WIKI_INGEST_CONCURRENCY: "abc" })).toBe(3);
    expect(getIngestConcurrency({ KNOWLEDGE_WIKI_INGEST_CONCURRENCY: "5" })).toBe(5);
    expect(getIngestConcurrency({ KNOWLEDGE_WIKI_INGEST_CONCURRENCY: "0" })).toBe(1);
    expect(getIngestConcurrency({ KNOWLEDGE_WIKI_INGEST_CONCURRENCY: "99" })).toBe(10);
  });

  it("getGlobalLlmConcurrency defaults and clamps 1..20", () => {
    expect(getGlobalLlmConcurrency({})).toBe(5);
    expect(getGlobalLlmConcurrency({ KNOWLEDGE_LLM_GLOBAL_CONCURRENCY: "x" })).toBe(5);
    expect(getGlobalLlmConcurrency({ KNOWLEDGE_LLM_GLOBAL_CONCURRENCY: "8" })).toBe(8);
    expect(getGlobalLlmConcurrency({ KNOWLEDGE_LLM_GLOBAL_CONCURRENCY: "-3" })).toBe(1);
    expect(getGlobalLlmConcurrency({ KNOWLEDGE_LLM_GLOBAL_CONCURRENCY: "40" })).toBe(20);
  });

  it("getWikiRetrievalEnabled defaults true and parses bools", () => {
    expect(getWikiRetrievalEnabled({})).toBe(true);
    expect(getWikiRetrievalEnabled({ KNOWLEDGE_WIKI_RETRIEVAL_ENABLED: "" })).toBe(true);
    expect(getWikiRetrievalEnabled({ KNOWLEDGE_WIKI_RETRIEVAL_ENABLED: "0" })).toBe(false);
    expect(getWikiRetrievalEnabled({ KNOWLEDGE_WIKI_RETRIEVAL_ENABLED: "on" })).toBe(true);
  });

  it("getWikiRetrievalTopK defaults and clamps 1..10", () => {
    expect(getWikiRetrievalTopK({})).toBe(3);
    expect(getWikiRetrievalTopK({ KNOWLEDGE_WIKI_RETRIEVAL_TOP_K: "q" })).toBe(3);
    expect(getWikiRetrievalTopK({ KNOWLEDGE_WIKI_RETRIEVAL_TOP_K: "7" })).toBe(7);
    expect(getWikiRetrievalTopK({ KNOWLEDGE_WIKI_RETRIEVAL_TOP_K: "0" })).toBe(1);
    expect(getWikiRetrievalTopK({ KNOWLEDGE_WIKI_RETRIEVAL_TOP_K: "50" })).toBe(10);
  });

  it("getWikiRetrievalMaxChars defaults and clamps 1000..60000", () => {
    expect(getWikiRetrievalMaxChars({})).toBe(12000);
    expect(getWikiRetrievalMaxChars({ KNOWLEDGE_WIKI_RETRIEVAL_MAX_CHARS: "bad" })).toBe(12000);
    expect(getWikiRetrievalMaxChars({ KNOWLEDGE_WIKI_RETRIEVAL_MAX_CHARS: "5000" })).toBe(5000);
    expect(getWikiRetrievalMaxChars({ KNOWLEDGE_WIKI_RETRIEVAL_MAX_CHARS: "100" })).toBe(1000);
    expect(getWikiRetrievalMaxChars({ KNOWLEDGE_WIKI_RETRIEVAL_MAX_CHARS: "99999" })).toBe(60000);
  });

  it("getWikiRetrievalQueryTerms defaults and clamps 4..100", () => {
    expect(getWikiRetrievalQueryTerms({})).toBe(24);
    expect(getWikiRetrievalQueryTerms({ KNOWLEDGE_WIKI_RETRIEVAL_QUERY_TERMS: "nope" })).toBe(24);
    expect(getWikiRetrievalQueryTerms({ KNOWLEDGE_WIKI_RETRIEVAL_QUERY_TERMS: "30" })).toBe(30);
    expect(getWikiRetrievalQueryTerms({ KNOWLEDGE_WIKI_RETRIEVAL_QUERY_TERMS: "1" })).toBe(4);
    expect(getWikiRetrievalQueryTerms({ KNOWLEDGE_WIKI_RETRIEVAL_QUERY_TERMS: "500" })).toBe(100);
  });
});
