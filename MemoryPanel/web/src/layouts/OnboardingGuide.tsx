/**
 * OnboardingGuide — First-time Usage Guide (Tea Guide Component Version)
 *
 * Use the `Guide` component from tea-component to progressively highlight page elements, replacing the old full-screen two-column guide.
 *
 * Dual-role SOP (automatically jumps to the corresponding page when switching steps, not just displaying):
 *   - Admin: Login identity → Create/Switch team → Create member and issue user_key → Agent → Click Agent to bind assets → Four asset pages
 *   - Member: Login identity → Invite members → Agent → Click Agent to bind assets → User_Key management → Four asset pages
 *
 * The Agent / asset operation capabilities of Admin and Member are consistent (both can edit); the only difference lies in member management:
 * member cannot create user accounts, but can only invite existing users by user_id; admin can create new users and issue
 * user_key, and can also create new teams. The asset steps are sequentially navigated to the Wiki / Code / Skill / Chat Memory pages for introduction.
 *
 * Robustness: if the element selector for each step is missing on the target page (e.g., members lack the "Add Member" permission),
 * Automatically fallback to the global Header brand area to prevent Guide from disappearing entirely due to missing elements.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Guide, type GuideStep } from 'tea-component';

const STORAGE_PREFIX = 'tdai-panel.onboarded';

/** Global anchor element that always exists (Header brand area), used as a fallback when the target element is missing */
const FALLBACK_SELECTOR = '._memory-global-header-brand';

/** localStorage key for "seen onboarding" per user dimension */
function onboardedKey(userId?: string): string {
  return `${STORAGE_PREFIX}.${userId || 'anonymous'}`;
}

/** Whether to automatically pop up a guide (unmarked = first time) */
export function shouldShowOnboarding(userId?: string): boolean {
  try {
    return window.localStorage.getItem(onboardedKey(userId)) !== '1';
  } catch {
    // No disturbance to users when localStorage is unavailable
    return false;
  }
}

/**
 * Reset the "Guide Already Viewed" marker.
 *
 * User manually triggers in "My Profile → Review Guide": clears the onboarded flag, and it will pop up again automatically next time entering the main panel.
 * useEffect detects shouldShowOnboarding() === true and will pop up again automatically.
 *
 * Note: The caller also needs to set OnboardingGuide's visible back to true, because the previous close()
 * has advanced the internal current to -1 and called onClose; merely clearing the flag is not enough to reopen.
 */
export function resetOnboarding(userId?: string): void {
  try {
    window.localStorage.removeItem(onboardedKey(userId));
  } catch {
    /* Silently ignore when localStorage is unavailable */
  }
}

function markOnboarded(userId?: string): void {
  try {
    window.localStorage.setItem(onboardedKey(userId), '1');
  } catch {
    /* Silently ignore when localStorage is unavailable */
  }
}

interface OnboardingStep {
  /** Target route: automatically redirect when switching steps (omitted means stay on the current page) */
  path?: string;
  /**
   * Selector for elements to highlight. Supports ordered fallback for arrays (e.g., prioritize highlighting the "Add Member" button for "admin",
   * and fall back to the member list area when the button does not exist), and finally falls back to the Header brand area when all are missing.
   */
  selector: string | string[];
  placement?: GuideStep['placement'];
  titleKey: string;
  descKey: string;
}

/** Return the first matching element in order, return null if not found */
function firstMatch(selectors: string[]): Element | null {
  for (const sel of selectors) {
    const el = document.querySelector(sel);
    if (el) return el;
  }
  return null;
}

/** Parse the highlighted elements of the parsing step; fall back in order when the target element is missing, ultimately falling back to the global Header brand area, ensuring Guide is always renderable */
function resolveElement(selector: string | string[]): Element {
  const list = Array.isArray(selector) ? selector : [selector];
  return firstMatch(list) || document.querySelector(FALLBACK_SELECTOR) || document.body;
}

