// localStorage tolerante (modo privado, bloqueio de storage): nunca lança. Só preferências de UI — nada de token
// ou sessão aqui (a sessão é o cookie httpOnly; SPEC 3.4).

export const STORAGE_KEYS = {
  theme: 'theme',
  sidebarCollapsed: 'sidebarCollapsed',
  locale: 'locale',
} as const

export function readStorage(key: string): string | null {
  try {
    return globalThis.localStorage?.getItem(key) ?? null
  } catch {
    return null
  }
}

export function writeStorage(key: string, value: string): void {
  try {
    globalThis.localStorage?.setItem(key, value)
  } catch {
    // sem storage: a preferência vale só nesta página
  }
}
