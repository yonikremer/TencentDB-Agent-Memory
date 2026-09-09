import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { NotFoundPage } from '@/pages/NotFoundPage';
import { enUS } from '@/i18n/en-US';
import { zhCN } from '@/i18n/zh-CN';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}));

describe('NotFoundPage', () => {
  it('renders 404 and navigates home on back', () => {
    const router = createMemoryRouter([{ path: '*', element: <NotFoundPage /> }], {
      initialEntries: ['/wiki/does-not-exist'],
    });
    render(<RouterProvider router={router} />);
    expect(screen.getByText('404')).toBeTruthy();
    fireEvent.click(screen.getByText('notFound.back'));
    expect(router.state.location.pathname).toBe('/');
  });
});

describe('notFound i18n', () => {
  it.each(['notFound.title', 'notFound.desc', 'notFound.back'] as const)(
    'has %s in en + zh',
    (key) => {
      expect(enUS[key]).toBeTruthy();
      expect(zhCN[key]).toBeTruthy();
    },
  );
});
