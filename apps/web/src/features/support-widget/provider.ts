// Provedor de chat de suporte plugável (SPEC T108; 18 §9.2 "Clone"): `load`, `identify`, `open`, `close`,
// `clearLocalKeys` e `unload`. Marca neutra: o nome do global e o prefixo das chaves vêm da config (`SUPPORT_SCRIPT_GLOBAL`,
// `SUPPORT_STORAGE_PREFIX`). Tudo falha em silêncio: o widget é de terceiros e nunca pode quebrar o app.
// DOM/timers injetáveis para os testes unitários (ambiente node, fake timers).

export const SUPPORT_SCRIPT_ID = 'support-widget-script'
export const IDENTIFY_POLL_MS = 100
export const IDENTIFY_TIMEOUT_MS = 10_000

export interface SupportIdentity {
  email: string
  name: string
  phone?: string
}

/** Objeto que o script de terceiros expõe no `window` (todos os métodos opcionais). */
export interface SupportChatGlobal {
  identify?: (user: SupportIdentity) => unknown
  show?: () => unknown
  open?: () => unknown
  close?: () => unknown
}

export interface SupportProvider {
  /** Injeta o script uma única vez (id fixo ou mesmo `src` já no DOM = nada a fazer). */
  load(): void
  /** Espera o global (polling 100 ms) e chama `identify`; desiste em silêncio aos 10 s. `true` se identificou. */
  identify(user: SupportIdentity): Promise<boolean>
  open(): void
  close(): void
  /** Remove do localStorage as chaves com o prefixo do provedor. */
  clearLocalKeys(): void
  /** Cancela o `identify` pendente e remove o script. */
  unload(): void
}

/** Partes do DOM usadas (subconjunto de `Document`/`Window`/`Storage`). */
export interface ScriptElementLike {
  id: string
  src: string
  async: boolean
  defer: boolean
  setAttribute(name: string, value: string): void
  getAttribute(name: string): string | null
  remove(): void
}
export interface DocumentLike {
  getElementById(id: string): unknown
  querySelectorAll(selector: string): ArrayLike<ScriptElementLike>
  createElement(tag: 'script'): ScriptElementLike
  head: { appendChild(node: ScriptElementLike): unknown }
}
export interface StorageLike {
  readonly length: number
  key(index: number): string | null
  removeItem(key: string): void
}
export interface SupportEnv {
  doc: DocumentLike
  win: Record<string, unknown> & { dispatchEvent?: (event: Event) => boolean }
  storage: () => StorageLike | null
  setInterval: (fn: () => void, ms: number) => unknown
  clearInterval: (id: unknown) => void
  now: () => number
}

export interface ScriptProviderOptions {
  scriptUrl: string
  globalName: string
  storagePrefix: string
}

function browserEnv(): SupportEnv {
  return {
    doc: document as unknown as DocumentLike,
    win: window as unknown as SupportEnv['win'],
    storage: () => {
      try {
        return window.localStorage
      } catch {
        return null
      }
    },
    setInterval: (fn, ms) => window.setInterval(fn, ms),
    clearInterval: (id) => window.clearInterval(id as number),
    now: () => Date.now(),
  }
}

const quiet = (fn: () => unknown) => {
  try {
    fn()
  } catch {
    // widget de terceiros: falha silenciosa
  }
}

/** Chaves do storage com o prefixo (sem tocar em nada fora dele). */
export function clearKeysWithPrefix(storage: StorageLike | null, prefix: string): string[] {
  if (!storage || !prefix) return []
  const removed: string[] = []
  try {
    const keys: string[] = []
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i)
      if (key?.startsWith(prefix)) keys.push(key)
    }
    for (const key of keys) {
      storage.removeItem(key)
      removed.push(key)
    }
  } catch {
    // storage bloqueado (modo privado etc.)
  }
  return removed
}

/** Provedor "script": um `<script>` de terceiros que expõe `window[globalName]`. */
export function createScriptProvider(opts: ScriptProviderOptions, env: SupportEnv = browserEnv()): SupportProvider {
  const { doc, win } = env
  let poll: unknown = null
  let settle: ((ok: boolean) => void) | null = null
  const chat = () => {
    const g = win[opts.globalName]
    return g && typeof g === 'object' ? (g as SupportChatGlobal) : null
  }
  const stopPolling = (ok: boolean) => {
    if (poll !== null) env.clearInterval(poll)
    poll = null
    const done = settle
    settle = null
    done?.(ok)
  }
  const existing = (): ScriptElementLike[] => {
    const found: ScriptElementLike[] = []
    quiet(() => {
      const byId = doc.getElementById(SUPPORT_SCRIPT_ID) as ScriptElementLike | null
      if (byId) found.push(byId)
      for (const s of Array.from(doc.querySelectorAll('script[src]'))) {
        if (s !== byId && s.getAttribute('src') === opts.scriptUrl) found.push(s)
      }
    })
    return found
  }

  return {
    load() {
      if (existing().length > 0) return
      quiet(() => {
        const script = doc.createElement('script')
        script.id = SUPPORT_SCRIPT_ID
        script.src = opts.scriptUrl
        script.async = true
        script.defer = true
        script.setAttribute('data-testid', SUPPORT_SCRIPT_ID)
        script.setAttribute('data-button-style', 'floating')
        doc.head.appendChild(script)
      })
    },
    identify(user) {
      stopPolling(false)
      return new Promise<boolean>((resolve) => {
        settle = resolve
        const started = env.now()
        const attempt = () => {
          const g = chat()
          if (typeof g?.identify === 'function') {
            const identify = g.identify.bind(g)
            quiet(() => identify(user))
            stopPolling(true)
            return
          }
          if (env.now() - started >= IDENTIFY_TIMEOUT_MS) stopPolling(false)
        }
        poll = env.setInterval(attempt, IDENTIFY_POLL_MS)
        attempt()
      })
    },
    open() {
      const g = chat()
      if (g && (typeof g.show === 'function' || typeof g.open === 'function')) {
        quiet(() => g.show?.())
        quiet(() => g.open?.())
        return
      }
      // Sem o global (script ainda carregando): eventos neutros para o script ouvir.
      quiet(() => win.dispatchEvent?.(new Event('support-chat-show')))
      quiet(() => win.dispatchEvent?.(new Event('support-chat-open')))
    },
    close() {
      const g = chat()
      if (typeof g?.close === 'function') quiet(() => g.close!())
    },
    clearLocalKeys() {
      clearKeysWithPrefix(env.storage(), opts.storagePrefix)
    },
    unload() {
      stopPolling(false)
      for (const s of existing()) quiet(() => s.remove())
    },
  }
}
