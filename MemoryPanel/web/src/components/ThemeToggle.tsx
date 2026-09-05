/** ThemeToggle — header sun/moon switch (lucide icons; tea-icons has no sun/moon). */
import { Moon, Sun } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useTheme } from '@/theme';

export function ThemeToggle({ className = '_memory-global-header-icon-btn' }: { className?: string }) {
  const { t } = useTranslation();
  const { theme, toggle } = useTheme();
  const dark = theme === 'dark';
  return (
    <button
      type="button"
      className={className}
      title={t(dark ? 'header.theme.switchToLight' : 'header.theme.switchToDark')}
      aria-label={t(dark ? 'header.theme.switchToLight' : 'header.theme.switchToDark')}
      aria-pressed={dark}
      onClick={toggle}
    >
      {dark ? <Sun size={16} /> : <Moon size={16} />}
    </button>
  );
}
