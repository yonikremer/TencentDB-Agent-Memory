/**
 * api/meta-instances.ts — Select instance before login (GET /api/v1/meta/instances).
 */
import { request, dedupeInFlight } from './base';

/**
 * Instance metadata visible to the client.
 *   - `api_key` (true secret) is not sent.
 *   - `gateway_endpoint` is the backend → kernel forwarding address, and also the "baseUrl" for client access.
 *     It is not a secret; it is independent for each instance, and the frontend cannot hardcode it.
 *   - `proxy_endpoint` is optional. In local deployment, core and proxy are separate, and the client needs to connect to the
 *     proxy, so this field needs to be explicitly configured. Only used in the frontend UI "Client Access Address" card; the backend
 *     Forwarding always goes through `gateway_endpoint`, and is not affected by it.
 */
export interface MetadataInstance {
  instance_id: string;
  name: string;
  gateway_endpoint: string;
  proxy_endpoint?: string;
}

export const metaInstancesApi = {
  /** Select instance before login; GET /api/v1/meta/instances, public, no authentication required, no pagination */
  list: () =>
    dedupeInFlight('meta/instances', () =>
      request<{ instances: MetadataInstance[] }>('GET', '/api/v1/meta/instances').then((r) => r.instances),
    ),
};
