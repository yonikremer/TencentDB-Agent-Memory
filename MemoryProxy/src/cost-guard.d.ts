declare module "@context-proxy/cost-guard" {
  /**
   * Optional internal dependency (submodule). Absent for open-source users;
   * storage/factory.ts dynamic-imports it in try/catch and degrades gracefully.
   * Kept loosely typed on purpose — the factory narrows via `as` at the call site.
   */
  export function openKernelStsCosBackend(
    ...args: unknown[]
  ): unknown;
}
