// Estado do widget de suporte no app (SPEC T108; 18 §9.2): um provedor ativo por página, regras de quem carrega e o
// encerramento no logout / usuário `support` (AC-T108-04). Funções puras + um singleton de módulo (o shell remonta;
// o script continua sendo um só).
import type { AppConfigDto } from '@/features/affiliate/api'
import { createScriptProvider, type SupportEnv, type SupportIdentity, type SupportProvider } from './provider'

export const SUPPORT_SCRIPT_GLOBAL_DEFAULT = 'SupportChat'
export const SUPPORT_STORAGE_PREFIX_DEFAULT = 'support_chat_'
export const SUPPORT_LINK_REL = 'noopener noreferrer'

export type SupportMode = 'none' | 'script' | 'whatsapp-link'

type SupportCfg = NonNullable<AppConfigDto['support']>
export interface SupportUser {
  email?: string | null
  name?: string | null
  personal_whatsapp?: string | null
}

const isHttpUrl = (raw: unknown): raw is string => {
  if (typeof raw !== 'string' || !raw) return false
  try {
    const url = new URL(raw)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

const digits = (raw: unknown) => (typeof raw === 'string' ? raw.replace(/\D/g, '') : '')

/** Modo efetivo do suporte para a sessão: `support` nunca vê botões nem widget. */
export function supportModeOf(config: Partial<AppConfigDto> | undefined, isSupport: boolean): SupportMode {
  const s = config?.support
  if (!s || isSupport) return 'none'
  if (s.provider === 'script' && isHttpUrl(s.script_url)) return 'script'
  if (s.provider === 'whatsapp-link' && digits(s.phone).length >= 8) return 'whatsapp-link'
  return 'none'
}

/** `https://wa.me/<só dígitos>` ou null. */
export function whatsappLinkOf(config: Partial<AppConfigDto> | undefined): string | null {
  const phone = digits(config?.support?.phone)
  return phone.length >= 8 ? `https://wa.me/${phone}` : null
}

/** Identidade para `identify`; sem e-mail → null (não injeta, ref §9.2). */
export function identityOf(user: SupportUser): SupportIdentity | null {
  const email = user.email?.trim()
  if (!email) return null
  const phone = user.personal_whatsapp?.trim()
  return { email, name: user.name?.trim() ?? '', ...(phone ? { phone } : {}) }
}

const optionsOf = (s: Partial<SupportCfg> | undefined) => ({
  scriptUrl: s?.script_url ?? '',
  globalName: s?.script_global || SUPPORT_SCRIPT_GLOBAL_DEFAULT,
  storagePrefix: s?.storage_prefix || SUPPORT_STORAGE_PREFIX_DEFAULT,
})

let active: { key: string; provider: SupportProvider } | null = null
let envOverride: SupportEnv | undefined

/** Só para testes: DOM/timers falsos. */
export function setSupportEnvForTests(env: SupportEnv | undefined) {
  envOverride = env
  active = null
}

export function activeSupportProvider(): SupportProvider | null {
  return active?.provider ?? null
}

function shutdown(provider: SupportProvider) {
  provider.close()
  provider.unload()
  provider.clearLocalKeys()
}

function providerFor(s: Partial<SupportCfg> | undefined): SupportProvider {
  const opts = optionsOf(s)
  const key = JSON.stringify(opts)
  if (active?.key === key) return active.provider
  if (active) shutdown(active.provider)
  const provider = createScriptProvider(opts, envOverride)
  active = { key, provider }
  return provider
}

/**
 * Aplica a config à sessão (chamado pelo shell a cada mudança). Script + usuário com e-mail → injeta uma vez e
 * identifica. Usuário `support`, sem e-mail ou provedor que não é script → fecha, remove e limpa (AC-T108-04).
 */
export function syncSupportWidget(config: Partial<AppConfigDto> | undefined, user: SupportUser, isSupport: boolean): void {
  if (!config) return
  const identity = identityOf(user)
  if (supportModeOf(config, isSupport) === 'script' && identity) {
    const provider = providerFor(config.support)
    provider.load()
    void provider.identify(identity)
    return
  }
  teardownSupportWidget(isSupport || !identity ? config : undefined)
}

/**
 * Logout (ou `support`): fecha o widget, remove o script e limpa as chaves locais do provedor. Com `config`, também
 * limpa as chaves do prefixo configurado mesmo sem provedor ativo (ex.: sobra de outro usuário no mesmo navegador).
 */
export function teardownSupportWidget(config?: Partial<AppConfigDto>): void {
  if (active) shutdown(active.provider)
  active = null
  if (config) createScriptProvider(optionsOf(config.support), envOverride).clearLocalKeys()
}