/**
 * Dynamically calculate the bubble expansion direction based on the element's actual position in the viewport:
 *   - Horizontal: if the element's center is in the left half of the screen → expand to the right (*-start); if in the right half → expand to the left (*-end)
 *   - Vertical: if the element's center is in the upper half of the screen → expand downward (bottom-*); if in the lower half → expand upward (top-*)
 * This ensures that the bubble always expands toward the center of the viewport, so no element on any page or at any position will be pushed out of the screen.
 */
function computePlacement(
  selector: string | string[],
  fallback: GuideStep['placement'],
): GuideStep['placement'] {
  const list = Array.isArray(selector) ? selector : [selector];
  const el = firstMatch(list);
  // When elements are missing (page does not jump/render), direction cannot be inferred by position, so directly use the preset safe direction.
  // Absolutely do not fallback to body calculation: the body rect height is far larger than the viewport, so cy must be greater than innerHeight/2,
  // which will calculate top-* to position the bubble outside the screen (the root cause of "the box exceeds the screen and cannot be clicked").
  if (!el) return fallback;
  const rect = el.getBoundingClientRect();
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  const horizontal = cx < window.innerWidth / 2 ? 'start' : 'end';
  const vertical = cy < window.innerHeight / 2 ? 'bottom' : 'top';
  const placement = `${vertical}-${horizontal}`;
  if (
    placement === 'bottom-start' ||
    placement === 'bottom-end' ||
    placement === 'top-start' ||
    placement === 'top-end'
  ) {
    return placement;
  }
  return fallback;
}

/**
 * Click Agent to enter the asset binding guidance step of the edit popup (shared by Admin / Member,
 * Follows the "New Agent" step, switches on the same page without navigation).
 * Three-level anchor fallback:
 * 1. Card view: select the entire card of the first editable Agent;
 * 2. List view (no cards): fall back to the name button of the editable Agent;
 * 3. User has no Agents yet: fall back to the "New Agent" button,
 *      and show a hint like "create an Agent first, then come back and click it".
 */
const AGENT_BIND_STEP: OnboardingStep = {
  path: '/team/agents',
  selector: [
    '[data-guide="agent-card-editable"]',
    '[data-guide="agent-name-editable"]',
    '[data-guide="create-agent"]',
  ],
  placement: 'bottom-start',
  titleKey: 'onboarding.guide.agentBind.title',
  descKey: 'onboarding.guide.agentBind.desc',
};

/** Each asset page's guided entry steps for introduction (Wiki / Code / Skill / Chat Memory) */
const ASSET_STEPS: OnboardingStep[] = [
  {
    path: '/wiki',
    // Prioritize the "New Wiki" button; when the button is missing (fixed assets tab / no team), fall back to the top Wiki tab,
    // rather than falling back to the logo, to avoid misboxing the area.
    selector: ['[data-guide="create-wiki"]', '[data-guide="tab-wiki"]'],
    // ActionPanel left "New Wiki" button: expand to the right
    placement: 'bottom-start',
    titleKey: 'onboarding.guide.asset.wiki.title',
    descKey: 'onboarding.guide.asset.wiki.desc',
  },
  {
    path: '/code',
    // Prioritize the "Register Repository" button; fall back to the top Code tab if the button is missing.
    selector: ['[data-guide="create-code"]', '[data-guide="tab-code"]'],
    // ActionPanel left "Register Repository" button: expand to the right
    placement: 'bottom-start',
    titleKey: 'onboarding.guide.asset.code.title',
    descKey: 'onboarding.guide.asset.code.desc',
  },
  {
    path: '/skills',
    selector: '[data-guide="import-skill"]',
    // "Import Skill" button on the right side of actions in the header (consistent with Memory): expand to the left
    placement: 'bottom-end',
    titleKey: 'onboarding.guide.asset.skill.title',
    descKey: 'onboarding.guide.asset.skill.desc',
  },
  {
    path: '/memory',
    selector: '[data-guide="import-memory"]',
    // Right "Import Memory" button: expands to the left
    placement: 'bottom-end',
    titleKey: 'onboarding.guide.asset.memory.title',
    descKey: 'onboarding.guide.asset.memory.desc',
  },
];

