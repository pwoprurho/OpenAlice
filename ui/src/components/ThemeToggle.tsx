/**
 * The color-theme toggle that lives in the ActivityBar footer. One button
 * that cycles auto → light → dark → auto; the icon + label reflect the
 * CURRENT mode, the tooltip names the NEXT one. Styled to match the nav rows
 * above it (same height, padding, hover) so the rail reads as one column.
 *
 * State is the theme store (ui/src/theme/store); the side-effect module
 * applies `<html data-theme>`, CSS does the rest. No prop drilling.
 */

import { Monitor, Moon, Sun } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { useThemeStore, type AppTheme } from '../theme/store'

const ICON: Record<AppTheme, LucideIcon> = {
  auto: Monitor,
  light: Sun,
  dark: Moon,
}

/** What the NEXT click switches to (auto → light → dark → auto). */
const NEXT: Record<AppTheme, AppTheme> = {
  auto: 'light',
  light: 'dark',
  dark: 'auto',
}

export function ThemeToggle() {
  const { t } = useTranslation()
  const theme = useThemeStore((s) => s.theme)
  const cycle = useThemeStore((s) => s.cycleTheme)
  const Icon = ICON[theme]

  return (
    <button
      type="button"
      onClick={cycle}
      title={t('theme.switchTo', { mode: t(`theme.mode.${NEXT[theme]}`) })}
      aria-label={t('theme.switchTo', { mode: t(`theme.mode.${NEXT[theme]}`) })}
      className="relative flex min-h-[34px] w-full items-center gap-3 rounded-md px-3 py-1.5 text-left text-[13px] text-text-muted transition-colors hover:bg-overlay hover:text-text"
    >
      <span className="relative flex h-5 w-5 shrink-0 items-center justify-center">
        <Icon size={16} strokeWidth={1.75} />
      </span>
      <span className="flex-1 truncate">{t(`theme.mode.${theme}`)}</span>
    </button>
  )
}
