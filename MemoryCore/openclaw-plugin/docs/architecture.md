# TencentDB Agent Memory Client — OpenClaw Memory Plugin (Client Version)

> Created: 2026-05-17 | Status: In Development
> Plugin ID: `memory-tencentdb-client`
> Display Name: Memory TencentDB (Client)

## 1. Background

After service refactoring, the four-layer memory data (L0 Conversation / L1 Atomic / L2 Scene / L3 Persona) are fully hosted on a remote Gateway:
- **Data storage**: TCVDB (vectors) + COS (files) + Redis (state)
- **Pipeline**: Gateway Worker automatically performs L1→L2→L3 extraction
- **API**: 15 v2 REST endpoints covering full CRUD + Search

**Original plugin (`memory-tencentdb`)** was a "full‑stack" architecture: local SQLite/VDB + local pipeline + local embedding + OpenClaw hooks + CLI, ~15k lines.

**New plugin (`memory-tencentdb-client`)** is a pure client: it only registers OpenClaw hooks + tools, and all data operations are delegated to the remote Gateway via `@tencentdb-agent-memory/memory-sdk-ts-v2`.

## 2. Three‑Layer Architecture

```
┌───────────────────────────────────────────────────────┐
│  OpenClaw Plugin (memory-tencentdb-client)            │  Framework adaptation layer
│  hooks (recall/capture) + tools + prompt injection    │  Depends only on the SDK, no direct HTTP/storage
│  └─ import { MemoryClient, MemoryFileReader } from SDK│
├───────────────────────────────────────────────────────┤
│  @tencentdb-agent-memory/memory-sdk-ts-v2 (stand‑alone)│  General SDK layer
│  MemoryClient (14 APIs) + MemoryFileReader (STS direct read)│  Zero framework dependencies, pure fetch
│  Future Dify / AutoGen / LangChain integrations will also use this
├───────────────────────────────────────────────────────┤
│  Gateway v2 API                                        │  Remote service
│  VDB + COS + Redis + Pipeline Worker                   │
└───────────────────────────────────────────────────────┘
```

## 3. Plugin Responsibilities (Framework Adaptation Layer Only)

| Feature | Hook/Tool | Implementation |
|--------|-----------|----------------|
| **Conversation Capture** | `agent_end` hook | SDK `client.addConversation()` |
| **Memory Recall** | `before_prompt_build` hook | Parallel: `client.searchAtomic()` + `client.readCore()` + `client.listScenarios()` |
| **Tag Cleanup** | `before_message_write` hook | Strip `<relevant-memories>` tags |
| **L1 Search** | `tdai_memory_search` tool | SDK `client.searchAtomic()` |
| **L0 Search** | `tdai_conversation_search` tool | SDK `client.searchConversation()` |
| **File Read** | `tdai_read_cos` tool | SDK `MemoryFileReader.read()` (STS direct read of object storage) |
| **Prompt Injection** | internal recall | Formatting: Persona + L1 memories + Scene Navigation + Tool guidance |

### Things Not Handled

- ❌ No VectorStore / SQLite / TCVDB launch
- ❌ No EmbeddingService launch
- ❌ No Pipeline / Timer / Worker launch
- ❌ No L1/L2/L3 extraction
- ❌ No COS storage backend management
- ❌ No Redis state management
- ❌ No local checkpointing

## 4. Configuration Options

```jsonc
{
  // Gateway connection
  "gateway.url": "http://127.0.0.1:8420",
  "gateway.apiKey": "",
  "gateway.instanceId": "default",

  // Recall settings
  "recall.maxResults": 5,
  "recall.includePersona": true,
  "recall.includeSceneNav": true,

  // Capture settings
  "capture.enabled": true
}
```

## 5. File Structure

