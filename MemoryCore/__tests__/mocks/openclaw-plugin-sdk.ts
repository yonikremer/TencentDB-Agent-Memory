/**
 * Test stub for the optional `openclaw/plugin-sdk` deep import.
 *
 * The installed `openclaw` package does not export the bare `./plugin-sdk`
 * subpath; `src/offload/index.ts` guards that import inside try/catch at
 * runtime. Vite, however, statically resolves literal dynamic imports and
 * hard-fails at transform time, so this alias gives the import a resolvable
 * target. Tests re-mock this module (via vi.mock on its resolved path) to
 * exercise both the success and the caught-failure branch.
 */
export const delegateCompactionToRuntime: unknown = undefined;
export const delegateToRuntime: unknown = undefined;
