// Provedor de idioma: troca sem recarregar, atualiza `<html lang>`, persiste em localStorage 'locale' e, com sessão,
// no perfil do usuário (`PUT /api/auth/profile { locale }`).
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { api } from '@/lib/http'
import { STORAGE_KEYS, writeStorage } from '@/lib/storage'
import { initialLocale, translate, type Locale, type TVars } from './core'

export * from './core'

interface I18nValue {
  locale: Locale
  setLocale: (locale: Locale, opts?: { persistRemote?: boolean }) => void
}

const I18nContext = createContext<I18nValue | null>(null)

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(() => initialLocale())

  useEffect(() => {
    document.documentElement.lang = locale
  }, [locale])

  const setLocale = useCallback((next: Locale, opts: { persistRemote?: boolean } = {}) => {
    setLocaleState(next)
    writeStorage(STORAGE_KEYS.locale, next)
    document.documentElement.lang = next
    // Sem sessão (ex.: tela de login) não há perfil para gravar; uma falha aqui não desfaz a troca local.
    if (opts.persistRemote) void api.put('/api/auth/profile', { locale: next }).catch(() => undefined)
  }, [])

  const value = useMemo(() => ({ locale, setLocale }), [locale, setLocale])
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>
}

export function useI18n(): I18nValue {
  const ctx = useContext(I18nContext)
  if (!ctx) throw new Error('useI18n fora do I18nProvider')
  return ctx
}

/** `t('nav.items.chats')` no namespace dado (padrão `shell`), ou `t('outro:chave')`. */
export function useT(ns = 'shell'): (key: string, vars?: TVars) => string {
  const { locale } = useI18n()
  return useCallback((key: string, vars?: TVars) => translate(locale, key, vars, ns), [locale, ns])
}
