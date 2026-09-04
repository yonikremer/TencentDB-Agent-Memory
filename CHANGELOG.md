# Changelog

This file records significant changes to **TencentDB Agent Memory**, following the format of
[Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/), and the version number follows
[Semantic Versioning](https://semver.org/)。

Cover all open-source modules in the repository: `MemoryCore` / `MemoryPanel` / `MemoryKnowledge` /
`MemoryProxy` / SDK。

---

## [2.0.1] — 2026-08-25

### 🚀 Support more Agent clients

Now, regardless of which coding agent you use, you can directly attach team memory:

- Add **OpenCode** client integration
- Add **DeepSeek Harness (dsh)** integration —— the official agent harness of DeepSeek
  Web UI sessions can be directly connected to Proxy, automatically gaining team memory / skill / knowledge injection
- Add **Codex CLI** integration
- Add **WorkBuddy** client integration, ready to use out of the box
- Consistent first-time onboarding and reset experience across multiple clients, with smoother switching

### 🤖 Directly give instructions within the session

No need to switch to the panel, common operations can be completed in the conversation:

- One-click reset of bindings mid-session (switch team / switch Agent / switch task)
- Directly create / update tasks within the conversation
- Faster instruction responses, reducing waiting time

### 🧠 Cold Start Out of the Box

- Creating a team or user automatically generates a default Agent, requiring no manual configuration
- Administrators can customize default Agent templates, which are automatically applied during new user cold start
- Supports one-click import of existing Agents from IDEs for quick setup
- After integration, it is automatically bound to tasks, enabling immediate use

### 🔄 Session Binding is More Stable

- Session binding is persistently saved, so it is not lost after restart
- After switching the Agent, memory and skills correctly follow the switch, no longer cross-contaminated
- Fixes the issue where some client historical playback is incorrectly judged

### 🧰 Skill Experience Upgrade

- Skills created in the session are immediately searchable, with no more "search blind spots"
- Restore display and one-click copy of skill IDs
- Skills support online editing
- Add a guided skill for integration: configure step by step following the guide, or complete Proxy integration automatically with a single command

### 🎛️ Memory Hub Panel

- Brand new login page with dot matrix ripple animation
- Team edit / delete entries integrated into the team switcher, making operations more convenient and fixing switch anomalies
- Administrators can customize User_Key when creating accounts
- New conversation memory search: cross-session semantic and keyword retrieval with precise visibility control based on permissions;
  Support direct overwrite modification of single-layer memory
- Asset ID displayed directly and can be copied; list fully loaded, fixing the issue of incomplete display due to pagination truncation

### ⚙️ One-Click Deployment Enhancement

- The startup script supports interactive configuration, automatically pre-checks the LLM pathway and port occupancy, avoiding deployment pitfalls
- The client access address is one-click copied, automatically resolves to the host machine address for standalone deployment, allowing external clients to connect directly

### ⚡ Performance Optimization

- Knowledge base list loading speed improved, commonly used paths respond faster
- Wiki page concurrent construction, single page failure auto-retry, large batch document import time significantly shortened

### 📚 Document

- Create independent access documents split by client, with each agent having a clear access guide
- Add new panel and API usage documentation
- Supplement English panel screenshots and update README

### 🐛 Fix

- Fix the issue where memory retrieval is empty in multi-Agent scenarios
- Fix the issue where asset unbinding does not take effect and the memory tab is lost when there are many assets
- Fix the issue where imported historical session times are disordered, and restore the original timeline
- Fix the issue where some content is repeatedly expanded in the editing scenario
- Fix compatibility issues with the deployment script on macOS
- Fix installation errors caused by missing dependencies
- Fix compatibility issues with the first-time onboarding form of some clients on older versions
- Add a function to clear conversation memory, supporting batch deletion

---

## [2.0.1-beta.1] — 2026-08-13

### 🧠 Cold Start Out of the Box · Default Agent + Preloaded Skills

- Creating a team/user automatically generates a default Agent, no manual configuration required
- Client access address is one-click copy, supports pointing to Memory Proxy
- In standalone deployment, the access address is automatically resolved to the host machine address, allowing external clients to connect directly

### ⚡ Wiki Generation Acceleration

- Optimize Wiki generation, concurrent page building, significantly shorten the time for bulk document import
- Auto-retry for single page failures, no longer stalling the entire batch
- Real-time visibility of generation progress and single page status

### 🧰 Skill Ecosystem

- Add Skill export functionality
- Optimize Skill retrieval, so that private Skills can be retrieved, with more accurate results
- Optimize Skill extraction capability, with a broader capture range

### 🔀 Memory Proxy · New Client Integration

- Add Codex CLI integration
- Add WorkBuddy client integration
- Add DeepSeek Harness (dsh) integration —— Web UI session of DeepSeek's official agent harness
  Can be directly integrated with Proxy to obtain team memory / skill / knowledge injection; supports aux request short-circuiting
  (compaction / title-gen) and CLI headless bypass
- Optimize the association between code-graph resources and workspaces

### 🎛️ Memory Hub Panel

- Refactor the first-time onboarding flow, adding an Agent binding step
- Optimize panel interaction, loading skeleton screens, and transition animations
- Optimize Task page user display name resolution
- Optimize asset page layout and ownership/shared rule descriptions
- Fix the issue where the memory tab is lost when there are many assets

### 🐛 Fix

- Fix the issue where memory retrieval is empty in multi-agent scenarios
- Fix the issue where asset unbinding does not take effect
- Historical conversations imported are retained with their original time, and the timeline is no longer disordered
- Fix the issue where memory is lost in certain scenarios
- Add a function to clear conversation memory, supporting batch deletion

---

## [2.0.0] — 2026-08-03

> **Product Positioning**: Turn Agent experience, documentation, and code into reusable assets, enabling the next Agent
> Load the save directly. See [README_CN.md](./README_CN.md).

### 🧠 Four Memory Assets · First Complete Open Source

Four types of assets are automatically accumulated from "conversation/work traces":

- **Chat Memory** — Extract L0 raw records from the conversation layer by layer → L1 facts → L2 scenarios → L3
  Long-term cognition; preserve preferences, decisions, and interaction history across sessions.
- **Skill** — Extract reusable SOPs from tasks that work, with version / resource files / trigger boundaries /
  Execute steps / verify rules. Add Skill mandatory archiving feature.
- **Wiki** — Turn documents into structured pages + a link graph (inspired by Karpathy's LLM knowledge base
  (Practice).
- **CodeGraph** — Indexes the repository's symbols / files / call relationships / impact paths for Agent code changes
  First, perform an impact analysis. Add a scheduled automatic code repository synchronization feature.

### 🎛️ Memory Hub · Team-oriented Console

Control Panel (`agentmemory/memory-hub` image, including Panel + Knowledge Service):

- Create Team / Agent, and uniformly manage assets by Owner / Version / Status / Visibility
- Three-level visibility: `private` / `team` / `restricted` (User / Role / Agent ACL),
  plus `agent` targeted assembly
- Agent Loadout: bind different assets to different Agents, adjust priority and usage
- Wiki + CodeGraph workshop is built-in in Hub, and can automatically build by importing code repositories/documents
- System Admin can now also use the asset management feature
- The panel fully supports Chinese-English switching; unifies the page design style, optimizes list interactions and pagination experience

### 🔀 Memory Proxy · Channel for Agents to Mount Memory

`agentmemory/memory-proxy` enables coding agents like Claude Code to directly use team memory:

- **Anthropic / OpenAI Dual Protocols**: `/claude-code/<spaceId>/v1/messages` and
  `/v1/chat/completions` both connect to
- **Initial Guidance**: sessionInit uses `AskUserQuestion` to let users select team / agent /
  task, and the proxy remembers the binding
- **Per-Round Injection**: the agent's L2/L3 memory, matched skill, wiki/code-graph
  are appended into the system prompt, and the upstream LLM is forwarded
- **Authentication**: `x-tdai-user-key` → kernel `/v3/meta/auth/verify` replaces with `user_id`,
  controlling asset visibility by user dimension
- Cost Guard supports configuring different models for different Agents to reduce costs

### 🚀 Start the complete three-piece set with a single command

Three multi-architecture images (`linux/amd64` + `linux/arm64`) have been published to
[Docker Hub `agentmemory`](https://hub.docker.com/u/agentmemory), publicly pullable,
no login required:

```bash
git clone https://github.com/Tencent/TencentDB-Agent-Memory.git
cd TencentDB-Agent-Memory/deploy/global-images
cp .env.example .env && $EDITOR .env    # Enter two sets of LLM parameters
./start-all.sh                          # Start all with one click
```

`start-all.sh` automatically `init-admin`, generates admin `sk-mem-...` and persists to disk on first launch
`.admin-key`; self-check `/v3/meta/auth/verify` and print the copyable `claude` startup command.
`stop-all.sh --purge` completely purges the volume + admin key, making it easy to reset.

See [INSTALL_CN.md](./INSTALL_CN.md) / [INSTALL.md](./INSTALL.md).

### 🧰 Official SDK

- **TypeScript** — `@tencentdb-agent-memory/memory-sdk-ts-v2`

  ```ts
  import { MemoryClient, SkillClient, MetadataClient } from "@tencentdb-agent-memory/memory-sdk-ts-v2";

  const memory = new MemoryClient({
    endpoint, apiKey, serviceId,
    teamId, agentId, userId,     // v3 strict isolation: all three are required
  });
  ```

  Top-level export is the v3 strict isolation version; old code going through the `.../v2/v3` subpath also
  Can continue to use (subpath retained as backward-compatible alias).

- **Python** — `pip install tencentdb-agent-memory-sdk-python`

  ```python
  from tencentdb_agent_memory import MemoryClient                     # Default (v2 compatible)
  from tencentdb_agent_memory.v3 import MemoryClient, MetadataClient, SkillClient
  ```

### 📖 Document

- Add integration guide for CodeBuddy / Hermes / OpenClaw
- Update role permission descriptions in the installation guide

---

## [2.0.0-beta.1] — 2026-07-21

Initial public release. SemVer starts from `2.0.0-beta.1` (npm package name migrated to `-v2` suffix:
`@tencentdb-agent-memory/memory-tencentdb-v2`、`memory-sdk-ts-v2`）。
The Docker image tag is independent of the npm version, and the image being released is `:1.0.0-beta.1`.

> **Product Positioning**: Turn Agent experience, documentation, and code into reusable assets, so that the next Agent
> Load the save directly. See [README_CN.md](./README_CN.md).

### 🧠 Four Memory Assets · First Complete Open Source

Four types of assets are automatically accumulated from "conversation/work traces":

- **Chat Memory** — Extract L0 raw records from the conversation layer by layer → L1 facts → L2 scenarios → L3
  Long-term cognition; preserve preferences, decisions, and interaction history across sessions.
- **Skill** — Extract reusable SOP from tasks that work, with version / resource files / trigger boundaries /
  Execute steps / verify rules.
- **Wiki** — Turn documents into structured pages + a link graph (inspired by Karpathy's LLM knowledge base
  (Practice).
- **CodeGraph** — indexes the repository's symbols / files / call relationships / impact paths, Agent modifies code
  First, perform an impact analysis.

### 🎛️ Memory Hub · Team-oriented Console

Control Panel (`agentmemory/memory-hub` image, including Panel + Knowledge Service):

- Create Team / Agent, and uniformly manage assets by Owner / Version / Status / Visibility
- Three-level visibility: `private` / `team` / `restricted` (User / Role / Agent ACL),
  plus `agent` targeted assembly
- Agent Loadout: bind different assets to different Agents, adjust priority and usage
- Wiki + CodeGraph workshop is built-in in Hub, and can automatically build by importing code repositories/documents

### 🔀 Memory Proxy · Channel for Agents to Mount Memory

`agentmemory/memory-proxy` enables coding agents like Claude Code to directly use team memory:

- **Anthropic / OpenAI Dual Protocols**: `/claude-code/<spaceId>/v1/messages` and
  `/v1/chat/completions` both connect to
- **Initial Guidance**: sessionInit uses `AskUserQuestion` to let users select team / agent /
  task, and the proxy remembers the binding
- **Per-Round Injection**: the agent's L2/L3 memory, matched skill, wiki/code-graph
  are appended to the system prompt, and the upstream LLM is forwarded
- **Authentication**: `x-tdai-user-key` → kernel `/v3/meta/auth/verify` replaces with `user_id`,
  controlling asset visibility by user dimension

### 🚀 Start the complete three-piece set with a single command

Three multi-architecture images (`linux/amd64` + `linux/arm64`) have been published to
[Docker Hub `agentmemory`](https://hub.docker.com/u/agentmemory), publicly pullable,
no login required:

```bash
git clone https://github.com/Tencent/TencentDB-Agent-Memory.git
cd TencentDB-Agent-Memory/deploy/global-images
cp .env.example .env && $EDITOR .env    # Enter two sets of LLM parameters
./start-all.sh                          # Start all with one click
```

`start-all.sh` automatically `init-admin`, generates admin `sk-mem-...` and persists to disk on first launch
`.admin-key`; after self-checking `/v3/meta/auth/verify`, print the copyable `claude` startup command.
`stop-all.sh --purge` completely purges the volume + admin key, making it convenient for reset.

See [INSTALL_CN.md](./INSTALL_CN.md) / [INSTALL.md](./INSTALL.md).

### 🧰 Official SDK

- **TypeScript** — `@tencentdb-agent-memory/memory-sdk-ts-v2`

  ```ts
  import { MemoryClient, SkillClient, MetadataClient } from "@tencentdb-agent-memory/memory-sdk-ts-v2";

  const memory = new MemoryClient({
    endpoint, apiKey, serviceId,
    teamId, agentId, userId,     // v3 strict isolation: all three are required
  });
  ```

  Top-level export is the v3 strict isolation version; old code going through the `.../v2/v3` subpath also
  Can continue to use (subpath retained as backward-compatible alias).

- **Python** — `pip install tencentdb-agent-memory-sdk-python`

  ```python
  from tencentdb_agent_memory import MemoryClient                     # Default (v2 compatible)
  from tencentdb_agent_memory.v3 import MemoryClient, MetadataClient, SkillClient
  ```
