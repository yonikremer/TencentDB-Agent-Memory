/**
 * ConsoleLayout — Main layout shell.
 *
 * Tea-component-based `Layout` + `Menu` components, including business logic such as TabBar, routing, and menu filtering.
 */
import { useEffect, useMemo, useState, useCallback } from 'react';
import { Outlet, useNavigate, useLocation } from 'react-router-dom';
import { Layout, Menu } from 'tea-component';
import { useTranslation } from 'react-i18next';
import { useAuthStore } from '@/stores/auth';
import { useCurrentRole, type TeamRole } from '@/services/useCurrentRole';
import { GlobalHeader } from '@/layouts/GlobalHeader';
import { TabBar } from '@/layouts/TabBar';
import { OnboardingGuide, shouldShowOnboarding, resetOnboarding } from '@/layouts/OnboardingGuide';
import { ITEM_ICON, usePageMeta, GROUP_ORDER_KEYS, type PageId } from '@/constants/menu';

const { Body, Sider, Content } = Layout;

/** Route path → PageId */
const PATH_TO_PAGE: Record<string, PageId> = {
  '/': 'workbench_board',
  '/wiki': 'wiki',
  '/code': 'code',
  '/skills': 'skills',
  '/memory': 'chat_memory',
  '/team/members': 'team_members',
  '/team/agents': 'team_agents',
  '/team/api-keys': 'api_keys',
};

/** PageId → route path */
const PAGE_TO_PATH: Record<PageId, string> = Object.fromEntries(
  Object.entries(PATH_TO_PAGE).map(([path, id]) => [id, path]),
) as Record<PageId, string>;

