// i18n (SPEC 3.11): pt-BR (padrão e fallback), en e es. Um arquivo por módulo em `src/i18n/<língua>/<módulo>.json`,
// carregados por glob; cada tarefa de UI só acrescenta os arquivos do seu módulo. Chave: `<módulo>:<caminho.da.chave>`.
import { readStorage, STORAGE_KEYS } from '@/lib/storage'

export const LOCALES = ['pt-BR', 'en', 'es'] as const
export type Locale = (typeof LOCALES)[number]
export const DEFAULT_LOCALE: Locale = 'pt-BR'

type Messages = Record<string, unknown>

const files = import.meta.glob<Messages>('./*/*.json', { eager: true, import: 'default' })

/** `{ 'pt-BR': { shell: {...} }, en: {...}, es: {...} }`. */
export const MESSAGES: Record<string, Record<string, Messages>> = {}
for (const [path, data] of Object.entries(files)) {
  const m = /^\.\/([^/]+)\/([^/]+)\.json$/.exec(path)
  if (!m) continue
  ;(MESSAGES[m[1]!] ??= {})[m[2]!] = data
}

export function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && (LOCALES as readonly string[]).includes(value)
}

/** Idioma inicial: o salvo no navegador, senão o do perfil, senão pt-BR. */
export function initialLocale(profileLocale?: string | null): Locale {
  const stored = readStorage(STORAGE_KEYS.locale)
  if (isLocale(stored)) return stored
  return isLocale(profileLocale) ? profileLocale : DEFAULT_LOCALE
}

function lookup(obj: unknown, path: string): unknown {
  let cur = obj
  for (const seg of path.split('.')) {
    if (!cur || typeof cur !== 'object' || !Object.hasOwn(cur, seg)) return undefined
    cur = (cur as Record<string, unknown>)[seg]
  }
  return cur
}

export type TVars = Record<string, string | number>

/** Traduz `módulo:chave` (ou `chave` com `ns`), com fallback em pt-BR e, por fim, a própria chave. `{nome}` interpola. */
export function translate(locale: Locale, key: string, vars?: TVars, ns = 'shell'): string {
  const sep = key.indexOf(':')
  const module = sep > 0 ? key.slice(0, sep) : ns
  const path = sep > 0 ? key.slice(sep + 1) : key
  const raw = lookup(MESSAGES[locale]?.[module], path) ?? lookup(MESSAGES[DEFAULT_LOCALE]?.[module], path)
  if (typeof raw !== 'string') return key
  return vars ? raw.replace(/\{(\w+)\}/g, (m, name: string) => (Object.hasOwn(vars, name) ? String(vars[name]) : m)) : raw
}
