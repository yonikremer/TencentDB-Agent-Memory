import os

p1 = r'C:\Users\yonik\TencentDB-Agent-Memory\MemoryCore\src\core\record\l1-extractor.ts'
with open(p1, 'r', encoding='utf-8') as f:
    c = f.read()
c = c.replace('"未知情境"', '"Unknown Scene"')
with open(p1, 'w', encoding='utf-8') as f:
    f.write(c)
print('l1-extractor.ts translated')

import re
# Now tdai-core.ts
p2 = r'C:\Users\yonik\TencentDB-Agent-Memory\MemoryCore\src\core\tdai-core.ts'
with open(p2, 'r', encoding='utf-8') as f:
    c = f.read()

replacements2 = {
    '// Skill async-extract 现在完全走 conversation-add 侧的 agent 队列 + Worker': '// Skill async-extract now completely goes through the agent queue + Worker on the conversation-add side',
    '// (SkillTriggerService.archive → agent 队列 → SkillConversationExtractWorker),': '// (SkillTriggerService.archive → agent queue → SkillConversationExtractWorker),',
    '// 由 gateway/openclaw host wiring 的 wireConversationAdd 起。tdai-core 只负责': '// initiated by wireConversationAdd of gateway/openclaw host wiring. tdai-core is only responsible for',
    '// 构造 SkillExtractor 单例给 wire 层用。': '// constructing the SkillExtractor singleton for the wire layer to use.',
    '* Skill 生命周期钩子的注入点。用于把 skill 的 create/access/archive 事件同步到': '* Injection point for Skill lifecycle hooks. Used to sync skill create/access/archive events to',
    '* 上层的资产注册表（`meta_assets` + `meta_agent_fixed_assets`），实现「skill 创建': '* the upper asset registry (`meta_assets` + `meta_agent_fixed_assets`), realizing semantics like "skill is',
    '* 后前端管控页立即可见」「skill 归档后 agent 绑定被清」等语义。': '* immediately visible on the frontend control page after creation" and "agent binding is cleared after skill archiving".',
    '* 契约与 `SkillVersioningOptions.onSkillCreated` / `SkillCoreOptions.onSkillArchived`': '* Contract is identical with `SkillVersioningOptions.onSkillCreated` / `SkillCoreOptions.onSkillArchived`',
    '* / `SkillCoreOptions.onSkillAccessed` 完全一致（详见 skill-versioning.ts 与': '* / `SkillCoreOptions.onSkillAccessed` (see docs in skill-versioning.ts and',
    '* skill-core.ts 的 doc）：': '* skill-core.ts):',
    '*   - onSkillCreated：v1 首创前置 await，抛异常 = create 失败': '*   - onSkillCreated: v1 initial creation pre-await, throw exception = create failed',
    '*   - onSkillAccessed：fire-and-forget，抛异常 SkillCore 内部吞掉': '*   - onSkillAccessed: fire-and-forget, throw exception swallowed inside SkillCore',
    '*   - onSkillArchived：fire-and-forget，抛异常 SkillCore 内部吞掉': '*   - onSkillArchived: fire-and-forget, throw exception swallowed inside SkillCore',
    '* 存在的必要性（standalone / OpenClaw 模式）：': '* Necessity of existence (standalone / OpenClaw mode):',
    '*   service 模式下 gateway/server.ts:resolveSkillCore 已经挂了同名钩子；': '*   in service mode gateway/server.ts:resolveSkillCore has already hooked the same name;',
    '*   standalone / OpenClaw 模式下 SkillCore 由 TdaiCore 全局构造，之前不挂钩子': '*   in standalone / OpenClaw mode SkillCore is globally constructed by TdaiCore, previously not hooked',
    '*   导致：绕过 gateway handler 的任何调用路径（CLI / 未来内嵌 / skill.extract 同步分支）': '*   causing: any call path bypassing the gateway handler (CLI / future embedded / skill.extract sync branch)',
    '*   都不会登记 asset，且 handleGet / handleFilesRead 完全没有兜底，读时自愈失效。': '*   would not register asset, and handleGet / handleFilesRead had no fallback, making read self-healing fail.',
    '*   通过这个 options 让上层（如 gateway 或 openclaw 插件）可以选择性注入 hooks，': '*   Through these options, the upper layer (like gateway or openclaw plugin) can selectively inject hooks,',
    '*   把 asset 联动语义带进 standalone / OpenClaw 路径。': '*   bringing asset linkage semantics into the standalone / OpenClaw path.',
    '* 可选：把 skill 生命周期事件同步到上层资产注册表的钩子。': '* Optional: hooks to sync skill lifecycle events to the upper asset registry.',
    '* 由 host wiring 层（gateway/openclaw 插件）在构造 TdaiCore 时按需注入，注入后': '* Injected on demand by the host wiring layer (gateway/openclaw plugin) when constructing TdaiCore, after which',
    '* standalone / OpenClaw 模式下的 SkillCore 与 service 模式行为对齐。详见': '* SkillCore in standalone / OpenClaw mode aligns with service mode behavior. See',
    '* `SkillAssetHooks` 的 doc。': '* doc of `SkillAssetHooks`.',
    '* 不注入（undefined）→ SkillCore/SkillVersioning 不挂任何钩子，保持既有行为': '* Not injected (undefined) → SkillCore/SkillVersioning does not attach any hooks, keeping existing behavior',
    '* （零耦合：OpenClaw 无 MetadataService 场景仍可安全构造）。': '* (zero coupling: can still safely construct in OpenClaw scenarios without MetadataService).',
    '* 可选：skill 生命周期钩子，用来把 create/access/archive 同步到上层 asset 注册表。': '* Optional: skill lifecycle hooks, used to sync create/access/archive to upper asset registry.',
    '* 见 `SkillAssetHooks` 的 doc。undefined = 不挂钩子（既有 standalone 老行为）。': '* See doc of `SkillAssetHooks`. undefined = no hooks (existing standalone old behavior).',
    '// Skill async-extract worker + queue 由 gateway/openclaw 侧 wireConversationAdd': '// Skill async-extract worker + queue is initiated by wireConversationAdd on gateway/openclaw side',
    '// 起, 也在各自的 WiredConversationAdd.stop() 里 graceful shutdown。tdai-core': '// and also gracefully shutdown in their respective WiredConversationAdd.stop(). tdai-core',
    '// 无需在这里 stop skill 侧的 worker/queue (它已经不再持有它们)。': '// does not need to stop the worker/queue on the skill side here (it no longer holds them).',
    '// 非侵入式上报召回指标（静默失败，绝不影响业务返回）': '// Non-intrusively report recall metrics (silent failure, absolutely no impact on business return)',
    '// 静默失败': '// silent failure',
    '* 把 this.cfg.llm 按 provider 解析成运行时可直接用的 (baseUrl, apiKey, model)。': '* Parse this.cfg.llm by provider into directly usable (baseUrl, apiKey, model) at runtime.',
    '* provider=openai 时透传；provider=proxy 时替换 baseUrl 为 `${baseUrl}/proxy/<iid>/v1`，': '* when provider=openai pass through; when provider=proxy replace baseUrl with `${baseUrl}/proxy/<iid>/v1`,',
    '* apiKey 用 env.TDAI_MEMORY_SYSTEM_USER_KEY。四个 runner factory 构造点共用。': '* apiKey uses env.TDAI_MEMORY_SYSTEM_USER_KEY. Shared by four runner factory construction points.',
    '// 用 MetricTrackingRunnerFactory 装饰器包装（非侵入式 credit 上报）': '// Wrap with MetricTrackingRunnerFactory decorator (non-intrusive credit reporting)',
    '// Kafka 未配置时 metricProducer.send() 是 no-op，零开销': '// When Kafka is not configured metricProducer.send() is no-op, zero overhead',
    '// 资产联动钩子（可选注入）——与 service 模式 gateway/server.ts:resolveSkillCore': '// Asset linkage hooks (optional injection) —— fully aligned with the three hooks',
    '// 挂的三钩子完全对齐。未注入时保持零耦合老行为。': '// attached in service mode gateway/server.ts:resolveSkillCore. Maintains zero coupling old behavior when not injected.',
    '// 队列构造与 LLM runner **解耦**：队列只是 Redis / local 数据结构，': '// Queue construction is **decoupled** from LLM runner: queue is just Redis / local data structure,',
    '// 与 llm 是否可构造无关。之前把它塞在 `if (llmRunner)` 里，导致': '// irrelevant to whether llm is constructible. Previously it was stuffed in `if (llmRunner)`, causing',
    '// service 模式下 llm runner 因 `provider=proxy + instanceId=__unset__`': '// in service mode llm runner throws error due to `provider=proxy + instanceId=__unset__`,',
    '// 抛错时，整段 skill wiring（含队列）都被 catch 掉，handler 端拿不到': '// the entire skill wiring (including queue) gets caught, handler cannot get',
    '// queue 就永远回 QUEUE_UNAVAILABLE。': '// queue and will always return QUEUE_UNAVAILABLE.',
    '// 新顺序：': '// New order:',
    '//   1. 先构造 queue（前置条件：extraction.enabled && queue.enabled）': '//   1. First construct queue (precondition: extraction.enabled && queue.enabled)',
    '//   2. 再尝试构造单例 llm runner + extractor（standalone 模式必需；': '//   2. Then try to construct singleton llm runner + extractor (necessary for standalone mode;',
    '//      service 模式失败也没关系——worker 走 extractorFactory 现场构造）': '//      failure in service mode is fine——worker goes through extractorFactory for on-site construction)',
    '//   3. 起 worker：constructSkillWorker=true 且有 queue 就起': '//   3. Start worker: if constructSkillWorker=true and there is a queue then start',
    '//      - 有单例 extractor → 用单例（standalone）': '//      - Has singleton extractor → use singleton (standalone)',
    '//      - 没有单例 extractor → 让 host wiring（server.ts）负责起带 factory 的 worker，': '//      - No singleton extractor → let host wiring (server.ts) be responsible for starting worker with factory,',
    '//        tdai-core 这里跳过': '//        tdai-core skips here',
    '// 只构造 SkillExtractor 单例 —— worker + queue 现在由 gateway/openclaw': '// Only construct SkillExtractor singleton —— worker + queue are now initiated by wireConversationAdd',
    '// 侧 wireConversationAdd 起 (SkillConversationExtractWorker + agent 队列),': '// on the gateway/openclaw side (SkillConversationExtractWorker + agent queue),',
    '// 见 2026-07-17 skill_extract 收敛方案。standalone 模式下 wire 层': '// see 2026-07-17 skill_extract convergence plan. In standalone mode the wire layer',
    '// 通过 core.getSkillExtractor() 拿这个单例; service 模式忽略, 走': '// gets this singleton via core.getSkillExtractor(); ignored in service mode, goes through',
    '// provider=proxy 时 cfg.apiKey 可能为空（真正的 apiKey 由 resolver 从 env 注入），': '// when provider=proxy cfg.apiKey might be empty (true apiKey is injected by resolver from env),',
    '// 因此只要 provider=proxy 就允许构造；provider=openai 时保留原有 baseUrl+apiKey 检查。': '// thus construction is allowed as long as provider=proxy; keeps original baseUrl+apiKey check when provider=openai.',
    '* service 模式必须传：跨节点保护 checkpoint 读改写的分布式锁。': '* service mode must pass: distributed lock protecting checkpoint read/modify/write across nodes.',
    '* 同 instance 的 checkpoint 是**同一个** COS 对象，而 L1 的任务锁是': '* the checkpoint of the same instance is the **same** COS object, while the L1 task lock is',
    '* session 级 —— 不同 session / 不同 agent 会在多节点合法并发，': '* session level —— different sessions / different agents will legally concur across multiple nodes,',
    '* 若不额外互斥，后写者会用旧快照覆盖先写者的 runner_states（L1 游标丢失）。': '* if not mutually excluded additionally, the late writer will overwrite the early writer\'s runner_states with an old snapshot (L1 cursor lost).',
    '* standalone 单进程不需要传（进程内 withFileLock 已足够）。': '* standalone single process does not need to pass (in-process withFileLock is sufficient).',
    '// Read accumulated credit from the tracking runner (原始浮点数，与监控侧严格一致)': '// Read accumulated credit from the tracking runner (original float, strictly consistent with monitoring side)',
}

