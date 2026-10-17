import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppConfigDto } from '@/features/affiliate/api'
import { translate } from '@/i18n/core'
import {
  clearKeysWithPrefix,
  createScriptProvider,
  IDENTIFY_POLL_MS,
  IDENTIFY_TIMEOUT_MS,
  SUPPORT_SCRIPT_ID,
  type DocumentLike,
  type ScriptElementLike,
  type SupportEnv,
} from './provider'
import {
  activeSupportProvider,
  identityOf,
  setSupportEnvForTests,
  SUPPORT_LINK_REL,
  supportModeOf,
  syncSupportWidget,
  teardownSupportWidget,
  whatsappLinkOf,
} from './runtime'

const SCRIPT_URL = 'https://chat.example.test/widget.js'

/** DOM mínimo: `<head>` com scripts, busca por id e por `script[src]`. */
function fakeDom() {
  const scripts: ScriptElementLike[] = []
  const doc: DocumentLike = {
    getElementById: (id) => scripts.find((s) => s.id === id) ?? null,
    querySelectorAll: () => scripts.filter((s) => !!s.getAttribute('src')),
    createElement: () => {
      const attrs: Record<string, string> = {}
      const el: ScriptElementLike = {
        id: '',
        get src() {
          return attrs.src ?? ''
        },
        set src(v: string) {
          attrs.src = v
        },
        async: false,
        defer: false,
        setAttribute: (n, v) => void (attrs[n] = v),
        getAttribute: (n) => attrs[n] ?? null,
        remove: () => void scripts.splice(scripts.indexOf(el), 1),
      }
      return el
    },
    head: { appendChild: (node) => scripts.push(node) },
  }
  return { doc, scripts }
}

function fakeStorage(initial: Record<string, string>) {
  const data = new Map(Object.entries(initial))
  return {
    data,
    get length() {
      return data.size
    },
    key: (i: number) => [...data.keys()][i] ?? null,
    removeItem: (k: string) => void data.delete(k),
  }
}

function fakeEnv(storage = fakeStorage({})) {
  const { doc, scripts } = fakeDom()
  const win: SupportEnv['win'] = { dispatchEvent: vi.fn(() => true) }
  const env: SupportEnv = {
    doc,
    win,
    storage: () => storage,
    setInterval: (fn, ms) => setInterval(fn, ms),
    clearInterval: (id) => clearInterval(id as ReturnType<typeof setInterval>),
    now: () => Date.now(),
  }
  return { env, scripts, win, storage }
}

const opts = { scriptUrl: SCRIPT_URL, globalName: 'HelpDesk', storagePrefix: 'hd_' }
const scriptCfg = (extra: Partial<NonNullable<AppConfigDto['support']>> = {}): Partial<AppConfigDto> => ({
  affiliate_portal_url: null,
  support: { provider: 'script', script_url: SCRIPT_URL, phone: null, script_global: 'HelpDesk', storage_prefix: 'hd_', ...extra },
})
const user = { email: 'ana@demo.test', name: 'Ana', personal_whatsapp: '5511988887777' }

beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  setSupportEnvForTests(undefined)
  vi.useRealTimers()
})