function buildSteps(role: 'admin' | 'member'): OnboardingStep[] {
  const loginStep: OnboardingStep = {
    selector: '._memory-global-header-user-btn',
    // header top-right user button: use bottom-end to align the bubble's right edge with the element's right edge, expand to the left,
    // to avoid the "next" button being cut off by the bubble in narrow viewports
    placement: 'bottom-end',
    titleKey: 'onboarding.guide.login.title',
    descKey: 'onboarding.guide.login.desc',
  };

  // Admin and Member Agent / asset operation capabilities are consistent (both can edit), only member management differs:
  //   - admin: can create teams, create users and issue user_key (member has no such permission)
  //   - member: can only invite existing users to join the team by user_id; but can manage their own User_Key (admin has no such entry)
  // placement selection: right-side elements use bottom-end (expand to the left), left-side elements use bottom-start (expand to the right)
  if (role === 'admin') {
    return [
      loginStep,
      {
        selector: '._memory-team-switcher-trigger',
        // header top-left: expand leftward to avoid rightward overflow
        placement: 'bottom-start',
        titleKey: 'onboarding.guide.team.title',
        descKey: 'onboarding.guide.team.desc',
      },
      {
        path: '/team/members',
        // Prioritize highlighting the "Add Member" button; when there is no team, the button does not exist, so fall back to the member list area
        selector: ['[data-guide="add-member"]', '[data-guide="members-list"]'],
        placement: 'bottom-end',
        titleKey: 'onboarding.guide.memberAdmin.title',
        descKey: 'onboarding.guide.memberAdmin.desc',
      },
      {
        path: '/team/agents',
        selector: '[data-guide="create-agent"]',
        // ActionPanel left "New Agent" button: expand to the right
        placement: 'bottom-start',
        titleKey: 'onboarding.guide.agent.title',
        descKey: 'onboarding.guide.agent.desc',
      },
      AGENT_BIND_STEP,
      ...ASSET_STEPS,
    ];
  }

  return [
    loginStep,
    {
      path: '/team/members',
      //  Regular members do not have an "Add Member" button (only visible to admin/teamAdmin),
      //  so the member list area that always exists is highlighted to avoid falling back to the header, causing "no jump/incorrect positioning"
      selector: '[data-guide="members-list"]',
      placement: 'bottom-start',
      titleKey: 'onboarding.guide.member.title',
      descKey: 'onboarding.guide.member.desc',
    },
    {
      path: '/team/agents',
      selector: '[data-guide="create-agent"]',
      // ActionPanel left "New Agent" button: expand to the right
      placement: 'bottom-start',
      titleKey: 'onboarding.guide.agent.title',
      descKey: 'onboarding.guide.agent.desc',
    },
    AGENT_BIND_STEP,
    {
      path: '/team/api-keys',
      selector: '[data-guide="create-key"]',
      // Justify the "New Key" button on the right: expand to the left
      placement: 'bottom-end',
      titleKey: 'onboarding.guide.apikey.title',
      descKey: 'onboarding.guide.apikey.desc',
    },
    ...ASSET_STEPS,
  ];
}

