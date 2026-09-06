/**
 * Ambient declaration for the private `@context-proxy/cost-guard` submodule.
 *
 * The submodule lives in `packages/cost-guard/` (mapped in tsconfig `paths`) and is only
 * present in internal builds — open-source clones have no `packages/` directory. This
 * declaration keeps `tsc` green without the submodule while remaining structurally
 * compatible with the real module (see `storage/cos-types.ts`, the authoritative shape).
 *
 * The runtime still guards every use with a dynamic `import` inside try/catch, so an
 * absent submodule degrades cleanly to the sqlite/fs/memory backend chain.
 *
 * See docs/design/2026-07-11-cos-submodule-extraction-plan.md §4.2.
 */
declare module "@context-proxy/cost-guard" {
  import type { CosLikeBackend, KernelStsCosOptions } from "./storage/cos-types.js";
  export function openKernelStsCosBackend(opts: KernelStsCosOptions): CosLikeBackend;
}
