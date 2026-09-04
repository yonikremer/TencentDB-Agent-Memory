/**
 * @tencentdb-agent-memory/memory-sdk-ts-v2 — TypeScript SDK for TencentDB Agent Memory v3 API.
 *
 * Top-level exports come directly from the v3 strict isolation version. If older code
 * previously imported from the `@tencentdb-agent-memory/memory-sdk-ts-v2/v3` subpath, it can still be used (the subpath
 * is preserved as a backwards compatible alias, identical to this module).
 */

export * from "./v3/index.js";

// Raw data-shape types for HTTP contracts — the v3 client returns these shapes (
// has a set of `V3*` aliases in v3/types.ts, both names are usable).
export type {
  // Common
  ApiResponseEnvelope, CountData,
  // L0
  ConversationItem, ConversationAddData, ConversationQueryData,
  ConversationSearchData, ConversationSearchHit, ConversationDeleteData,
  // L1
  AtomicDetail, AtomicUpdateData, AtomicQueryData,
  AtomicSearchData, AtomicSearchHit, AtomicDeleteData,
  // L2
  ScenarioEntry, ScenarioListData, ScenarioFile, ScenarioWriteData,
  // L3
  CoreFile, CoreWriteData,
  // Offload
  OffloadToolPair, OffloadRecentMessage,
  OffloadIngestRequest, OffloadIngestData,
  OffloadCompactRequest, OffloadCompactData, OffloadCompactReport,
  OffloadQueryMmdRequest, OffloadQueryMmdData,
} from "./types.js";

// Shared types / utils (not v3-only, nor v2 API implementation, exported for callers that need custom transport
// or direct STS COS reads)
export { ParamError, TDAMError } from "./errors.js";
export { HttpTransport, type HttpTransportOptions } from "./http.js";
export type { MemoryClientConfig, Transport } from "./client.js";
export {
  MemoryFileReader,
  StsCredentialManager,
  StsCredential,
  createMemoryFileReader,
  cosV5Sign,
  type MemoryFileReaderConfig,
} from "./cos.js";
