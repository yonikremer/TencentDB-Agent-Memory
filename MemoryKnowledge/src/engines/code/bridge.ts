/**
 * CodeGraph Bridge — Wrapper for @colbymchenry/codegraph core APIs.
 *
 * Wraps CodeGraph instance + ToolHandler into concise invocation interfaces,
 * allowing upper-layer APIs to call bridge methods directly without depending on codegraph internal structures.
 */

import { createRequire } from "node:module";
import { pathToFileURL } from "url";
import { createLogger } from "../../logger.js";

const log = createLogger("bridge");

let _codegraphModule: any = null;
let _toolsModule: any = null;

/**
 * Resolves the mcp/tools module path where ToolHandler resides.
 *
 * The main npm package entry is npm-sdk.js, which requires the platform package
 * (such as @colbymchenry/codegraph-linux-x64) lib/dist/index.js at runtime.
 * mcp/tools.js is under lib/dist/mcp/ in the platform package. Must resolve from main npm package path:
 * pnpm's strict isolation will not expose optional dependencies of the main package to the KS root directory.
 */
export function resolveToolsPath(): string {
  const appRequire = createRequire(import.meta.url);
  const platform = `${process.platform}-${process.arch}`;
  const toolsSpecifier = `@colbymchenry/codegraph-${platform}/lib/dist/mcp/tools.js`;
  try {
    const codegraphEntry = appRequire.resolve("@colbymchenry/codegraph");
    const codegraphRequire = createRequire(codegraphEntry);
    return codegraphRequire.resolve(toolsSpecifier);
  } catch {
    throw new Error(
      `codegraph: platform package @colbymchenry/codegraph-${platform} not installed or missing mcp/tools.js. ` +
      `Run: pnpm add @colbymchenry/codegraph`,
    );
  }
}

async function loadModules() {
  if (_codegraphModule) {
    return extractExports();
  }

  const toolsPath = resolveToolsPath();
  log.info("Loading codegraph from npm package");
  _codegraphModule = await import("@colbymchenry/codegraph");
  _toolsModule = await import(pathToFileURL(toolsPath).href);
  log.info("Loaded codegraph from npm package", {
    indexKeys: Object.keys(_codegraphModule),
    toolsKeys: Object.keys(_toolsModule),
  });
  return extractExports();
}

/**
 * Under ESM, import() of CJS packages is wrapped into `{ default: module.exports }`;
 * Under CJS mode (tsx), import() is transformed to require(), returning an unwrapped object.
 * Unify unwrap here so exports can be correctly obtained in both modes.
 */
function unwrapCjs<T>(mod: T): T {
  const m = mod as unknown as { default?: unknown };
  return m && typeof m === "object" && m.default && typeof m.default === "object"
    ? (m.default as T)
    : mod;
}

function extractExports() {
  const cg = unwrapCjs(_codegraphModule);
  const tools = unwrapCjs(_toolsModule);
  return {
    CodeGraph: cg.CodeGraph,
    ToolHandler: tools.ToolHandler,
    isInitialized: cg.isInitialized,
    getCodeGraphDir: cg.getCodeGraphDir,
  };
}

export interface CodeGraphInstance {
  cg: any;
  handler: any;
  projectRoot: string;
}

/**
 * Opens an existing codegraph index.
 */
export async function openIndex(projectPath: string): Promise<CodeGraphInstance> {
  log.info("openIndex", { projectPath });
  const { CodeGraph, ToolHandler } = await loadModules();
  const cg = await CodeGraph.open(projectPath);
  const stats = cg.getStats();
  log.info("openIndex complete", { projectPath, stats });
  const handler = new ToolHandler(cg);
  // Inform ToolHandler of project root to prevent false alarms from using process cwd for worktree detection
  if (typeof handler.setDefaultProjectHint === "function") {
    handler.setDefaultProjectHint(projectPath);
  }
  return { cg, handler, projectRoot: projectPath };
}

/**
 * Performs full indexing on a project directory.
 */
export async function indexProject(projectPath: string): Promise<CodeGraphInstance> {
  log.info("indexProject start", { projectPath });
  const { CodeGraph, ToolHandler, isInitialized } = await loadModules();

  const initialized = isInitialized(projectPath);
  log.debug("isInitialized check", { projectPath, initialized });

  let cg: any;
  if (initialized) {
    // Existing index: open and re-index full project
    log.info("Re-indexing existing project");
    cg = await CodeGraph.open(projectPath);
    await cg.indexAll();
  } else {
    // First-time initialization: create directory structure + DB + full indexing
    log.info("First-time init + index");
    cg = await CodeGraph.init(projectPath, { index: true });
  }

  const stats = cg.getStats();
  log.info("indexProject complete", { projectPath, stats });

  const handler = new ToolHandler(cg);
  if (typeof handler.setDefaultProjectHint === "function") {
    handler.setDefaultProjectHint(projectPath);
  }
  log.debug("ToolHandler created", { availableTools: Object.keys(handler.tools || handler._tools || {}) });
  return { cg, handler, projectRoot: projectPath };
}

/**
 * Incremental sync (processes changed files only).
 */
export async function syncIndex(instance: CodeGraphInstance): Promise<{ changed: number }> {
  log.info("syncIndex start", { projectRoot: instance.projectRoot });
  const result = await instance.cg.sync();
  const changed = result?.filesChanged ?? 0;
  log.info("syncIndex complete", { changed });
  return { changed };
}

/**
 * Executes a codegraph MCP tool (reusing ToolHandler's formatted output).
 */
export async function executeTool(
  instance: CodeGraphInstance,
  toolName: string,
  params: Record<string, unknown>,
): Promise<{ text: string; isError: boolean }> {
  log.info("executeTool", { toolName, params, projectRoot: instance.projectRoot });

  // Check handler instance state
  log.debug("handler state", {
    handlerType: typeof instance.handler,
    handlerKeys: Object.keys(instance.handler),
    hasExecute: typeof instance.handler.execute === "function",
  });

  const result = await instance.handler.execute(toolName, params);

  log.debug("executeTool raw result", {
    toolName,
    resultKeys: Object.keys(result || {}),
    contentLength: result?.content?.length,
    content0: result?.content?.[0],
    isError: result?.isError,
  });

  const text = result.content?.[0]?.text ?? "";
  const isError = result.isError ?? false;

  log.info("executeTool response", { toolName, isError, textLength: text.length, textPreview: text.slice(0, 200) });
  return { text, isError };
}

/**
 * Gets index statistics.
 */
export function getStats(instance: CodeGraphInstance) {
  const stats = instance.cg.getStats();
  log.debug("getStats", { stats });
  return stats;
}

/**
 * Closes the index (releases SQLite connections).
 */
export function closeIndex(instance: CodeGraphInstance): void {
  log.info("closeIndex", { projectRoot: instance.projectRoot });
  try {
    instance.cg.close?.();
  } catch {
    // best-effort
  }
}