function legacyHashToPath(): string | null {
  const raw = window.location.hash.replace(/^#\/?/, '');
  const leaf = raw.split('/').filter(Boolean).pop();
  if (!leaf) return null;
  if (leaf === 'wiki') return '/wiki';
  if (leaf === 'code') return '/code';
  if (leaf === 'skills' || leaf === 'skill') return '/skills';
  if (leaf === 'chat_memory' || leaf === 'memory' || leaf === 'chat-memory') return '/memory';
  if (leaf === 'agents' || leaf === 'team_agents') return '/team/agents';
  if (leaf === 'team' || leaf === 'members' || leaf === 'team_members') return '/team/members';
  if (leaf === 'api_keys' || leaf === 'apikey' || leaf === 'api-keys') return '/team/api-keys';
  return null;
}

export function ConsoleLayout() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const { auth, logout } = useAuthStore();
  const userRole: TeamRole | null = useCurrentRole();
  const PAGE_META = usePageMeta();

  const activePage: PageId = useMemo(() => {
    const match = Object.entries(PATH_TO_PAGE).find(
      ([path]) => path !== '/' && location.pathname.startsWith(path),
    );
    return match ? match[1] : 'workbench_board';
  }, [location.pathname]);

  useEffect(() => {
    const legacyPath = legacyHashToPath();
    if (legacyPath && legacyPath !== location.pathname) {
      navigate(legacyPath, { replace: true });
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // The usage instructions page is an independent page (with its own back button and header), and does not occupy the multi-tab bar
  const isGuide = location.pathname === '/guide';

  const [openPages, setOpenPages] = useState<PageId[]>(() => (isGuide ? [] : [activePage]));

  useEffect(() => {
    // /guide does not append pages such as workbench_board into the tab bar, to avoid extra tabs when returning
    if (isGuide) return;
    setOpenPages((prev) => (prev.includes(activePage) ? prev : [...prev, activePage]));
  }, [activePage, isGuide]);

  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

  // First-time usage guidance: automatically pops up after login, judged as "once per user only"
  const currentUserId = auth?.user_id;
  const [onboardingVisible, setOnboardingVisible] = useState(false);
  useEffect(() => {
    if (currentUserId && shouldShowOnboarding(currentUserId)) {
      setOnboardingVisible(true);
    }
  }, [currentUserId]);

  /**
   * Review entry (triggered by the "My Profile → Review Guide" menu item in GlobalHeader):
   * Clear the onboarded flag and re-show the Guide.
   * The flag must be cleared before setVisible, otherwise the Guide's internal close→markOnboarded chain
   * will immediately re-mark it as viewed (though there is no conflict this time, next time's automatic judgment will still treat it as "viewed").
   */
  const handleReplayOnboarding = useCallback(() => {
    if (!currentUserId) return;
    resetOnboarding(currentUserId);
    setOnboardingVisible(true);
  }, [currentUserId]);

  // GuidePage bottom "Guide Replay" is triggered via a custom event to match the "My Profile → Review Guide" flow
  useEffect(() => {
    const onReplay = () => handleReplayOnboarding();
    window.addEventListener('tdai-replay-onboarding', onReplay);
    return () => window.removeEventListener('tdai-replay-onboarding', onReplay);
  }, [handleReplayOnboarding]);

  const navigateTo = useCallback(
    (id: PageId) => {
      const path = PAGE_TO_PATH[id];
      if (path) navigate(path);
    },
    [navigate],
  );

  const closePage = useCallback(
    (id: PageId) => {
      setOpenPages((prev) => {
        const next = prev.filter((p) => p !== id);
        if (id === activePage && next.length > 0) {
          navigateTo(next[next.length - 1]);
        }
        return next;
      });
    },
    [activePage, navigateTo],
  );

  // ===== Menu Filter Based on team role =====
  // admin can access all pages (including resource management)
  // "Member Management" item: reviewer cannot see it
  const menuGroups = useMemo(() => {
    const byGroup = new Map<string, (typeof PAGE_META)[PageId][]>();

    for (const meta of Object.values(PAGE_META)) {
      if (userRole === 'reviewer' && meta.id === 'team_members') continue;
      const list = byGroup.get(meta.group) ?? [];
      list.push(meta);
      byGroup.set(meta.group, list);
    }

    return GROUP_ORDER_KEYS.map((key) => t(`menu.group.${key}`))
      .filter((g) => byGroup.has(g))
      .map((g) => ({
        title: g,
        items: byGroup.get(g)!.sort((a, b) => a.order - b.order),
      }));
  }, [userRole, PAGE_META, t]);

  const workbenchGroupTitle = t('menu.group.workbench');
  const pinnedGroup = menuGroups.find((g) => g.title === workbenchGroupTitle);
  const restGroups = menuGroups.filter((g) => g.title !== workbenchGroupTitle);

  const renderMenuItem = (item: (typeof PAGE_META)[PageId]) => {
    const isActive = activePage === item.id;
    return (
      <Menu.Item
        key={item.id}
        title={item.label}
        icon={ITEM_ICON[item.id]}
        selected={isActive}
        onClick={() => navigateTo(item.id)}
      />
    );
  };

  return (
    <div className="_memory-app-shell">
      <OnboardingGuide
        visible={onboardingVisible}
        userId={currentUserId}
        userRole={userRole}
        onClose={() => setOnboardingVisible(false)}
      />
      <GlobalHeader
        userRole={userRole}
        currentUser={auth?.user ?? ''}
        currentUserId={auth?.user_id}
        instanceName={auth?.instance_name}
        onReplayOnboarding={currentUserId ? handleReplayOnboarding : undefined}
        onLogout={logout}
      />
      <Layout>
        <Body>
          <Sider>
            {/* The brand is already displayed in the global Header, and the sidebar only carries navigation (consistent with the shared shell of the Memory project). */}
            <Menu collapsable collapsed={sidebarCollapsed} onCollapsedChange={setSidebarCollapsed}>
              {pinnedGroup?.items.map((item) => renderMenuItem(item))}
              {restGroups.map((group) => (
                <Menu.Group key={group.title} title={group.title}>
                  {group.items.map((item) => renderMenuItem(item))}
                </Menu.Group>
              ))}
            </Menu>
          </Sider>
          <Content>
            {!isGuide && (
              <TabBar
                pages={openPages}
                activePage={activePage}
                onNavigate={navigateTo}
                onClose={closePage}
              />
            )}
            <Content.Body className="_memory-content-body">
              {/* key binding pathname: remount page frames on route switching, trigger _page-enter transition, maintain cross-page continuity */}
              <main key={location.pathname} className="_memory-page-frame">
                <Outlet />
              </main>
            </Content.Body>
          </Content>
        </Body>
      </Layout>
    </div>
  );
}
 