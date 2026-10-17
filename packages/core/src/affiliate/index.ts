// Afiliação (SPEC T97; 13-afiliacao.md): o app só leva ao portal externo de parceiros. A URL vem de
// `AFFILIATE_PORTAL_URL`, lida a cada request; só http/https valem — vazia ou inválida → null (a web não mostra nada).

/** Configuração pública do app em tempo de execução (`GET /api/app-config`). Extensível: a T108 acrescenta campos. */
export interface AppConfigDto {
  affiliate_portal_url: string | null
}

/** URL absoluta http/https, sem espaços nas pontas; qualquer outra coisa → null. */
export function parsePortalUrl(raw: string | undefined | null): string | null {
  const value = raw?.trim()
  if (!value) return null
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  if (!url.hostname) return null
  return url.toString()
}

/** Campos de afiliação da config do app, a partir do ambiente (default `process.env`). */
export function affiliateConfig(
  env: Record<string, string | undefined> = process.env,
): Pick<AppConfigDto, 'affiliate_portal_url'> {
  return { affiliate_portal_url: parsePortalUrl(env.AFFILIATE_PORTAL_URL) }
}

// ---------------------------------------------------------------------------------------------------------------
// T108 (18 §9.1/§9.2): tutoriais e widget de suporte plugável, na mesma config de runtime.

/** Provedor do suporte: script de chat de terceiros, link de WhatsApp ou nenhum (sem botões). */
export type SupportProvider = 'none' | 'script' | 'whatsapp-link'

export interface SupportConfigDto {
  /** Já normalizado: `script` sem `script_url` válida ou `whatsapp-link` sem telefone viram `none`. */
  provider: SupportProvider
  script_url: string | null
  /** Só dígitos (formato de `wa.me`). */
  phone: string | null
  /** Nome do objeto global que o script expõe (`identify`/`open`/`close`). */
  script_global: string
  /** Prefixo das chaves do provedor no localStorage, limpas no logout. */
  storage_prefix: string
}

export interface AppConfigDto {
  tutorials_url: string | null
  support: SupportConfigDto
}

export const SUPPORT_SCRIPT_GLOBAL_DEFAULT = 'SupportChat'
export const SUPPORT_STORAGE_PREFIX_DEFAULT = 'support_chat_'
const SCRIPT_GLOBAL_RE = /^[A-Za-z_$][\w$]{0,63}$/
// Sem "token"/"session" (F-NO-TOKEN-LOCALSTORAGE) e sem caracteres estranhos.
const STORAGE_PREFIX_RE = /^[A-Za-z0-9_.:-]{2,40}$/

/** Telefone só com dígitos (8–15, E.164 sem `+`); fora disso → null. */
export function parseSupportPhone(raw: string | undefined | null): string | null {
  const digits = (raw ?? '').replace(/\D/g, '')
  return digits.length >= 8 && digits.length <= 15 ? digits : null
}

/** Campos de tutoriais/suporte da config do app, a partir do ambiente (default `process.env`). */
export function supportConfig(
  env: Record<string, string | undefined> = process.env,
): Pick<AppConfigDto, 'tutorials_url' | 'support'> {
  const scriptUrl = parsePortalUrl(env.SUPPORT_SCRIPT_URL)
  const phone = parseSupportPhone(env.SUPPORT_PHONE)
  const raw = env.SUPPORT_PROVIDER?.trim().toLowerCase()
  const provider: SupportProvider =
    raw === 'script' && scriptUrl ? 'script' : raw === 'whatsapp-link' && phone ? 'whatsapp-link' : 'none'
  const global = env.SUPPORT_SCRIPT_GLOBAL?.trim() ?? ''
  const prefix = env.SUPPORT_STORAGE_PREFIX?.trim() ?? ''
  return {
    tutorials_url: parsePortalUrl(env.TUTORIALS_URL),
    support: {
      provider,
      script_url: provider === 'script' ? scriptUrl : null,
      phone: provider === 'whatsapp-link' ? phone : null,
      script_global: SCRIPT_GLOBAL_RE.test(global) ? global : SUPPORT_SCRIPT_GLOBAL_DEFAULT,
      storage_prefix:
        STORAGE_PREFIX_RE.test(prefix) && !/token|session/i.test(prefix) ? prefix : SUPPORT_STORAGE_PREFIX_DEFAULT,
    },
  }
}
