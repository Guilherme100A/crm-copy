// Normalizações de entrada do módulo de autenticação (SPEC T15).
import { DEFAULT_LOCALE, LOCALES, type Locale } from '@crm/shared'

const LOCALE_ALIASES: Record<string, Locale> = { pt_br: 'pt-BR', 'pt-br': 'pt-BR', pt: 'pt-BR', en: 'en', es: 'es' }

/** `pt-BR | en | es` (LOCALES); `pt_BR` é sinônimo de `pt-BR`; qualquer outro valor → `pt-BR` (AC-T15-05). */
export function normalizeLocale(input: unknown): Locale {
  if (typeof input !== 'string') return DEFAULT_LOCALE
  const v = input.trim()
  if ((LOCALES as readonly string[]).includes(v)) return v as Locale
  return LOCALE_ALIASES[v.toLowerCase()] ?? DEFAULT_LOCALE
}

/** Código do afiliado que indicou o cadastro: gravado só se casar o padrão, senão ignorado (AC-T15-02). */
export const REFERRAL_CODE_RE = /^[A-Za-z0-9_-]{1,64}$/

export function normalizeReferralCode(input: unknown): string | null {
  return typeof input === 'string' && REFERRAL_CODE_RE.test(input) ? input : null
}

/** WhatsApp pessoal: só dígitos; vazio → `null`. */
export function normalizeWhatsapp(input: unknown): string | null {
  if (typeof input !== 'string') return null
  const digits = input.replace(/\D/g, '')
  return digits.length ? digits : null
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase()
}

/** Nome padrão da empresa criada no cadastro. */
export const DEFAULT_COMPANY_NAME = 'Minha empresa'
