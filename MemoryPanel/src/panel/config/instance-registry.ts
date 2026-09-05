import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';

const instanceSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  gateway_endpoint: z.string().url(),
  // Optional: client access address (e.g., baseUrl for CodeBuddy / ClaudeCode CLI).
  // Difference from `gateway_endpoint`:
  //   - `gateway_endpoint` is always the forwarding address from Panel backend → Kernel (core / gateway),
  //     it is gateway in production, and can directly point to core for local open-source deployment; this field controls **panel forwarding**, and must not be moved.
  //   - `proxy_endpoint` is only for the frontend "client access address" card concatenation display.
  //     During production deployment, proxy is placed in front of gateway, and the two values are unified (default is fine, falls back to gateway_endpoint to maintain old behavior);
  //      When deploying open-source locally, core and proxy run separately, and the client connects to proxy, so this field needs to be explicitly filled in.
  proxy_endpoint: z.string().url().optional(),
  api_key: z.string().min(1),
});

const fileSchema = z.object({
  instances: z.array(instanceSchema).min(1),
});

export interface InstanceEntry {
  instance_id: string;
  name: string;
  gateway_endpoint: string;
  /** See the comment above instanceSchema.proxy_endpoint; if not configured, the frontend falls back to gateway_endpoint. */
  proxy_endpoint?: string;
  api_key: string;
}

export interface PublicInstance {
  instance_id: string;
  name: string;
  /**
   * Panel backend → Kernel forwarding address (e.g., https://memory.ap-beijing.tencenttdai.com).
   * Not a secret —— CodeBuddy / ClaudeCode CLI users have historically used it to configure baseUrl;
   * Frontend cannot hardcode it; each instance's endpoint is different (dev/staging/prod).
   * `api_key` is a secret, not sent.
   */
  gateway_endpoint: string;
  /**
   * Optional: client connects to baseUrl (used when the frontend "Client Connection Address" card is displayed).
   * When missing, the frontend falls back to `gateway_endpoint`, equivalent to the old behavior. **Not used in the Panel forwarding chain.**
   */
  proxy_endpoint?: string;
}

export class InstanceRegistryError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
    this.name = 'InstanceRegistryError';
  }
}

export class InstanceRegistry {
  private readonly byId: Map<string, InstanceEntry>;

  constructor(entries: InstanceEntry[]) {
    this.byId = new Map(entries.map((e) => [e.instance_id, e]));
  }

  static load(configPath: string): InstanceRegistry {
    const filePath = resolve(configPath);
    if (!existsSync(filePath)) {
      throw new InstanceRegistryError(
        500,
        `metadata instances config not found: ${filePath}\n` +
          `  hint: cp config/metadata-instances.example.json config/metadata-instances.json`,
      );
    }
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(filePath, 'utf8')) as unknown;
    } catch {
      throw new InstanceRegistryError(500, `invalid metadata instances config: ${filePath}`);
    }
    const parsed = fileSchema.safeParse(raw);
    if (!parsed.success) {
      throw new InstanceRegistryError(500, `metadata instances config validation failed`);
    }
    const entries = parsed.data.instances.map((row) => ({
      instance_id: row.id,
      name: row.name,
      gateway_endpoint: row.gateway_endpoint,
      proxy_endpoint: row.proxy_endpoint,
      api_key: row.api_key,
    }));
    return new InstanceRegistry(entries);
  }

  resolve(instanceId: string): InstanceEntry {
    const entry = this.byId.get(instanceId);
    if (!entry) {
      throw new InstanceRegistryError(400, 'INVALID_INSTANCE');
    }
    return entry;
  }

  listPublic(): PublicInstance[] {
    return [...this.byId.values()].map(({ instance_id, name, gateway_endpoint, proxy_endpoint }) => ({
      instance_id,
      name,
      gateway_endpoint,
      // Fields are not sent if not filled (not explicit undefined, frontend `??` fallback is cleaner)
      ...(proxy_endpoint ? { proxy_endpoint } : {}),
    }));
  }

  /** Full entries incl. credentials — internal startup/admin use only, never client-facing. */
  listAll(): InstanceEntry[] {
    return [...this.byId.values()];
  }
}
