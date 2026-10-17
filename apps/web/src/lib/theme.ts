// Tema claro/escuro (spec 18 §4, §5.1; SPEC 3.11): segue o sistema até o usuário escolher; persiste em
// localStorage 'theme'; aplica classe + data-theme + color-scheme no <html>; Ctrl/Cmd+M alterna.
// Embutido no painel do ai-manager, a preferência é a do painel ('wsm.theme', mesma origem): os dois andam juntos.
import { AI_MANAGER_THEME_KEY, isEmbedded } from './embed'
import { readStorage, STORAGE_KEYS, writeStorage } from './storage'

/** Chave do tema no localStorage: a do CRM, ou a do painel do ai-manager quando embutido. */
export const themeStorageKey = (): string => (isEmbedded() ? AI_MANAGER_THEME_KEY : STORAGE_KEYS.theme)

export type Theme = 'light' | 'dark'

export function systemTheme(): Theme {
  try {
    return globalThis.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  } catch {
    return 'light'
  }
}

export function storedTheme(): Theme | null {
  const v = readStorage(themeStorageKey())
  return v === 'light' || v === 'dark' ? v : null
}

export const currentTheme = (): Theme => storedTheme() ?? systemTheme()

export function applyTheme(theme: Theme, root: HTMLElement | undefined = globalThis.document?.documentElement): void {
  if (!root) return
  root.classList.remove(theme === 'dark' ? 'light' : 'dark')
  root.classList.add(theme)
  root.dataset.theme = theme
  root.style.colorScheme = theme
}

export function setTheme(theme: Theme): void {
  writeStorage(themeStorageKey(), theme)
  applyTheme(theme)
}

export function toggleTheme(): Theme {
  const next: Theme = currentTheme() === 'dark' ? 'light' : 'dark'
  setTheme(next)
  return next
}

interface ShortcutEvent {
  key: string
  ctrlKey: boolean
  metaKey: boolean
  altKey: boolean
  shiftKey: boolean
  repeat: boolean
  target: EventTarget | null
}

const TEXT_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT'])

/** O foco está num campo de texto (onde o atalho não age)? */
export function isEditableTarget(target: EventTarget | null): boolean {
  const el = target as { tagName?: string; isContentEditable?: boolean } | null
  if (!el) return false
  return (typeof el.tagName === 'string' && TEXT_TAGS.has(el.tagName.toUpperCase())) || el.isContentEditable === true
}

/**
 * Ctrl+M (Windows/Linux) ou ⌘M (macOS) alterna o tema. Não dispara com Alt/Shift, em autorrepetição, com Ctrl e
 * Meta juntos, nem com foco em INPUT/TEXTAREA/SELECT/contentEditable (spec 18 §5.1).
 */
export function isThemeShortcut(e: ShortcutEvent): boolean {
  if (e.key.toLowerCase() !== 'm' || e.altKey || e.shiftKey || e.repeat) return false
  if (e.ctrlKey === e.metaKey) return false
  return !isEditableTarget(e.target)
}
