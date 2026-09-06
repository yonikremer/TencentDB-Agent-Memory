import { describe, it, expect } from 'vitest';
import { mapHttpStatusFromEnvelopeCode } from '../../src/panel/kernel/envelope.js';
import { toKernelCredentials } from '../../src/panel/kernel/types.js';

describe('kernel envelope', () => {
  it('maps envelope codes to http status', () => {
    expect(mapHttpStatusFromEnvelopeCode(0)).toBe(200);
    expect(mapHttpStatusFromEnvelopeCode(400)).toBe(400);
    expect(mapHttpStatusFromEnvelopeCode(599)).toBe(599);
    expect(mapHttpStatusFromEnvelopeCode(301)).toBe(502);
    expect(mapHttpStatusFromEnvelopeCode(700)).toBe(502);
    expect(mapHttpStatusFromEnvelopeCode(-1)).toBe(502);
  });
});

describe('toKernelCredentials', () => {
  const ctx = {
    instanceId: 'i1',
    gatewayEndpoint: 'http://e',
    gatewayApiKey: 'k',
    userKey: 'uk',
    reqId: 'r1',
  };
  it('builds full credentials', () => {
    expect(toKernelCredentials(ctx, { timeoutMs: 100 })).toEqual({
      endpoint: 'http://e',
      apiKey: 'k',
      instanceId: 'i1',
      userKey: 'uk',
      timeoutMs: 100,
      requestId: 'r1',
    });
  });
  it('omits userKey when requested', () => {
    expect(toKernelCredentials(ctx, { timeoutMs: 100 }, { omitUserKey: true }).userKey).toBeUndefined();
  });
  it('works without userKey/reqId', () => {
    const c = toKernelCredentials({ instanceId: 'x', gatewayEndpoint: 'e', gatewayApiKey: 'k' }, { timeoutMs: 5 });
    expect(c.userKey).toBeUndefined();
    expect(c.requestId).toBeUndefined();
  });
});