```
memory-tencentdb-client/
├── openclaw.plugin.json       # Plugin manifest
├── package.json               # Dependencies: { "@tencentdb-agent-memory/memory-sdk-ts-v2": "1.0.0-beta.2" }
├── index.ts                   # Entry: initialize SDK + register hooks/tools
├── src/
│   ├── hooks/
│   │   ├── recall.ts          # before_prompt_build → SDK recall → prompt injection
│   │   └── capture.ts         # agent_end → SDK addConversation
│   ├── tools/
│   │   ├── memory-search.ts   # tdai_memory_search → SDK searchAtomic
│   │   ├── conversation-search.ts  # → SDK searchConversation
│   │   └── read-cos.ts        # tdai_read_cos → SDK MemoryFileReader.read
│   └── format.ts              # Recall result formatting + tool guidance injection
├── tests/
│   └── sdk-cos.ts             # Manual test for SDK COS direct read
├── .gitignore
└── README.md
```

## 6. SDK Dependency Strategy

```jsonc
"dependencies": {
  "@tencentdb-agent-memory/memory-sdk-ts-v2": "1.0.0-beta.2"
}
```

The SDK is published to the npm registry: [`@tencentdb-agent-memory/memory-sdk-ts-v2@1.0.0-beta.2`](https://www.npmjs.com/package/@tencentdb-agent-memory/memory-sdk-ts-v2/v/1.0.0-beta.2) and is pulled automatically via `npm install`. It remains an independent package with no framework lock‑in, allowing reuse in Dify plugins, Python versions, etc.

## 7. `read_cos` Tool Design

### COS Direct Read (STS)
- The SDK’s `MemoryFileReader` obtains STS temporary credentials via the Gateway `/v2/cos/secret` endpoint.
- Credentials are cached and refreshed 2 minutes before expiration.
- Objects are fetched directly from COS (V5 signature) without routing through the Gateway.

### How the AI Knows to Call `read_cos`
1. **Scene Navigation at the end of a Persona**:
   ```
   ## 🗺️ Scene Navigation
   ### Path: scene_blocks/CareerDevelopmentAndTechPractice.md
   **Heat**: 3 | Summary: Backend engineer, Go + TypeScript...
   ```
   The AI sees the path and proactively calls `tdai_read_cos` for details.
2. **Tool Guidance (in `format.ts` injection)**:
   ```
   <memory-tools-guide>
   - tdai_memory_search: search structured memories
   - tdai_conversation_search: search raw conversations
   - tdai_read_cos: read scene files (using paths from Scene Navigation)
   </memory-tools-guide>
   ```
3. **Tool Description**:
   ```
   "Read a file from cloud storage. Use paths from Scene Navigation (e.g. 'scene_blocks/xxx.md') or 'persona.md'."
   ```

## 8. Key Design Decisions

### Q1: How is `session_id` determined?
The plugin uses the `ctx.sessionKey` provided by the OpenClaw framework (available in hook context), matching the behavior of the original plugin. No custom generation or concatenation is needed.

### Q2: Offline / Disconnection Degradation?
The first version does nothing – if the Gateway is unreachable, hooks return empty (no memory injection), and capture failures emit a warning. Future versions may add local fallback.

### Q3: Conflict with the Original Plugin?
Plugin IDs differ (`memory-tencentdb-client` vs `memory-tencentdb`), so they do not clash. Enabling both would duplicate capture and injection, so only one should be active.

## 9. Implementation Steps

| # | Task | Estimate |
|---|------|----------|
| 1 | `package.json` + `openclaw.plugin.json` + `.gitignore` + `README.md` | 15 min |
| 2 | `index.ts` – initialize SDK Client/MemoryFileReader + register hooks/tools | 30 min |
| 3 | `hooks/capture.ts` – `agent_end` → `addConversation` | 20 min |
| 4 | `hooks/recall.ts` + `format.ts` – parallel recall + prompt formatting | 45 min |
| 5 | `tools/*.ts` – three tool wrappers forwarding to SDK | 30 min |
| 6 | SDK test script (`tests/sdk-cos.ts`) | 15 min |
| 7 | Local integration testing | 30 min |

**Total**: ~3 hours
