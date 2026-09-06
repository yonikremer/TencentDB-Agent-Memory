import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { IngestProgressStore, DEFAULT_INGEST_PROGRESS_TTL_MS } from '../../src/panel/state/ingest-progress-store.js';
import { KnowledgeTaskRegistry } from '../../src/panel/state/knowledge-task-registry.js';
import { saveAgentTemplate, getAgentTemplate } from '../../src/panel/state/agent-template-store.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const P = (phase: 'extracting' | 'merging' | 'indexing', percent: number, completed = 0, failed = 0, skipped = 0) =>
  ({ phase, total: 10, completed, failed, skipped, percent });

describe('IngestProgressStore', () => {
  it('exposes default ttl', () => {
    expect(DEFAULT_INGEST_PROGRESS_TTL_MS).toBe(30 * 60 * 1000);
  });

  it('stores and reads', () => {
    const s = new IngestProgressStore();
    expect(s.get('w')).toBeNull();
    s.update('w', P('extracting', 10), 'r1');
    expect(s.get('w')).toEqual(P('extracting', 10));
  });

  it('monotonic phase progression and regression rejection', () => {
    const s = new IngestProgressStore();
    s.update('w', P('extracting', 90), 'r1');
    s.update('w', P('merging', 10), 'r1'); // higher phase wins
    expect(s.get('w').phase).toBe('merging');
    s.update('w', P('extracting', 99), 'r1'); // lower phase ignored
    expect(s.get('w').phase).toBe('merging');
  });

  it('percent monotonic and equal-percent completed tiebreak', () => {
    const s = new IngestProgressStore();
    s.update('w', P('extracting', 50, 5), 'r1');
    s.update('w', P('extracting', 40, 5), 'r1'); // lower percent ignored
    expect(s.get('w').completed).toBe(5);
    s.update('w', P('extracting', 50, 6), 'r1'); // equal percent, higher done
    expect(s.get('w').completed).toBe(6);
    s.update('w', P('extracting', 50, 4), 'r1'); // equal percent, lower done ignored
    expect(s.get('w').completed).toBe(6);
  });

  it('new runId overwrites', () => {
    const s = new IngestProgressStore();
    s.update('w', P('extracting', 5), 'r1');
    s.update('w', P('extracting', 5), 'r2'); // different runId → overwrite
    expect(s.get('w').percent).toBe(5);
  });

  it('upgrade path: no runId then has runId', () => {
    const s = new IngestProgressStore();
    s.update('w', P('extracting', 5), null);
    s.update('w', P('extracting', 6), 'r1');
    expect(s.get('w').percent).toBe(6);
  });

  it('no-runId package after upgrade rejected when percent lower', () => {
    const s = new IngestProgressStore();
    s.update('w', P('extracting', 50), null);
    s.update('w', P('extracting', 50), 'r1');
    s.update('w', P('extracting', 10), null); // lower percent → rejected
    expect(s.get('w').percent).toBe(50);
  });

  it('clear rejects late packages of same generation and no-runId', () => {
    const s = new IngestProgressStore();
    s.update('w', P('extracting', 50), 'r1');
    s.clear('w', 'r1');
    expect(s.get('w')).toBeNull();
    s.update('w', P('indexing', 98), 'r1'); // rejected (cleared generation)
    expect(s.get('w')).toBeNull();
    s.update('w', P('extracting', 0), 'r2'); // new generation allowed
    expect(s.get('w')).not.toBeNull();
  });

  it('clear with no rid uses prev runId and clears no-runId after', () => {
    const s = new IngestProgressStore();
    s.update('w', P('extracting', 50), 'r1');
    s.clear('w');
    s.update('w', P('extracting', 1)); // no rid, cleared → rejected
    expect(s.get('w')).toBeNull();
  });

  it('clear without any runId does not block future writes', () => {
    const s = new IngestProgressStore();
    s.update('w', P('extracting', 5), null);
    s.clear('w'); // no runId anywhere
    s.update('w', P('extracting', 6), null);
    expect(s.get('w').percent).toBe(6);
  });

  it('expires entries', () => {
    let now = 1000;
    const s = new IngestProgressStore({ ttlMs: 100, now: () => now });
    s.update('w', P('extracting', 5));
    now = 1200; // expired
    expect(s.get('w')).toBeNull();
  });

  it('new entry after expiration overwrites', () => {
    let now = 1000;
    const s = new IngestProgressStore({ ttlMs: 100, now: () => now });
    s.update('w', P('extracting', 5));
    now = 1200;
    s.update('w', P('merging', 5)); // prev expired → overwrite directly
    expect(s.get('w').phase).toBe('merging');
  });

  it('pruneCleared removes old cleared entries', () => {
    let now = 1000;
    const s = new IngestProgressStore({ ttlMs: 100, now: () => now });
    s.update('w', P('extracting', 5), 'r1');
    s.clear('w', 'r1');
    now = 1300;
    s.update('w2', P('extracting', 5), 'r2'); // triggers pruneCleared across all keys
    expect(s.get('w2')).not.toBeNull();
  });
});

describe('KnowledgeTaskRegistry', () => {
  const task = (id: string, created = Date.now()) => ({
    knowledge_id: id, type: 'code-graph' as const, team_id: 't', owner_user_id: 'u',
    owner_user_key: 'k', service_id: 's', created_at: created,
  });

  it('record/peek/take/size', () => {
    const r = new KnowledgeTaskRegistry();
    expect(r.size()).toBe(0);
    r.record(task('k1'));
    expect(r.size()).toBe(1);
    expect(r.peek('k1')).toBeTruthy();
    expect(r.take('k1')).toBeTruthy();
    expect(r.take('k1')).toBeUndefined();
    expect(r.size()).toBe(0);
  });

  it('sweep removes expired', () => {
    const r = new KnowledgeTaskRegistry(100);
    r.record(task('k1', 0));
    r.record(task('k2', Date.now()));
    r.sweep(500);
    expect(r.peek('k1')).toBeUndefined();
    expect(r.take('k2')).toBeTruthy();
  });

  it('custom ttl expires old task on peek', () => {
    const r = new KnowledgeTaskRegistry(50);
    r.record(task('k1', 0));
    expect(r.peek('k1')).toBeUndefined();
  });
});

describe('agent-template-store', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'tpl-')); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('save and get roundtrip', () => {
    saveAgentTemplate(dir, 'i1', 'team1', { name: 'tpl', description: 'd', prompt: 'p', visibility: 'team', metadata_json: '{}', asset_ids: { skills: ['s1'] } });
    const got = getAgentTemplate(dir, 'i1', 'team1');
    expect(got?.name).toBe('tpl');
    expect(got?.asset_ids?.skills).toEqual(['s1']);
  });

  it('get returns null on missing', () => {
    expect(getAgentTemplate(dir, 'i1', 'team1')).toBeNull();
  });

  it('invalid teamId throws on save and get', () => {
    expect(() => saveAgentTemplate(dir, 'i1', '../evil', { name: 'x' })).toThrow(/invalid team_id/);
    expect(() => getAgentTemplate(dir, 'i1', 'a/b')).toThrow(/invalid team_id/);
  });
});