for k, v in replacements2.items():
    c = c.replace(k, v)
    
with open(p2, 'w', encoding='utf-8') as f:
    f.write(c)
print('tdai-core.ts translated')

# instance-config-provider.ts
p3 = r'C:\Users\yonik\TencentDB-Agent-Memory\MemoryCore\src\core\instance-config-provider.ts'
with open(p3, 'r', encoding='utf-8') as f:
    c3 = f.read()

replacements3 = {
    '* InstanceConfigProvider — 实例级配置管理': '* InstanceConfigProvider — Instance-level configuration management',
    '* 设计要点:': '* Design highlights:',
    '*   - VDB 配置: per-instance (每个 instanceId 独立的 VDB 连接信息), 带 TTL 缓存': '*   - VDB config: per-instance (independent VDB connection info per instanceId), with TTL cache',
    '*   - COS 配置: 全局共享一份 (所有实例共用同一个 bucket, 按 pathPrefix 隔离)': '*   - COS config: globally shared (all instances share the same bucket, isolated by pathPrefix)',
    '*   - 配置来源通过依赖注入的 IConfigSource 提供:': '*   - Config source provided via dependency-injected IConfigSource:',
    '*     - standalone: LocalConfigSource (本文件内置, 从 env vars 读取)': '*     - standalone: LocalConfigSource (built-in this file, read from env vars)',
    '*     - service:    由部署环境注入远程配置源': '*     - service:    Remote config source injected by deployment environment',
    '* 数据模型:': '* Data model:',
    '*   Core 进程': '*   Core process',
    '*     ├── COS: 全局一份 { cosUrl, tmpSecretId, tmpSecretKey, tmpToken, expirationTime, pathPrefix }': '*     ├── COS: globally shared { cosUrl, tmpSecretId, tmpSecretKey, tmpToken, expirationTime, pathPrefix }',
    '*     └── VDB 池 (Map<instanceId, VdbConfig>):': '*     └── VDB Pool (Map<instanceId, VdbConfig>):',
    '/** ISO 8601 过期时间 (仅临时凭证模式有效) */': '/** ISO 8601 expiration time (only valid in temporary credential mode) */',
    '// LocalConfigSource — 默认实现 (open-source / standalone)': '// LocalConfigSource — Default implementation (open-source / standalone)',
    '// 从进程环境变量读取 VDB + COS 配置。适合无管控面的单租户自部署场景。': '// Reads VDB + COS config from process env vars. Suitable for single-tenant self-deployed scenarios without control plane.',
    '// 与接口同居一处，遵循项目现有约定 (cf. MockCredentialProvider 与': '// Resides together with the interface, following existing project conventions (cf. MockCredentialProvider and',
    '// ICredentialProvider 同写在 src/core/storage/credential-provider.ts)。': '// ICredentialProvider both written in src/core/storage/credential-provider.ts).',
    '// VDB 缓存条目': '// VDB cache entry',
    '/** VDB 缓存 TTL (毫秒), 默认 5 分钟 */': '/** VDB cache TTL (ms), default 5 minutes */',
    '/** COS 凭证提前刷新时间 (毫秒), 默认 2 分钟 */': '/** COS credential early refresh time (ms), default 2 minutes */',
    '/** 最大缓存实例数, 超出后 LRU 淘汰, 默认 1000 */': '/** Max cached instances, LRU eviction upon exceeding, default 1000 */',
    '*   - 无 expirationTime: 使用 vdbTtl (本地长期凭证场景)': '*   - No expirationTime: Use vdbTtl (local long-term credential scenario)',
    '* LRU 淘汰: 删除最近最少访问的实例。': '* LRU Eviction: Delete the least recently accessed instance.',
    '* 实现说明 (H-3): 利用 Map 的插入顺序就是访问顺序的特性 —— resolveVdb 在 cache hit': '* Implementation note (H-3): Utilizing the trait that Map insertion order is access order —— resolveVdb during cache hit',
    '* 时已经做了 delete+set 把热 key 移到 Map 末尾, 所以 Map 的首元素就是 LRU,': '* already does delete+set moving hot key to the end of Map, so the first element of Map is LRU,',
    '* 直接取第一个 key 即可, O(1)。': '* just take the first key, O(1).'
}
for k, v in replacements3.items():
    c3 = c3.replace(k, v)
