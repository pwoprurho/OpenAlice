import { beforeAll, describe, expect, it, vi } from 'vitest'

import { darkTheme, lightTheme } from '../theme'
import type { TerminalThemeVariant, TerminalThemePreference } from '../terminalTheme'

let resolveTerminalThemeVariant: (
  preference: TerminalThemePreference,
  appTheme: TerminalThemeVariant,
) => TerminalThemeVariant
let xtermThemeForVariant: (variant: TerminalThemeVariant) => typeof darkTheme
let readTerminalThemePreference: () => TerminalThemePreference

beforeAll(async () => {
  window.localStorage.clear()
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: vi.fn().mockReturnValue({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }),
  })
  const mod = await import('../terminalTheme')
  resolveTerminalThemeVariant = mod.resolveTerminalThemeVariant
  xtermThemeForVariant = mod.xtermThemeForVariant
  readTerminalThemePreference = () => mod.useTerminalThemeStore.getState().preference
})

describe('terminal theme helpers', () => {
  it('defaults to following the app theme', () => {
    expect(readTerminalThemePreference()).toBe('follow')
  })

  it('resolves follow to the current app theme', () => {
    expect(resolveTerminalThemeVariant('follow', 'dark')).toBe('dark')
    expect(resolveTerminalThemeVariant('follow', 'light')).toBe('light')
  })

  it('lets explicit terminal preferences override the app theme', () => {
    expect(resolveTerminalThemeVariant('dark', 'light')).toBe('dark')
    expect(resolveTerminalThemeVariant('light', 'dark')).toBe('light')
  })

  it('maps concrete variants to xterm palettes', () => {
    expect(xtermThemeForVariant('dark')).toBe(darkTheme)
    expect(xtermThemeForVariant('light')).toBe(lightTheme)
  })
})
