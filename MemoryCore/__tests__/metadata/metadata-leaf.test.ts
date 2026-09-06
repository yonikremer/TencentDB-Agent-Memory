/**
 * Metadata leaf utilities: crypto, id generators, user-key, asset ids,
 * pagination, system-user, param registry, constants.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  generateUserKey,
  generatePassword,
  loadPasswordHashConfig,
  hashPassword,
  isPasswordHash,
  verifyPasswordHash,
  PASSWORD_HASH_PREFIX,
} from "../../src/metadata/utils/crypto.js";
import {
  generateId,
  generateRelationId,
  isValidId,
  ID_PREFIX,
} from "../../src/metadata/utils/id-generator.js";
import {
  maskKeyValue,
  maskUserKey,
  isUserKeyExpired,
  USER_KEY_PREFIX,
  DEFAULT_MAX_ACTIVE_USER_KEYS,
} from "../../src/metadata/utils/user-key.js";
import {
  buildChatMemoryAssetId,
  resolveChatMemoryAgentId,
  CHAT_MEMORY_ASSET_PREFIX,
} from "../../src/metadata/utils/chat-memory-asset.js";
import { newExternalAssetId } from "../../src/metadata/utils/external-asset-id.js";
import {
  resolvePagination,
  toPaginationParams,
  wrapPaginated,
  isPaginatedResult,
  unwrapListItems,
  formatListResult,
  paginateArray,
  DEFAULT_PAGINATION,
  paginationInputSchema,
} from "../../src/metadata/pagination.js";
import { DEFAULT_INSTANCE_ID, DEFAULT_AUTH_PROVIDER } from "../../src/metadata/constants.js";
import {
  isValidMemorySystemUserKey,
  resolveMemorySystemUserConfig,
  validateMemorySystemUserConfig,
  MEMORY_SYSTEM_USER_ID_PREFIX,
} from "../../src/metadata/system-user.js";
import { MetadataStartupValidationError } from "../../src/metadata/store/factory.js";
import {
  loadParamRegistry,
  buildRegistry,
  getModuleDef,
  getParamDef,
  isUserWritable,
  isGlobalOnly,
  isModuleGlobalOnly,
  loadDefaultRegistry,
  ParamRegistryError,
} from "../../src/metadata/config/param-registry.js";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("crypto", () => {
  it("generateUserKey has prefix + base64url body", () => {
    const key = generateUserKey();
    expect(key.startsWith(USER_KEY_PREFIX)).toBe(true);
    expect(key).toHaveLength(USER_KEY_PREFIX.length + 32);
  });
  it("generatePassword charset + custom length", () => {
    const p = generatePassword(20);
    expect(p).toHaveLength(20);
    expect(p).toMatch(/^[A-Za-z0-9_]+$/);
    expect(generatePassword()).toHaveLength(12);
  });
  it("loadPasswordHashConfig throws without pepper", () => {
    expect(() => loadPasswordHashConfig({})).toThrow("TDAI_PASSWORD_PEPPER is not configured");
  });
  it("loadPasswordHashConfig throws on bad pepper length", () => {
    expect(() => loadPasswordHashConfig({ TDAI_PASSWORD_PEPPER: Buffer.alloc(8).toString("base64") })).toThrow(
      "must decode to 32 bytes",
    );
  });
  it("loadPasswordHashConfig parses params + defaults", () => {
    const cfg = loadPasswordHashConfig({
      TDAI_PASSWORD_PEPPER: Buffer.alloc(32, 1).toString("base64"),
      TDAI_PASSWORD_SCRYPT_N: "32768",
    });
    expect(cfg.scryptN).toBe(32768);
    expect(cfg.scryptR).toBe(8);
    expect(cfg.scryptP).toBe(1);
    expect(cfg.keylen).toBe(32);
    expect(cfg.pepper).toHaveLength(32);
  });
  it("loadPasswordHashConfig throws on invalid scrypt param", () => {
    expect(() =>
      loadPasswordHashConfig({
        TDAI_PASSWORD_PEPPER: Buffer.alloc(32).toString("base64"),
        TDAI_PASSWORD_SCRYPT_N: "-1",
      }),
    ).toThrow("Invalid scrypt parameter");
  });
  it("hashPassword + verifyPasswordHash roundtrip", () => {
    const cfg = loadPasswordHashConfig({ TDAI_PASSWORD_PEPPER: Buffer.alloc(32, 7).toString("base64") });
    const stored = hashPassword("hunter2", cfg);
    expect(isPasswordHash(stored)).toBe(true);
    expect(stored.startsWith(PASSWORD_HASH_PREFIX)).toBe(true);
    expect(verifyPasswordHash("hunter2", stored, cfg)).toBe(true);
    expect(verifyPasswordHash("wrong", stored, cfg)).toBe(false);
  });
  it("verifyPasswordHash rejects non-hash / malformed", () => {
    const cfg = loadPasswordHashConfig({ TDAI_PASSWORD_PEPPER: Buffer.alloc(32).toString("base64") });
    expect(verifyPasswordHash("x", "plain", cfg)).toBe(false);
    expect(verifyPasswordHash("x", PASSWORD_HASH_PREFIX + "no-dollar", cfg)).toBe(false);
    expect(verifyPasswordHash("x", PASSWORD_HASH_PREFIX + "1,2,3,4$aa$bb", cfg)).toBe(false);
    expect(verifyPasswordHash("x", PASSWORD_HASH_PREFIX + "1,2,3$aa", cfg)).toBe(false);
  });
});

describe("id-generator", () => {
  it("generateId shape", () => {
    const id = generateId(ID_PREFIX.user);
    expect(id).toMatch(/^usr-[a-z0-9]{10}$/);
  });
  it("generateRelationId uuid", () => {
    expect(generateRelationId()).toMatch(/^[0-9a-f-]{36}$/);
  });
  it("isValidId", () => {
    expect(isValidId("", undefined)).toBe(false);
    expect(isValidId("abc", undefined)).toBe(true);
    expect(isValidId("usr-x", "usr")).toBe(true);
    expect(isValidId("team-x", "usr")).toBe(false);
    expect(isValidId(null as unknown as string, undefined)).toBe(false);
  });
});

describe("user-key", () => {
  it("maskKeyValue", () => {
    expect(maskKeyValue("")).toBe("");
    expect(maskKeyValue("abcd")).toBe("abcd…");
    expect(maskKeyValue("abcdefgh").startsWith("abcdefgh…")).toBe(true);
    expect(maskKeyValue("0123456789abcdef")).toBe("01234567…");
  });
  it("maskUserKey", () => {
    expect(maskUserKey("")).toBe("");
    expect(maskUserKey("sk-mem-abcdefgh1234567890WXYZ")).toBe("sk-mem-****WXYZ");
    expect(maskUserKey("sk-mem-xyz")).toBe("sk-mem-****xyz");
    expect(maskUserKey("plain")).toBe("****lain");
  });
  it("isUserKeyExpired", () => {
    const now = Date.now();
    expect(isUserKeyExpired(null, now)).toBe(false);
    expect(isUserKeyExpired(undefined, now)).toBe(false);
    expect(isUserKeyExpired(new Date(now - 1000).toISOString(), now)).toBe(true);
    expect(isUserKeyExpired(new Date(now + 5000).toISOString(), now)).toBe(false);
    expect(isUserKeyExpired("not-a-date", now)).toBe(false);
  });
  it("constants", () => {
    expect(DEFAULT_MAX_ACTIVE_USER_KEYS).toBe(20);
  });
});

describe("chat-memory-asset", () => {
  it("buildChatMemoryAssetId + resolveChatMemoryAgentId", () => {
    expect(buildChatMemoryAssetId("t1", "a1")).toBe(`${CHAT_MEMORY_ASSET_PREFIX}t1-a1`);
    const id = buildChatMemoryAssetId("team-a-b", "agt-c-d");
    expect(resolveChatMemoryAgentId(id, "team-a-b", ["agt-z", "agt-c-d"])).toBe("agt-c-d");
    expect(resolveChatMemoryAgentId(id, "other", ["agt-c-d"])).toBeUndefined();
    expect(resolveChatMemoryAgentId("nope", "team-a-b", ["agt-c-d"])).toBeUndefined();
    expect(resolveChatMemoryAgentId(id, "team-a-b", new Set(["agt-c-d"]))).toBe("agt-c-d");
  });
});

describe("external-asset-id", () => {
  it("newExternalAssetId prefixes", () => {
    for (const t of ["skill", "llm_wiki", "code_graph", "chat_memory"] as const) {
      const id = newExternalAssetId(t);
      const prefix = t === "skill" ? "skl" : t === "llm_wiki" ? "wiki" : t === "code_graph" ? "cg" : "mem";
      expect(id.startsWith(`${prefix}-`)).toBe(true);
    }
  });
});

describe("pagination", () => {
  it("resolvePagination defaults + coercion", () => {
    expect(resolvePagination(undefined)).toEqual({ limit: 20, offset: 0 });
    expect(resolvePagination({ limit: 5, offset: 3 })).toEqual({ limit: 5, offset: 3 });
    expect(resolvePagination({ limit: "30" as unknown as number, offset: "2" as unknown as number })).toEqual({
      limit: 30,
      offset: 2,
    });
    expect(() => resolvePagination({ limit: 1000 })).toThrow();
    expect(toPaginationParams({ limit: 7 })).toEqual({ limit: 7, offset: 0 });
  });
  it("wrapPaginated + formatListResult + paginateArray", () => {
    const params = { limit: 2, offset: 1 };
    const wrapped = wrapPaginated(["a", "b"], 2, params);
    expect(wrapped).toEqual({ items: ["a", "b"], total: 2, limit: 2, offset: 1 });
    expect(formatListResult({ items: ["x"], total: 9 }, params).total).toBe(9);
    const page = paginateArray([1, 2, 3, 4], { limit: 2, offset: 1 });
    expect(page.items).toEqual([2, 3]);
    expect(page.total).toBe(4);
    const empty = paginateArray([], { limit: 2, offset: 0 });
    expect(empty.items).toEqual([]);
  });
  it("isPaginatedResult + unwrapListItems", () => {
    expect(isPaginatedResult({ items: [], total: 0 })).toBe(true);
    expect(isPaginatedResult(null)).toBe(false);
    expect(isPaginatedResult([1])).toBe(false);
    expect(isPaginatedResult({})).toBe(false);
    expect(isPaginatedResult({ items: "no", total: 0 })).toBe(false);
    expect(isPaginatedResult({ items: [], total: 0, limit: 5 })).toBe(true);
    expect(unwrapListItems([1, 2])).toEqual([1, 2]);
    expect(unwrapListItems({ items: [3], total: 1 })).toEqual([3]);
  });
  it("schema constants", () => {
    expect(DEFAULT_PAGINATION).toEqual({ limit: 20, offset: 0 });
    expect(paginationInputSchema.parse({ limit: "10" }).limit).toBe(10);
  });
});

describe("system-user", () => {
  it("isValidMemorySystemUserKey", () => {
    expect(isValidMemorySystemUserKey("sk-mem-" + "A".repeat(32))).toBe(true);
    expect(isValidMemorySystemUserKey("sk-mem-" + "A".repeat(31))).toBe(false);
    expect(isValidMemorySystemUserKey("bad")).toBe(false);
  });
  it("resolveMemorySystemUserConfig from yaml", () => {
    const cfg = resolveMemorySystemUserConfig({
      systemUser: {
        memory: { userId: "usr-sys-1", displayName: "Memory", userKey: "sk-mem-" + "B".repeat(32) },
      },
    } as never);
    expect(cfg?.userId).toBe("usr-sys-1");
    expect(cfg?.displayName).toBe("Memory");
  });
  it("resolveMemorySystemUserConfig env overrides yaml", () => {
    vi.stubEnv("TDAI_MEMORY_SYSTEM_USER_ID", "usr-sys-env");
    vi.stubEnv("TDAI_MEMORY_SYSTEM_USER_NAME", "EnvName");
    vi.stubEnv("TDAI_MEMORY_SYSTEM_USER_KEY", "sk-mem-" + "C".repeat(32));
    const cfg = resolveMemorySystemUserConfig({} as never);
    expect(cfg?.userId).toBe("usr-sys-env");
    expect(cfg?.displayName).toBe("EnvName");
  });
  it("resolveMemorySystemUserConfig incomplete returns undefined", () => {
    expect(resolveMemorySystemUserConfig({} as never)).toBeUndefined();
    expect(
      resolveMemorySystemUserConfig({
        systemUser: { memory: { userId: "usr-sys-1", displayName: "M" } },
      } as never),
    ).toBeUndefined();
    expect(
      resolveMemorySystemUserConfig({
        systemUser: { memory: { userKey: "sk-mem-" + "D".repeat(32) } },
      } as never),
    ).toBeUndefined();
  });
  it("validateMemorySystemUserConfig standalone mode skips", () => {
    expect(() => validateMemorySystemUserConfig("standalone", undefined)).not.toThrow();
  });
  it("validateMemorySystemUserConfig service mode throws", () => {
    expect(() => validateMemorySystemUserConfig("service", undefined)).toThrow(MetadataStartupValidationError);
    expect(() =>
      validateMemorySystemUserConfig("service", {
        userId: "bad",
        displayName: "",
        userKey: "bad",
      }),
    ).toThrow(MetadataStartupValidationError);
    // valid config passes
    expect(() =>
      validateMemorySystemUserConfig("service", {
        userId: `${MEMORY_SYSTEM_USER_ID_PREFIX}0`,
        displayName: " Memory ",
        userKey: "sk-mem-" + "E".repeat(32),
      }),
    ).not.toThrow();
    expect(() =>
      validateMemorySystemUserConfig("service", {
        userId: "usr-sys-1",
        displayName: "M",
        userKey: "sk-mem-" + "F".repeat(32),
      }),
    ).not.toThrow();
  });
});

describe("constants", () => {
  it("defaults", () => {
    expect(DEFAULT_INSTANCE_ID).toBe("default");
    expect(DEFAULT_AUTH_PROVIDER).toBe("local");
  });
});

describe("param-registry", () => {
  const validFile: unknown = {
    version: "1",
    modules: [
      {
        module: "memory",
        description: "memory module",
        params: [
          { param_name: "a.b", param_value: "1", description: "d", allowed_scopes: ["global", "user"] },
          { param_name: "c", param_value: "2", description: "d", allowed_scopes: ["global"] },
        ],
      },
    ],
  };
  it("buildRegistry roundtrip", () => {
    const reg = buildRegistry(validFile as never);
    expect(reg.size).toBe(1);
    expect(getModuleDef(reg, "memory")?.description).toBe("memory module");
    expect(getModuleDef(reg, "nope")).toBeUndefined();
    expect(getParamDef(reg, "memory", "a.b")?.param_value).toBe("1");
    expect(getParamDef(reg, "nope", "a")).toBeUndefined();
    expect(getParamDef(reg, "memory", "zzz")).toBeUndefined();
    expect(isUserWritable(reg, "memory", "a.b")).toBe(true);
    expect(isUserWritable(reg, "memory", "c")).toBe(false);
    expect(isUserWritable(reg, "memory", "zzz")).toBe(false);
    expect(isGlobalOnly(reg, "memory", "c")).toBe(true);
    expect(isGlobalOnly(reg, "memory", "a.b")).toBe(false);
    expect(isGlobalOnly(reg, "memory", "zzz")).toBe(false);
    expect(isModuleGlobalOnly(reg, "memory")).toBe(false);
    expect(isModuleGlobalOnly(reg, "nope")).toBe(false);
  });
  it("buildRegistry validation errors", () => {
    expect(() => buildRegistry({} as never)).toThrow(ParamRegistryError);
    expect(() => buildRegistry({ version: "1", modules: [{ module: "", description: "d", params: [] }] } as never)).toThrow(ParamRegistryError);
    expect(() => buildRegistry({ version: "1", modules: [{ module: "Bad-Name", description: "d", params: [{ param_name: "x", param_value: "1", description: "d", allowed_scopes: ["global"] }] }] } as never)).toThrow(ParamRegistryError);
    expect(() => buildRegistry({ version: "1", modules: [{ module: "m", description: "d", params: [] }] } as never)).toThrow(ParamRegistryError);
    expect(() =>
      buildRegistry({
        version: "1",
        modules: [
          { module: "m", description: "d", params: [{ param_name: "x", param_value: "1", description: "d", allowed_scopes: ["global"] }] },
          { module: "m", description: "d", params: [{ param_name: "y", param_value: "1", description: "d", allowed_scopes: ["global"] }] },
        ],
      } as never),
    ).toThrow(ParamRegistryError);
    expect(() =>
      buildRegistry({
        version: "1",
        modules: [{ module: "m", params: [{ param_name: "x", param_value: "1", description: "d", allowed_scopes: ["global"] }] }],
      } as never),
    ).toThrow(ParamRegistryError);
    expect(() =>
      buildRegistry({
        version: "1",
        modules: [{ module: "m", description: "d", params: [{ param_value: "1", description: "d", allowed_scopes: ["global"] }] }],
      } as never),
    ).toThrow(ParamRegistryError);
    expect(() =>
      buildRegistry({
        version: "1",
        modules: [{ module: "m", description: "d", params: [{ param_name: "Space Name", param_value: "1", description: "d", allowed_scopes: ["global"] }] }],
      } as never),
    ).toThrow(ParamRegistryError);
  });
  it("loadParamRegistry read failure + invalid json", () => {
    const dir = mkdtempSync(join(tmpdir(), "paramreg-"));
    expect(() => loadParamRegistry(join(dir, "missing.json"))).toThrow(ParamRegistryError);
    const badJson = join(dir, "bad.json");
    writeFileSync(badJson, "{not json");
    expect(() => loadParamRegistry(badJson)).toThrow(ParamRegistryError);
  });
  it("loadParamRegistry valid json + loadDefaultRegistry", () => {
    const dir = mkdtempSync(join(tmpdir(), "paramreg-"));
    const fp = join(dir, "ok.json");
    writeFileSync(fp, JSON.stringify(validFile));
    const reg = loadParamRegistry(fp);
    expect(reg.has("memory")).toBe(true);
    const def = loadDefaultRegistry();
    expect(def.size).toBeGreaterThan(0);
  });
});