with open(p3, 'w', encoding='utf-8') as f:
    f.write(c3)
print('instance-config-provider.ts translated')

# config.ts
p4 = r'C:\Users\yonik\TencentDB-Agent-Memory\MemoryCore\src\config.ts'
with open(p4, 'r', encoding='utf-8') as f:
    c4 = f.read()

replacements4 = {
    '* LLM 访问模式：': '* LLM access mode:',
    '*   - "openai": 直连 OpenAI 兼容服务（默认）': '*   - "openai": Direct connect to OpenAI compatible service (default)',
    '*   - "proxy":  走 context_proxy，运行时把 baseUrl 拼成': '*   - "proxy":  Goes through context_proxy, assembles baseUrl at runtime into',
    '*               `${baseUrl}/proxy/<instanceId>/v1`，Authorization 用 memory 系统用户 key': '*               `${baseUrl}/proxy/<instanceId>/v1`, Authorization uses memory system user key',
    '* gateway 层负责在构造 runner 前把 baseUrl / apiKey 换成解析后的最终值，': '* The gateway layer is responsible for replacing baseUrl / apiKey with final parsed values before constructing runner,',
    '* 因此 runner 无需感知 provider 字段。': '* therefore the runner does not need to be aware of the provider field.',
    '/** provider=proxy 时的可选配置。 */': '/** Optional config when provider=proxy. */',
    '/** 是否用 memory systemUser.userKey 作为 Authorization（默认 true）。 */': '/** Whether to use memory systemUser.userKey as Authorization (default true). */',
    '* 是否用流式请求(streamText)调用上游。默认 false(generateText 非流式)。': '* Whether to use streaming request (streamText) to call upstream. Default false (generateText non-streaming).',
    '* 个别 OpenAI 兼容上游只接受流式请求时置 true。': '* Set to true when individual OpenAI compatible upstreams only accept streaming requests.',
    '* ⚠️ 仅在 standalone LLM 路径生效(即 llm.enabled=true 时,memory 用自带的': '* ⚠️ Only effective in standalone LLM path (i.e. when llm.enabled=true, memory uses its built-in',
    '* StandaloneLLMRunner 调用上游);未启用 standalone 时走 OpenClaw host runner,': '* StandaloneLLMRunner to call upstream); when standalone is not enabled it uses OpenClaw host runner,',
    '* 该开关被忽略。也不会把增量 token 透传给调用方,只是"以流式协议请求上游后': '* this switch is ignored. It also won\'t pass incremental tokens to the caller, just "requests upstream with streaming protocol',
    '* 等待完整文本",给只接受流式的兼容后端做兼容层用。': '* and waits for full text", acting as a compatibility layer for backends that only accept streaming.',
    '* 是否用流式请求(streamText)调用上游(仅 mode="local" 生效)。默认 false(非流式)。': '* Whether to use streaming request (streamText) to call upstream (only effective in mode="local"). Default false (non-streaming).',
    '* 个别只接受流式请求的 OpenAI 兼容上游需置 true。': '* Set to true for individual OpenAI compatible upstreams that only accept streaming requests.',
    '* ⚠️ mode="backend"/"client"/"collect" 由远端 offload server主导调用,': '* ⚠️ mode="backend"/"client"/"collect" are initiated by remote offload server,',
    '* ⚠️ mode="backend"/"client"/"collect" 由远端 offload server 主导调用,': '* ⚠️ mode="backend"/"client"/"collect" are initiated by remote offload server,',
    '* 本地 stream 开关被忽略。也不会把增量 token 透传给调用方,只是"以流式协议': '* local stream switch is ignored. It also won\'t pass incremental tokens to the caller, just "requests with streaming protocol',
    '* 请求上游后等待完整文本",给只接受流式的兼容后端做兼容层用。': '* upstream and waits for full text", acting as a compatibility layer for backends that only accept streaming.',
    '// 默认 true：走 proxy 时用 memory 系统用户 key 作为 Authorization。': '// Default true: when going through proxy use memory system user key as Authorization.'
}
for k, v in replacements4.items():
    c4 = c4.replace(k, v)
with open(p4, 'w', encoding='utf-8') as f:
    f.write(c4)
print('config.ts translated')
