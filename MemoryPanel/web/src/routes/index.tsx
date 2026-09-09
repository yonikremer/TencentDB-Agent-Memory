/**
 * Route table definition
 *
 * BrowserRouter with deep-linkable asset URLs, so browser back/forward
 * move through list → detail → tab instead of staying on one hash URL.
 *
 * Scheme:
 *   /wiki /wiki/:wikiId /wiki/:wikiId/:wikiTab(overview|graph|pages|search)
 *   /code /code/:codeId
 *   /skills /skills/:skillId
 *   /memory /memory/:blockId /memory/:blockId/:layer(L0|L1|L2|L3)
 *
 * Server fallback lives in MemoryPanel/src/panel/http/app.ts — non-/api
 * paths serve index.html, so refresh on a deep link never 404s at HTTP.
 * Unknown asset ids render the in-app <NotFoundPage/> (HTTP 200 shell, 404 UI).
 */
import { createBrowserRouter, type RouteObject } from 'react-router-dom';
import { ConsoleLayout } from '@/layouts/ConsoleLayout';
import { WorkbenchPage } from '@/pages/WorkbenchPage';
import { WikiPage } from '@/pages/WikiPage';
import { CodePage } from '@/pages/CodePage';
import { SkillsPage } from '@/pages/SkillsPage';
import { ChatMemoryPage } from '@/pages/ChatMemoryPage';
import { MembersPage } from '@/pages/MembersPage';
import { AgentsPage } from '@/pages/AgentsPage';
import { ApiKeysPage } from '@/pages/ApiKeysPage';
import { GuidePage } from '@/pages/GuidePage';
import { NotFoundPage } from '@/pages/NotFoundPage';

export const routes: RouteObject[] = [
  {
    path: '/',
    element: <ConsoleLayout />,
    children: [
      { index: true, element: <WorkbenchPage /> },
      { path: 'wiki', element: <WikiPage /> },
      { path: 'wiki/:wikiId', element: <WikiPage /> },
      { path: 'wiki/:wikiId/:wikiTab', element: <WikiPage /> },
      { path: 'code', element: <CodePage /> },
      { path: 'code/:codeId', element: <CodePage /> },
      { path: 'skills', element: <SkillsPage /> },
      { path: 'skills/:skillId', element: <SkillsPage /> },
      { path: 'memory', element: <ChatMemoryPage /> },
      { path: 'memory/:blockId', element: <ChatMemoryPage /> },
      { path: 'memory/:blockId/:layer', element: <ChatMemoryPage /> },
      { path: 'team/members', element: <MembersPage /> },
      { path: 'team/agents', element: <AgentsPage /> },
      { path: 'team/api-keys', element: <ApiKeysPage /> },
      { path: 'guide', element: <GuidePage /> },
      { path: '*', element: <NotFoundPage /> },
    ],
  },
];

export const router = createBrowserRouter(routes);