describe('AC-T108-02 provedor script: injeção única e identify', () => {
  it('injeta um único <script> com id fixo, mesmo chamando load várias vezes (remontagem)', () => {
    const { env, scripts } = fakeEnv()
    const p = createScriptProvider(opts, env)
    p.load()
    p.load()
    createScriptProvider(opts, env).load() // outro provedor (remontagem do shell) também não duplica
    expect(scripts).toHaveLength(1)
    expect(scripts[0]!.id).toBe(SUPPORT_SCRIPT_ID)
    expect(scripts[0]!.src).toBe(SCRIPT_URL)
    expect(scripts[0]!.getAttribute('data-testid')).toBe(SUPPORT_SCRIPT_ID)
  })

  it('não injeta se já houver script com o mesmo src (outro id)', () => {
    const { env, scripts } = fakeEnv()
    const other = env.doc.createElement('script')
    other.src = SCRIPT_URL
    env.doc.head.appendChild(other)
    createScriptProvider(opts, env).load()
    expect(scripts).toHaveLength(1)
  })

  it('identify: polling de 100 ms até o global existir; chama com e-mail/nome/telefone', async () => {
    const { env, win } = fakeEnv()
    const p = createScriptProvider(opts, env)
    const identify = vi.fn()
    const done = p.identify({ email: 'a@b.test', name: 'A', phone: '5511' })
    await vi.advanceTimersByTimeAsync(IDENTIFY_POLL_MS * 5)
    expect(identify).not.toHaveBeenCalled()
    win.HelpDesk = { identify }
    await vi.advanceTimersByTimeAsync(IDENTIFY_POLL_MS)
    await expect(done).resolves.toBe(true)
    expect(identify).toHaveBeenCalledTimes(1)
    expect(identify).toHaveBeenCalledWith({ email: 'a@b.test', name: 'A', phone: '5511' })
    await vi.advanceTimersByTimeAsync(IDENTIFY_TIMEOUT_MS)
    expect(identify).toHaveBeenCalledTimes(1)
  })

  it('desiste em silêncio aos 10 s (sem erro nem console) e para o polling', async () => {
    const { env, win } = fakeEnv()
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const p = createScriptProvider(opts, env)
    const done = p.identify({ email: 'a@b.test', name: 'A' })
    await vi.advanceTimersByTimeAsync(IDENTIFY_TIMEOUT_MS - IDENTIFY_POLL_MS)
    expect(vi.getTimerCount()).toBe(1)
    await vi.advanceTimersByTimeAsync(IDENTIFY_POLL_MS)
    await expect(done).resolves.toBe(false)
    expect(vi.getTimerCount()).toBe(0)
    const identify = vi.fn()
    win.HelpDesk = { identify }
    await vi.advanceTimersByTimeAsync(IDENTIFY_POLL_MS * 3)
    expect(identify).not.toHaveBeenCalled()
    expect(errors).not.toHaveBeenCalled()
    errors.mockRestore()
  })

  it('identify que lança erro é silenciado', async () => {
    const { env, win } = fakeEnv()
    win.HelpDesk = {
      identify: () => {
        throw new Error('boom')
      },
    }
    await expect(createScriptProvider(opts, env).identify({ email: 'a@b.test', name: 'A' })).resolves.toBe(true)
  })

  it('open chama show/open do global; sem global dispara eventos neutros', () => {
    const { env, win } = fakeEnv()
    const p = createScriptProvider(opts, env)
    p.open()
    expect(win.dispatchEvent).toHaveBeenCalledTimes(2)
    const g = { show: vi.fn(), open: vi.fn() }
    win.HelpDesk = g
    p.open()
    expect(g.show).toHaveBeenCalledTimes(1)
    expect(g.open).toHaveBeenCalledTimes(1)
  })

  it('syncSupportWidget: usuário com e-mail injeta uma vez (várias sincronizações) e identifica com o telefone pessoal', async () => {
    const { env, scripts, win } = fakeEnv()
    setSupportEnvForTests(env)
    syncSupportWidget(scriptCfg(), user, false)
    syncSupportWidget(scriptCfg(), user, false)
    expect(scripts).toHaveLength(1)
    const identify = vi.fn()
    win.HelpDesk = { identify }
    await vi.advanceTimersByTimeAsync(IDENTIFY_POLL_MS)
    expect(identify).toHaveBeenCalledTimes(1)
    expect(identify).toHaveBeenCalledWith({ email: 'ana@demo.test', name: 'Ana', phone: '5511988887777' })
  })

  it('não injeta para usuário sem e-mail nem sem config carregada', () => {
    const { env, scripts } = fakeEnv()
    setSupportEnvForTests(env)
    syncSupportWidget(undefined, user, false)
    syncSupportWidget(scriptCfg(), { ...user, email: '' }, false)
    expect(scripts).toHaveLength(0)
    expect(identityOf({ email: '  ', name: 'x' })).toBeNull()
    expect(identityOf({ email: 'a@b.test', name: 'A', personal_whatsapp: null })).toEqual({ email: 'a@b.test', name: 'A' })
  })
})