export function OnboardingGuide({
  visible,
  userId,
  userRole,
  onClose,
}: {
  visible: boolean;
  userId?: string;
  userRole: 'admin' | 'member' | 'reviewer' | null;
  /** Close the guide (whether "skip" or "complete" is marked as viewed) */
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();

  const isAdmin = userRole === 'admin';
  const steps = useMemo(() => buildSteps(isAdmin ? 'admin' : 'member'), [isAdmin]);

  const [current, setCurrent] = useState(-1);
  const pendingRef = useRef<number | null>(null);

  /**
   * Animation alignment strategy (replaces the old "hide → show" gating, eliminating the blank window without an overlay):
   *   - Same-page switch: The bubble (popper transform) and highlight box (top/left/width/height) with
   *     CSS transition, smoothly sliding to the new position with the smooth scroll of scrollIntoView, fully visible throughout;
   *   - Cross-page switch: The old anchor will be unloaded with the page (popper will position to 0,0 for detached elements),
   *     fadeOut first → jump → after the new anchor is ready, instantly settle in with no-anim → fadeIn.
   */
  const fadeOut = useCallback(() => {
    document.body.classList.add('_guide-fading');
  }, []);

  /** Fade in after the first frame of the new step is positioned (double rAF: wait for React commit + popper positioning) */
  const fadeIn = useCallback(() => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        document.body.classList.remove('_guide-fading');
        document.body.classList.remove('_guide-no-anim');
      });
    });
  }, []);

  // Clean up global class when uninstalling
  useEffect(() => {
    return () => {
      document.body.classList.remove('_guide-fading');
      document.body.classList.remove('_guide-no-anim');
    };
  }, []);

  const close = useCallback(() => {
    markOnboarded(userId);
    pendingRef.current = null;
    document.body.classList.remove('_guide-fading');
    document.body.classList.remove('_guide-no-anim');
    setCurrent(-1);
    onClose();
  }, [userId, onClose]);

  // Step switching: finish/cancel closes directly; next/back/start first navigates to the target page,
  // then advances current after the target path matches and the element appears (to avoid Guide crashing due to missing elements).
  const handleCurrentChange = useCallback(
    (next: number, context: { from: 'start' | 'back' | 'next' | 'finish' | 'cancel' }) => {
      const { from } = context;
      if (from === 'finish' || from === 'cancel') {
        close();
        return;
      }
      if (next < 0 || next >= steps.length) return;
      const target = steps[next];
      if (!target) return;
      if (target.path && target.path !== location.pathname) {
        // Cross-page navigation: first fade out (cover the "anchor unload → new page load" window), fade in after pending completes
        fadeOut();
        pendingRef.current = next;
        navigate(target.path);
      } else {
        // Page switch: advance directly, align position transition and scroll animation, slide smoothly
        setCurrent(next);
      }
    },
    [steps, location.pathname, navigate, close, fadeOut],
  );

  // Wait for jump to complete: poll for the target element to appear after path matching, then advance current (wait up to 60 frames or about 1s)
  useEffect(() => {
    const pending = pendingRef.current;
    if (pending === null) return;
    const target = steps[pending];
    if (!target || !target.path) return;
    if (location.pathname !== target.path) return;

    let cancelled = false;
    let tries = 0;
    const tick = () => {
      if (cancelled) return;
      // selector may be a fallback array: any element appearing means the target page is ready
      const list = Array.isArray(target.selector) ? target.selector : [target.selector];
      if (firstMatch(list) || tries >= 60) {
        pendingRef.current = null;
        // New anchor instantly settles (no-anim disables transitions to avoid sliding in from the old position), then fades in
        document.body.classList.add('_guide-no-anim');
        setCurrent(pending);
        fadeIn();
        return;
      }
      tries += 1;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    return () => {
      cancelled = true;
    };
  }, [location.pathname, steps, fadeIn]);

  // Initial display: disable transitions before popper's first frame positioning (to avoid bubbles sliding in from (0,0)), enable after positioning is complete
  useEffect(() => {
    if (!visible) return;
    document.body.classList.add('_guide-no-anim');
    const timer = window.setTimeout(() => {
      document.body.classList.remove('_guide-no-anim');
    }, 50);
    return () => {
      window.clearTimeout(timer);
      document.body.classList.remove('_guide-no-anim');
    };
  }, [visible]);
  const guideSteps: GuideStep[] = useMemo(
    () =>
      steps.map((s) => ({
        element: () => resolveElement(s.selector),
        placement: computePlacement(s.selector, s.placement),
        title: t(s.titleKey),
        description: t(s.descKey),
      })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [steps, t, current, visible],
  );

  const startContent: GuideStep = useMemo(
    () => ({
      element: () => resolveElement(FALLBACK_SELECTOR),
      // Welcome page highlights header brand area: dynamically calculates direction based on actual position
      placement: computePlacement(FALLBACK_SELECTOR, 'bottom-start'),
      title: t(
        isAdmin ? 'onboarding.guide.start.admin.title' : 'onboarding.guide.start.member.title',
      ),
      description: t(
        isAdmin ? 'onboarding.guide.start.admin.desc' : 'onboarding.guide.start.member.desc',
      ),
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [isAdmin, t, visible],
  );

  // ===== Custom Precise Highlight Layer =====
  // tea Guide built-in mask is positioned based on react-popper: within the internal scroll container (tea-layout__content)
  // There is a fixed offset (about 3~5px) below, and it does not update with scrolling (the offset is further enlarged after scrolling), causing the highlight box
  // "Edge leak". Here we use getBoundingClientRect to calculate in real time (capture listens for internal container scrolling +
  // resize, and hide the Guide's built-in mask with global CSS (see index.css `.tea-overlay[style*="z-index: 9999"]`).
  const anchorSelector =
    current >= 0 && steps[current] ? steps[current].selector : FALLBACK_SELECTOR;
  const [anchorBox, setAnchorBox] = useState<{
    top: number;
    left: number;
    width: number;
    height: number;
  } | null>(null);

  useEffect(() => {
    if (!visible) {
      setAnchorBox(null);
      return;
    }
    const update = () => {
      const el = resolveElement(anchorSelector);
      if (!el || el === document.body) return;
      const r = el.getBoundingClientRect();
      setAnchorBox({ top: r.top, left: r.left, width: r.width, height: r.height });
    };
    update();
    // At the moment of step switching, the Guide's scrollIntoView(smooth) animation may not have ended yet,
    // so immediately measuring would capture the mid-animation position; use rAF + delay as a fallback to correct it after the layout stabilizes.
    const raf = requestAnimationFrame(update);
    const late = window.setTimeout(update, 400);
    // capture phase listener, can capture scroll events of internal scroll containers (non-window)
    const onScrollOrResize = () => requestAnimationFrame(update);
    window.addEventListener('scroll', onScrollOrResize, true);
    window.addEventListener('resize', onScrollOrResize);
    // Layout changes caused by data loading also move anchors (ResizeObserver covers more comprehensively than resize events)
    const ro = new ResizeObserver(() => requestAnimationFrame(update));
    ro.observe(document.body);
    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(late);
      window.removeEventListener('scroll', onScrollOrResize, true);
      window.removeEventListener('resize', onScrollOrResize);
      ro.disconnect();
    };
  }, [visible, anchorSelector]);

  return (
    <>
      <Guide
        visible={visible}
        steps={guideSteps}
        startContent={startContent}
        current={current}
        onCurrentChange={handleCurrentChange}
        showBackButton
        showDot
        nextButtonTheme="primary"
        cancelText={t('onboarding.skip')}
        backText={t('onboarding.prev')}
        nextText={t('onboarding.next')}
        finishText={t('onboarding.finish')}
        startFinishText={t('onboarding.start')}
        autoScrollIntoView
      />
      {anchorBox && (
        <div className="_guide-mask" aria-hidden="true">
          {/* Four semi-transparent masks for top, bottom, left, and right to form a highlighted hole */}
          <div
            className="_guide-mask-block"
            style={{ top: 0, left: 0, right: 0, height: anchorBox.top }}
          />
          <div
            className="_guide-mask-block"
            style={{ top: anchorBox.top + anchorBox.height, left: 0, right: 0, bottom: 0 }}
          />
          <div
            className="_guide-mask-block"
            style={{ top: anchorBox.top, left: 0, width: anchorBox.left, height: anchorBox.height }}
          />
          <div
            className="_guide-mask-block"
            style={{
              top: anchorBox.top,
              left: anchorBox.left + anchorBox.width,
              right: 0,
              height: anchorBox.height,
            }}
          />
          {/* Highlight outline */}
          <div
            className="_guide-mask-ring"
            style={{
              top: anchorBox.top,
              left: anchorBox.left,
              width: anchorBox.width,
              height: anchorBox.height,
            }}
          />
        </div>
      )}
    </>
  );
}
