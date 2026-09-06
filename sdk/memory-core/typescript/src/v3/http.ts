/** Strict HTTP transport used exclusively by v3 SDK clients. */

import { Agent } from "undici";
import { ParamError, TDAMError } from "../errors.js";
import type { HttpTransportOptions } from "../http.js";
import type { ApiResponseEnvelope } from "../types.js";

export interface V3HttpTransportOptions extends Omit<HttpTransportOptions, "apiKey"> {
  /** Optional Bearer token — KS standalone needs none; gateway clients must pass one. */
  apiKey?: string;
}

export class V3HttpTransport {
  private readonly endpoint: string;
  private readonly headers: Record<string, string>;
  private readonly timeout: number;
  private readonly dispatcher?: Agent;

  constructor(opts: V3HttpTransportOptions) {
    let endpoint: URL;
    try {
      endpoint = new URL(opts.endpoint);
    } catch {
      throw new ParamError("endpoint must be a valid HTTP(S) URL");
    }
    if (endpoint.protocol !== "http:" && endpoint.protocol !== "https:") {
      throw new ParamError("endpoint must be a valid HTTP(S) URL");
    }
    if (!opts.serviceId?.trim()) throw new ParamError("serviceId must be provided");
    const timeout = opts.timeout ?? 30_000;
    if (!Number.isFinite(timeout) || timeout <= 0) {
      throw new ParamError("timeout must be a positive number");
    }

    this.endpoint = opts.endpoint.replace(/\/+$/, "");
    this.timeout = timeout;
    this.headers = {
      "x-tdai-service-id": opts.serviceId,
      "Content-Type": "application/json",
    };
    if (opts.apiKey?.trim()) this.headers.Authorization = `Bearer ${opts.apiKey.trim()}`;
    if (opts.userKey) this.headers["x-tdai-user-key"] = opts.userKey;
    if (opts.rejectUnauthorized === false) {
      this.dispatcher = new Agent({ connect: { rejectUnauthorized: false } });
    }
  }

  async post<T = unknown>(
    path: string,
    body: Record<string, unknown> = {},
  ): Promise<T & { trace_id?: string }> {
    return this.request<T>("POST", path, body);
  }

  /** GET — only KS auto-sync/status uses it; envelope handling identical to POST. */
  async get<T = unknown>(path: string): Promise<T & { trace_id?: string }> {
    return this.request<T>("GET", path);
  }

  private async request<T>(method: string, path: string, body?: Record<string, unknown>): Promise<T & { trace_id?: string }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout);
    try {
      const fetchOptions: RequestInit & { dispatcher?: Agent } = {
        method,
        headers: this.headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      };
      if (this.dispatcher) fetchOptions.dispatcher = this.dispatcher;
      const response = await fetch(`${this.endpoint}${path}`, fetchOptions as RequestInit);
      const responseText = await response.text().catch(() => "");
      const headerRequestId =
        response.headers.get("x-qcloud-transaction-id") ??
        response.headers.get("x-trace-id") ??
        "";

      let envelope: ApiResponseEnvelope<T>;
      try {
        envelope = JSON.parse(responseText) as ApiResponseEnvelope<T>;
      } catch {
        throw new TDAMError(
          response.ok ? -1 : response.status,
          responseText || `HTTP ${response.status} returned a non-JSON response`,
          headerRequestId,
        );
      }

      const businessCode = typeof envelope.code === "number" ? envelope.code : undefined;
      if (!response.ok || businessCode !== 0) {
        const code = businessCode && businessCode !== 0 ? businessCode : response.status;
        const details =
          envelope.data && typeof envelope.data === "object"
            ? (envelope.data as Record<string, unknown>)
            : undefined;
        throw new TDAMError(
          code,
          envelope.message || `HTTP ${response.status}`,
          headerRequestId || envelope.request_id || "",
          details,
        );
      }

      const result = (envelope.data ?? {}) as T & { trace_id?: string };
      const traceId = response.headers.get("x-trace-id");
      if (traceId && result && typeof result === "object") {
        (result as Record<string, unknown>).trace_id = traceId;
      }
      return result;
    } finally {
      clearTimeout(timer);
    }
  }
}
