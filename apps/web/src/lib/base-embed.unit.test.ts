import { describe, expect, it } from 'vitest'
import { apiUrl, appPath, stripAppBase } from './base'
import { detectEmbed, resolveSkin } from './embed'

function memoryStorage(init: Record<string, string> = {}) {
  const m = new Map(Object.entries(init))
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k), m }
}

describe('apiUrl (VITE_API_BASE)', () => {
  it('sem base configurada (padrão /api) devolve o caminho igual', () => {
    expect(apiUrl('/api/auth/profile')).toBe('/api/auth/profile')
    expect(apiUrl('/api/x', '/api')).toBe('/api/x')
  })

  it('com /crm/api troca só o prefixo /api', () => {
    expect(apiUrl('/api/auth/profile', '/crm/api')).toBe('/crm/api/auth/profile')
    expect(apiUrl('/api/events?company_id=1', '/crm/api')).toBe('/crm/api/events?company_id=1')
    expect(apiUrl('/api', '/crm/api')).toBe('/crm/api')
  })

  it('não mexe em URLs absolutas, blob: ou caminhos fora da API', () => {
    expect(apiUrl('https://cdn.example.com/a.png', '/crm/api')).toBe('https://cdn.example.com/a.png')
    expect(apiUrl('blob:http://x/1', '/crm/api')).toBe('blob:http://x/1')
    expect(apiUrl('/apis/x', '/crm/api')).toBe('/apis/x')
    expect(apiUrl('/login', '/crm/api')).toBe('/login')
  })
})

describe('appPath / stripAppBase (VITE_BASE_PATH)', () => {
  it('na raiz (padrão) nada muda', () => {
    expect(appPath('/login', '')).toBe('/login')
    expect(stripAppBase('/login', '')).toBe('/login')
  })

  it('em /crm adiciona e remove a base', () => {
    expect(appPath('/login?redirect=%2Fchats', '/crm')).toBe('/crm/login?redirect=%2Fchats')
    expect(stripAppBase('/crm/chats', '/crm')).toBe('/chats')
    expect(stripAppBase('/crm', '/crm')).toBe('/')
    expect(stripAppBase('/crmx/a', '/crm')).toBe('/crmx/a')
  })
})

describe('detectEmbed', () => {
  it('fora de iframe e sem flag: standalone', () => {
    expect(detectEmbed({ framed: false, search: '', storage: memoryStorage() })).toBe(false)
  })

  it('num iframe: embutido', () => {
    expect(detectEmbed({ framed: true, search: '', storage: memoryStorage() })).toBe(true)
  })

  it('?embed=1 liga e lembra na aba; ?embed=0 desliga e esquece', () => {
    const s = memoryStorage()
    expect(detectEmbed({ framed: false, search: '?embed=1', storage: s })).toBe(true)
    expect(detectEmbed({ framed: false, search: '', storage: s })).toBe(true)
    expect(detectEmbed({ framed: false, search: '?embed=0', storage: s })).toBe(false)
    expect(detectEmbed({ framed: false, search: '', storage: s })).toBe(false)
  })

  it('storage que lança não derruba', () => {
    const boom = {
      getItem: () => {
        throw new Error('blocked')
      },
      setItem: () => {
        throw new Error('blocked')
      },
      removeItem: () => undefined,
    }
    expect(detectEmbed({ framed: false, search: '?embed=1', storage: boom })).toBe(false)
    expect(detectEmbed({ framed: true, search: '', storage: boom })).toBe(true)
  })
})

describe('resolveSkin', () => {
  it('embutido usa a skin do ai-manager; standalone sem CRM_UI_SKIN fica sem skin', () => {
    expect(resolveSkin(undefined, true)).toBe('ai-manager')
    expect(resolveSkin(undefined, false)).toBeNull()
    expect(resolveSkin('', false)).toBeNull()
    expect(resolveSkin('%CRM_UI_SKIN%', false)).toBeNull()
  })

  it('CRM_UI_SKIN do build vale também fora do iframe', () => {
    expect(resolveSkin('ai-manager', false)).toBe('ai-manager')
    expect(resolveSkin('default', true)).toBe('ai-manager')
  })
})
