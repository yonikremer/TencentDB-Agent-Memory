import { describe, it, expect } from 'vitest';
import { router, routes } from '@/routes';
import { WikiPage } from '@/pages/WikiPage';
import { CodePage } from '@/pages/CodePage';
import { SkillsPage } from '@/pages/SkillsPage';
import { ChatMemoryPage } from '@/pages/ChatMemoryPage';
import { NotFoundPage } from '@/pages/NotFoundPage';

function flatten(rs: typeof routes, out: { path?: string; el?: unknown }[] = []) {
  for (const r of rs) {
    out.push({ path: r.path, el: (r as { element?: unknown }).element });
    if (r.children) flatten(r.children, out);
  }
  return out;
}

describe('route table', () => {
  const flat = flatten(routes);
  const paths = flat.map((r) => r.path);

  it.each([
    'wiki/:wikiId',
    'wiki/:wikiId/:wikiTab',
    'code/:codeId',
    'skills/:skillId',
    'memory/:blockId',
    'memory/:blockId/:layer',
    '*',
  ])('declares deep link %s', (p) => {
    expect(paths).toContain(p);
  });

  it.each([
    ['wiki/:wikiId', WikiPage],
    ['wiki/:wikiId/:wikiTab', WikiPage],
    ['code/:codeId', CodePage],
    ['skills/:skillId', SkillsPage],
    ['memory/:blockId', ChatMemoryPage],
    ['memory/:blockId/:layer', ChatMemoryPage],
    ['*', NotFoundPage],
  ] as const)('%s renders %s', (path, comp) => {
    const el = flat.find((r) => r.path === path)?.el as { type?: unknown };
    expect(el?.type).toBe(comp);
  });

  it('uses browser history (no hash URLs)', async () => {
    await router.navigate('/wiki/w1/overview');
    expect(window.location.pathname).toBe('/wiki/w1/overview');
    expect(window.location.hash).toBe('');
    await router.navigate('/');
  });

  it('matches unknown ids to the 404 route', async () => {
    await router.navigate('/wiki/does-not-exist');
    expect(router.state.matches.at(-1)?.route.path).toBe('wiki/:wikiId');
    await router.navigate('/totally-unknown-xyz');
    expect(router.state.matches.at(-1)?.route.path).toBe('*');
    await router.navigate('/');
  });
});
