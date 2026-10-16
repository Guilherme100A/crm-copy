import { afterEach, describe, expect, it, vi } from 'vitest'
import { api, configureHttp, HttpError, PROFILE_PATH } from './http'
import { isSafeRedirect, loginPath, safeRedirect } from './redirect'
import { isThemeShortcut } from './theme'
import { dispatchRealtime, onRealtime, RealtimeConnection, type EventSourceLike } from './realtime'
import { crumbsFor } from '@/app/shell/breadcrumbs'

describe('redirect seguro (AC-T23-01)', () => {
  it('aceita só caminhos relativos da SPA', () => {
    expect(isSafeRedirect('/chats?x=1')).toBe(true)
    for (const bad of ['//evil.com', 'https://evil.com', '/x://y', '/\\evil.com', 'chats', '/a\tb', '']) expect(isSafeRedirect(bad)).toBe(false)
    expect(safeRedirect('//evil', '/welcome')).toBe('/welcome')
    expect(loginPath('/crms?id=1')).toBe('/login?redirect=%2Fcrms%3Fid%3D1')
    expect(loginPath('/login?redirect=x')).toBe('/login')
  })
})

describe('atalho de tema (AC-T23-03)', () => {
  const ev = (o: Partial<Parameters<typeof isThemeShortcut>[0]>) => ({ key: 'm', ctrlKey: true, metaKey: false, altKey: false, shiftKey: false, repeat: false, target: null, ...o })
  it('Ctrl/Cmd+M fora de campos', () => {
    expect(isThemeShortcut(ev({}))).toBe(true)
    expect(isThemeShortcut(ev({ ctrlKey: false, metaKey: true }))).toBe(true)
    expect(isThemeShortcut(ev({ key: 'M' }))).toBe(true)
    expect(isThemeShortcut(ev({ ctrlKey: true, metaKey: true }))).toBe(false)
    expect(isThemeShortcut(ev({ shiftKey: true }))).toBe(false)
    expect(isThemeShortcut(ev({ repeat: true }))).toBe(false)
    expect(isThemeShortcut(ev({ target: { tagName: 'INPUT' } as never }))).toBe(false)
    expect(isThemeShortcut(ev({ target: { tagName: 'DIV', isContentEditable: true } as never }))).toBe(false)
  })
})

describe('cliente HTTP (AC-T23-06)', () => {
  afterEach(() => configureHttp({ fetch: (i, init) => fetch(i, init), companyId: null, onUnauthorized: () => undefined }))

  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

  it('envia cookie, X-Company-Id e X-Requested-With; deduplica GETs em voo', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = []
    configureHttp({ companyId: 'c1', fetch: async (url, init) => (calls.push({ url, init }), json(200, { ok: true })) })
    const [a, b] = await Promise.all([api.get('/api/x', { query: { page: 1, tags: ['a', 'b'] } }), api.get('/api/x', { query: { page: 1, tags: ['a', 'b'] } })])
    expect(a).toEqual(b)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe('/api/x?page=1&tags=a&tags=b')
    expect(calls[0]!.init.headers).toMatchObject({ 'X-Company-Id': 'c1', 'X-Requested-With': 'crm' })
    expect(calls[0]!.init.credentials).toBe('same-origin')
  })

  it('401 em chamadas simultâneas → UMA sonda de perfil → login uma vez', async () => {
    let probes = 0
    const onUnauthorized = vi.fn()
    configureHttp({
      onUnauthorized,
      fetch: async (url, init) => {
        if (url === PROFILE_PATH && init.method === 'GET') probes++
        return json(401, { error: { code: 'UNAUTHORIZED', message: 'x' } })
      },
    })
    const results = await Promise.allSettled([api.post('/api/a', {}), api.put('/api/auth/profile', { locale: 'en' }), api.get('/api/b')])
    expect(results.every((r) => r.status === 'rejected' && r.reason instanceof HttpError && r.reason.status === 401)).toBe(true)
    expect(probes).toBe(1)
    expect(onUnauthorized).toHaveBeenCalledTimes(1)
  })

  it('o GET do próprio perfil não sonda; 401 com sessão viva não desloga', async () => {
    const onUnauthorized = vi.fn()
    let probes = 0
    configureHttp({
      onUnauthorized,
      fetch: async (url) => {
        if (url === PROFILE_PATH) {
          probes++
          return json(200, { user: {} })
        }
        return json(401, { error: { code: 'UNAUTHORIZED', message: 'x' } })
      },
    })
    await expect(api.get('/api/z')).rejects.toBeInstanceOf(HttpError)
    expect(probes).toBe(1)
    expect(onUnauthorized).not.toHaveBeenCalled()
    configureHttp({ fetch: async () => json(401, { error: { code: 'UNAUTHORIZED', message: 'x' } }) })
    await expect(api.get(PROFILE_PATH)).rejects.toMatchObject({ status: 401 })
  })
})

describe('realtime', () => {
  it('despacha por tipo e reabre quando o EventSource fecha', () => {
    const sources: Array<EventSourceLike & { emit(type: string, data: string): void }> = []
    const create = () => {
      const listeners = new Map<string, (e: MessageEvent) => void>()
      const s = {
        readyState: 1,
        addEventListener: (t: string, l: (e: MessageEvent) => void) => listeners.set(t, l),
        close: () => (s.readyState = 2),
        emit: (t: string, data: string) => listeners.get(t)?.({ data, lastEventId: '1-0' } as MessageEvent),
      }
      sources.push(s)
      return s
    }
    const got: string[] = []
    const off = onRealtime('chat.updated', (e) => got.push(`${e.type}:${(e.data as { chat_id: string }).chat_id}`))
    const conn = new RealtimeConnection({ companyId: 'c1', queryClient: { invalidateQueries: vi.fn() } as never, createEventSource: create })
    expect(conn.url).toBe('/api/events?company_id=c1')
    conn.open()
    sources[0]!.emit('chat.updated', JSON.stringify({ id: '1-0', type: 'chat.updated', company_id: 'c1', at: 'x', data: { chat_id: 'k' } }))
    expect(got).toEqual(['chat.updated:k'])
    conn.ensure()
    expect(sources).toHaveLength(1)
    sources[0]!.readyState = 2
    conn.ensure()
    expect(sources).toHaveLength(2)
    conn.close()
    conn.ensure()
    expect(sources).toHaveLength(2)
    off()
    dispatchRealtime({ id: '2', type: 'chat.updated', company_id: 'c1', at: 'x', data: { chat_id: 'z' } }, {} as never)
    expect(got).toHaveLength(1)
  })
})

describe('breadcrumbs', () => {
  it('ignora welcome e ids; o último não é link', () => {
    expect(crumbsFor('/settings/inbound-webhooks', (s) => (s === 'settings' ? 'Configurações' : null))).toEqual([
      { label: 'Configurações', to: '/settings' },
      { label: 'Inbound Webhooks', to: null },
    ])
    expect(crumbsFor('/flows/123/edit', () => null).map((c) => c.label)).toEqual(['Flows', 'Edit'])
    expect(crumbsFor('/welcome', () => null)).toEqual([])
  })
})
