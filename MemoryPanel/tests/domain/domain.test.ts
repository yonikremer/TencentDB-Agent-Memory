import { describe, it, expect } from 'vitest';
import { newExternalAssetId } from '../../src/panel/domain/asset-id.js';
import {
  DomainError,
  NotFoundError,
  ForbiddenError,
  ConflictError,
  CoreUpstreamError,
} from '../../src/panel/domain/errors.js';
import {
  MAX_IMPORTED_AGENTS,
  DEFAULT_CHAT_MEMORY_REL,
  validateImportedAgents,
  readChatMemoryRel,
  writeChatMemoryRel,
} from '../../src/panel/domain/chat-memory-governance.js';

describe('asset-id', () => {
  it('generates prefixed external asset ids for each type', () => {
    expect(newExternalAssetId('skill')).toMatch(/^skl-/);
    expect(newExternalAssetId('llm_wiki')).toMatch(/^wiki-/);
    expect(newExternalAssetId('code_graph')).toMatch(/^cg-/);
    expect(newExternalAssetId('chat_memory')).toMatch(/^mem-/);
  });
});

describe('errors', () => {
  it('DomainError sets defaults', () => {
    const e = new DomainError('boom', 'CODE');
    expect(e.message).toBe('boom');
    expect(e.code).toBe('CODE');
    expect(e.httpStatus).toBe(400);
    expect(e.name).toBe('DomainError');
  });
  it('DomainError accepts custom httpStatus', () => {
    const e = new DomainError('x', 'Y', 500);
    expect(e.httpStatus).toBe(500);
  });
  it('NotFoundError', () => {
    const e = new NotFoundError('user');
    expect(e.message).toBe('user not found');
    expect(e.code).toBe('NOT_FOUND');
    expect(e.httpStatus).toBe(404);
  });
  it('ForbiddenError defaults and custom', () => {
    expect(new ForbiddenError().message).toBe('forbidden');
    expect(new ForbiddenError('nope').httpStatus).toBe(403);
    expect(new ForbiddenError('nope').code).toBe('FORBIDDEN');
  });
  it('ConflictError', () => {
    const e = new ConflictError('dup');
    expect(e.code).toBe('CONFLICT');
    expect(e.httpStatus).toBe(409);
  });
  it('CoreUpstreamError', () => {
    const e = new CoreUpstreamError('CORE_UPSTREAM_ERROR', 502, 'up', 40001);
    expect(e.upstreamCode).toBe(40001);
    expect(e.httpStatus).toBe(502);
    expect(e.name).toBe('CoreUpstreamError');
  });
  it('CoreUpstreamError without upstreamCode', () => {
    const e = new CoreUpstreamError('C', 400, 'm');
    expect(e.upstreamCode).toBeUndefined();
  });
});

describe('chat-memory-governance', () => {
  const team = [{ agent_id: 'a1' }, { agent_id: 'a2' }, { agent_id: 'a3' }];

  it('exposes constants', () => {
    expect(MAX_IMPORTED_AGENTS).toBe(2);
    expect(DEFAULT_CHAT_MEMORY_REL).toEqual({ memory_shared_with_team: true, imported_agent_ids: [] });
  });

  it('validateImportedAgents ok', () => {
    expect(validateImportedAgents('self', ['a1'], team)).toEqual({ ok: true });
  });
  it('rejects non-array', () => {
    const r = validateImportedAgents('self', 'x' as any, team);
    expect(r.ok).toBe(false);
  });
  it('rejects too many', () => {
    expect(validateImportedAgents('self', ['a1', 'a2', 'a3'], team).ok).toBe(false);
  });
  it('rejects invalid id', () => {
    expect(validateImportedAgents('self', ['a1', ''], team).ok).toBe(false);
    expect(validateImportedAgents('self', ['a1', 5 as any], team).ok).toBe(false);
  });
  it('rejects self', () => {
    expect(validateImportedAgents('self', ['self'], team).ok).toBe(false);
  });
  it('rejects non-team member', () => {
    expect(validateImportedAgents('self', ['nope'], team).ok).toBe(false);
  });
  it('rejects duplicate', () => {
    expect(validateImportedAgents('self', ['a1', 'a1'], team).ok).toBe(false);
  });

  it('readChatMemoryRel returns default when missing', () => {
    expect(readChatMemoryRel({ agent_id: 'x' })).toEqual(DEFAULT_CHAT_MEMORY_REL);
  });
  it('readChatMemoryRel parses slot', () => {
    const agent = { agent_id: 'x', metadata_json: JSON.stringify({ chat_memory: { memory_shared_with_team: false, imported_agent_ids: ['a1', 'a1', 'a2', 'a3'] } }) };
    expect(readChatMemoryRel(agent)).toEqual({ memory_shared_with_team: false, imported_agent_ids: ['a1', 'a2'] });
  });
  it('readChatMemoryRel handles invalid json', () => {
    expect(readChatMemoryRel({ agent_id: 'x', metadata_json: 'not-json' })).toEqual(DEFAULT_CHAT_MEMORY_REL);
  });
  it('readChatMemoryRel handles slot not object', () => {
    expect(readChatMemoryRel({ agent_id: 'x', metadata_json: JSON.stringify({ chat_memory: 'str' }) })).toEqual(DEFAULT_CHAT_MEMORY_REL);
  });

  it('writeChatMemoryRel merges and normalizes', () => {
    const out = writeChatMemoryRel(JSON.stringify({ other: 1 }), { memory_shared_with_team: false, imported_agent_ids: ['a1', 'a1'] });
    const parsed = JSON.parse(out);
    expect(parsed.other).toBe(1);
    expect(parsed.chat_memory.imported_agent_ids).toEqual(['a1']);
    expect(parsed.chat_memory.memory_shared_with_team).toBe(false);
  });
  it('writeChatMemoryRel handles missing/invalid prev', () => {
    const out = writeChatMemoryRel(undefined, { memory_shared_with_team: true, imported_agent_ids: [] });
    expect(JSON.parse(out).chat_memory.memory_shared_with_team).toBe(true);
    const out2 = writeChatMemoryRel('bad-json', { memory_shared_with_team: true, imported_agent_ids: [1 as any, 'a1'] });
    expect(JSON.parse(out2).chat_memory.imported_agent_ids).toEqual(['a1']);
  });
});