describe('AC-T108-03 whatsapp-link e none', () => {
  it('whatsapp-link → wa.me/<dígitos>, rel noopener', () => {
    const cfg: Partial<AppConfigDto> = { support: { provider: 'whatsapp-link', script_url: null, phone: '+55 (11) 99999-8888' } }
    expect(supportModeOf(cfg, false)).toBe('whatsapp-link')
    expect(whatsappLinkOf(cfg)).toBe('https://wa.me/5511999998888')
    expect(SUPPORT_LINK_REL).toMatch(/\bnoopener\b/)
  })

  it('none, sem config, provedor inválido ou usuário support → sem botões', () => {
    expect(supportModeOf({ support: { provider: 'none', script_url: null, phone: null } }, false)).toBe('none')
    expect(supportModeOf(undefined, false)).toBe('none')
    expect(supportModeOf({ affiliate_portal_url: null }, false)).toBe('none')
    expect(supportModeOf({ support: { provider: 'whatsapp-link', script_url: null, phone: '12' } }, false)).toBe('none')
    expect(supportModeOf({ support: { provider: 'script', script_url: 'javascript:x', phone: null } }, false)).toBe('none')
    expect(supportModeOf(scriptCfg(), true)).toBe('none')
    expect(supportModeOf(scriptCfg(), false)).toBe('script')
  })

  it('rótulo "Suporte" nas três línguas', () => {
    expect(translate('pt-BR', 'button', undefined, 'support-widget')).toBe('Suporte')
    expect(translate('en', 'button', undefined, 'support-widget')).toBe('Support')
    expect(translate('es', 'button', undefined, 'support-widget')).toBe('Soporte')
  })
})

describe('AC-T108-04 logout ou usuário support fecham e limpam', () => {
  const keys = () => ({ hd_user: '1', hd_csat_1: 'x', other_key: 'keep', crm_theme: 'dark' })

  it('logout: close no global, remove o script e as chaves com o prefixo (só elas)', () => {
    const storage = fakeStorage(keys())
    const { env, scripts, win } = fakeEnv(storage)
    setSupportEnvForTests(env)
    syncSupportWidget(scriptCfg(), user, false)
    const close = vi.fn()
    win.HelpDesk = { close }
    expect(activeSupportProvider()).not.toBeNull()
    teardownSupportWidget(scriptCfg())
    expect(close).toHaveBeenCalledTimes(1)
    expect(scripts).toHaveLength(0)
    expect([...storage.data.keys()].sort()).toEqual(['crm_theme', 'other_key'])
    expect(activeSupportProvider()).toBeNull()
  })

  it('logout cancela o identify pendente', async () => {
    const { env, win } = fakeEnv()
    setSupportEnvForTests(env)
    syncSupportWidget(scriptCfg(), user, false)
    teardownSupportWidget()
    const identify = vi.fn()
    win.HelpDesk = { identify }
    await vi.advanceTimersByTimeAsync(IDENTIFY_POLL_MS * 3)
    expect(identify).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('usuário support: fecha, remove e limpa, sem injetar', () => {
    const storage = fakeStorage(keys())
    const { env, scripts, win } = fakeEnv(storage)
    setSupportEnvForTests(env)
    syncSupportWidget(scriptCfg(), user, false)
    const close = vi.fn()
    win.HelpDesk = { close }
    syncSupportWidget(scriptCfg(), { email: 'support@demo.test', name: 'Suporte' }, true)
    expect(close).toHaveBeenCalledTimes(1)
    expect(scripts).toHaveLength(0)
    expect(storage.data.has('hd_user')).toBe(false)
    // entrando direto como support (sem provedor ativo) também limpa as sobras
    storage.data.set('hd_user', 'old')
    syncSupportWidget(scriptCfg(), { email: 'support@demo.test', name: 'Suporte' }, true)
    expect(storage.data.has('hd_user')).toBe(false)
    expect(scripts).toHaveLength(0)
  })

  it('storage indisponível ou que lança não quebra', () => {
    expect(clearKeysWithPrefix(null, 'hd_')).toEqual([])
    const broken = {
      get length(): number {
        throw new Error('blocked')
      },
      key: () => null,
      removeItem: () => undefined,
    }
    expect(clearKeysWithPrefix(broken, 'hd_')).toEqual([])
    expect(clearKeysWithPrefix(fakeStorage({ a: '1' }), '')).toEqual([])
  })
})
