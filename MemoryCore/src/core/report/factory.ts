/**
 * Observability Backend Factory — Factory functions + global singleton management.
 *
 * Driven by configuration to create observability backend instances:
 * - "noop"     → NoopObservabilityBackend (default, zero overhead)
 * - "console"  → ConsoleObservabilityBackend (development/debugging, stdout output)
 * - "otlp"     → OtlpObservabilityBackend (recommended for open source, standard OTLP protocol)
 * - "internal" → Dynamically load private module (internal env: Zhiyan + Kafka + Langfuse)
 *
 * Open-source users are recommended to use "otlp" type, just configure an endpoint to report
 * Trace/Log/Metric to any backend supporting OTLP.
 *
 * Refer to src/core/storage/factory.ts design pattern.
 */

import type { IObservabilityBackend, ObservabilityConfig } from "./types.js";
import { NoopObservabilityBackend } from "./noop-backend.js";
import { ConsoleObservabilityBackend } from "./console-backend.js";
import { OtlpObservabilityBackend } from "./otlp-backend.js";

const TAG = "[observability][factory]";

// ============================
// Dynamically load private module
// ============================

/**
 * Try to dynamically load optional observability module.
 * Returns null on load failure.
 */
async function loadInternalBackend(): Promise<{ createInternalObservabilityBackend: (config: ObservabilityConfig) => Promise<IObservabilityBackend> } | null> {
  try {
    return await import("../../integrations/observability/index.js");
  } catch {
    return null;
  }
}

// ============================
// Factory functions
// ============================

/**
 * Create observability backend instance.
 *
 * @param config Observability configuration
 * @returns IObservabilityBackend instance
 */
export async function createObservabilityBackend(
  config: ObservabilityConfig,
): Promise<IObservabilityBackend> {
  const type = config.type ?? "noop";

  switch (type) {
    case "internal": {
      const privateModule = await loadInternalBackend();
      if (!privateModule) {
        console.warn(
          `${TAG} Internal observability backend requested but private module not available. ` +
          `Falling back to console backend. Install the private submodule for full observability.`,
        );
        const backend = new ConsoleObservabilityBackend();
        await backend.initialize(config);
        return backend;
      }
      const backend = await privateModule.createInternalObservabilityBackend(config);
      await backend.initialize(config);
      return backend;
    }

    case "otlp": {
      const backend = new OtlpObservabilityBackend();
      await backend.initialize(config);
      return backend;
    }

    case "console": {
      const backend = new ConsoleObservabilityBackend();
      await backend.initialize(config);
      return backend;
    }

    case "noop":
    default: {
      const backend = new NoopObservabilityBackend();
      await backend.initialize(config);
      return backend;
    }
  }
}

// ============================
// Global singleton management
// ============================

/** Global observability backend instance */
let _globalBackend: IObservabilityBackend = new NoopObservabilityBackend();

/** Whether initialized */
let _initialized = false;

/**
 * Get global observability backend instance.
 * Returns Noop instance if not initialized (safe fallback).
 */
export function getObservabilityBackend(): IObservabilityBackend {
  return _globalBackend;
}

/**
 * Initialize global observability backend.
 * Idempotent: only the first call takes effect.
 *
 * @param config Observability configuration
 */
export async function initObservabilityBackend(config: ObservabilityConfig): Promise<void> {
  if (_initialized) return;

  try {
    _globalBackend = await createObservabilityBackend(config);
    _initialized = true;
    console.log(`${TAG} Observability backend initialized: type=${_globalBackend.type}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`${TAG} Failed to initialize observability backend: ${msg}. Using noop.`);
    _globalBackend = new NoopObservabilityBackend();
    _initialized = true;
  }
}

/**
 * Reset global observability backend (for plugin hot-reload and testing).
 * Calls current backend's shutdown() first.
 */
export async function resetObservabilityBackend(): Promise<void> {
  try {
    await _globalBackend.shutdown();
  } catch {
    // Silent
  }
  _globalBackend = new NoopObservabilityBackend();
  _initialized = false;
}
