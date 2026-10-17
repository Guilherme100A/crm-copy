// Modo embutido (CRM dentro do painel do ai-manager): a SPA roda num iframe (`window.top !== window`) ou foi aberta
// com `?embed=1` (lembrado na aba por sessionStorage; `?embed=0` desliga). Embutido, o shell esconde o que o painel
// do ai-manager já mostra (nome do produto, idioma e tema) e o tema segue o do painel ('wsm.theme').
// O visual do ai-manager (`data-skin="ai-manager"` no <html>) vale embutido ou com `CRM_UI_SKIN=ai-manager` no build.
// O index.html aplica o mesmo antes do primeiro paint; `initEmbed()` confirma ao subir a SPA.

export const EMBED_STORAGE_KEY = 'crm.embed'
export const AI_MANAGER_SKIN = 'ai-manager'
/** Chave do tema do painel do ai-manager (mesma origem quando embutido). */
export const AI_MANAGER_THEME_KEY = 'wsm.theme'

export interface EmbedEnv {
  /** `window.top !== window.self` (true também se o acesso ao top for bloqueado). */
  framed: boolean
  search: string
  storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null
}

/** Decide o modo embutido (função pura sobre o ambiente; grava/limpa a lembrança da aba). */
export function detectEmbed({ framed, search, storage }: EmbedEnv): boolean {
  const q = new URLSearchParams(search).get('embed')
  try {
    if (q === '1' || q === 'true') {
      storage?.setItem(EMBED_STORAGE_KEY, '1')
      return true
    }
    if (q === '0' || q === 'false') {
      storage?.removeItem(EMBED_STORAGE_KEY)
      return false
    }
  } catch {
    // sem storage: vale só a query desta carga
  }
  if (framed) return true
  try {
    return storage?.getItem(EMBED_STORAGE_KEY) === '1'
  } catch {
    return false
  }
}

function isFramed(): boolean {
  try {
    return typeof window !== 'undefined' && window.top !== window.self
  } catch {
    return true
  }
}

function sessionStore(): Storage | null {
  try {
    return globalThis.sessionStorage ?? null
  } catch {
    return null
  }
}

let embedded: boolean | null = null

/** Está embutido no painel do ai-manager? (calculado uma vez por carga). */
export function isEmbedded(): boolean {
  if (embedded !== null) return embedded
  const root = globalThis.document?.documentElement
  if (root?.dataset.embed === 'true') return (embedded = true)
  if (typeof window === 'undefined') return false
  embedded = detectEmbed({ framed: isFramed(), search: window.location.search, storage: sessionStore() })
  return embedded
}

/** Testes: zera o cache. */
export function resetEmbedForTests(value: boolean | null = null): void {
  embedded = value
}

/** Skin pedida no build (`CRM_UI_SKIN`, injetada no index.html) ou a do ai-manager quando embutido. */
export function resolveSkin(buildSkin: string | undefined, embed: boolean): string | null {
  const v = buildSkin?.trim()
  if (v && v !== 'default' && !v.startsWith('%')) return v
  return embed ? AI_MANAGER_SKIN : null
}

/** Marca o <html> com `data-embed` e `data-skin` (idempotente com o script do index.html). */
export function initEmbed(root: HTMLElement | undefined = globalThis.document?.documentElement): boolean {
  const embed = isEmbedded()
  if (!root) return embed
  if (embed) root.dataset.embed = 'true'
  const skin = resolveSkin(root.dataset.skin, embed)
  if (skin) root.dataset.skin = skin
  return embed
}
