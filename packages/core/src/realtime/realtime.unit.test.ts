import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CompanyMember } from '../platform/types'
import { RealtimeConnection, type SseMessage } from './connection'
import type { RealtimeHub } from './hub'
import { RealtimePublisher, eventFromStreamEntry, type FanoutMessage } from './publisher'
import { clearScopeFilters, passesScope, registerScopeFilter } from './scope-filter'
import { compareStreamIds, isStreamId } from './stream-id'
import { realtimeKeys, type RealtimeControl, type RealtimeEvent, type RealtimeRedis } from './types'

const CO = '11111111-1111-4111-8111-111111111111'
const OTHER = '22222222-2222-4222-8222-222222222222'
const USER = '33333333-3333-4333-8333-333333333333'

const member = (role: CompanyMember['role']): CompanyMember => ({ id: 'm1', companyId: CO, userId: USER, role, permissionKeys: null })

/** Hub em memória com a mesma superfície usada pela conexão. */
class FakeHub {
  keys = realtimeKeys()
  history: RealtimeEvent[] = []
  private listeners = new Map<string, Set<(e: RealtimeEvent) => void>>()
  private controls = new Set<(c: RealtimeControl) => void>()
  start = vi.fn(async () => {})
  subscribe(streams: readonly string[], l: (e: RealtimeEvent) => void) {
    for (const s of streams) (this.listeners.get(s) ?? this.listeners.set(s, new Set()).get(s)!).add(l)
    return () => streams.forEach((s) => this.listeners.get(s)?.delete(l))
  }
  onControl(l: (c: RealtimeControl) => void) {
    this.controls.add(l)
    return () => void this.controls.delete(l)
  }
  async replay(streams: readonly string[], afterId: string) {
    const events = this.history.filter((e) => streams.includes(e.stream) && compareStreamIds(e.envelope.id, afterId) > 0)
    return { events, truncated: false }
  }
  emit(e: RealtimeEvent) {
    this.history.push(e)
    for (const l of this.listeners.get(e.stream) ?? []) l(e)
  }
  control(c: RealtimeControl) {
    for (const l of this.controls) l(c)
  }
}

let seq = 0
const ev = (over: Partial<RealtimeEvent> & { companyId?: string; type?: string } = {}): RealtimeEvent => {
  seq += 1
  const companyId = over.companyId ?? CO
  return {
    stream: over.stream ?? realtimeKeys().company(companyId),
    envelope: { id: `1000-${seq}`, type: over.type ?? 'company.updated', company_id: companyId, at: new Date().toISOString(), data: { name: `n${seq}` } },
    scope: over.scope ?? null,
    userId: over.userId ?? null,
  }
}

const tick = () => new Promise((r) => setTimeout(r, 5))

function open(hub: FakeHub, over: Partial<ConstructorParameters<typeof RealtimeConnection>[0]> = {}) {
  const sent: SseMessage[] = []
  const conn = new RealtimeConnection({
    hub: hub as unknown as RealtimeHub,
    companyId: CO,
    userId: USER,
    auth: { kind: 'session', sessionId: 'sess-1' },
    member: member('member'),
    perms: new Set(),
    heartbeatMs: 60_000,
    send: async (m) => void sent.push(m),
    ...over,
  })
  const running = conn.run()
  const events = () => sent.filter((m) => m.event !== 'ping')
  return { conn, sent, running, events }
}

afterEach(() => {
  clearScopeFilters()
  vi.useRealTimers()
})

describe('stream ids', () => {
  it('valida e compara ids `<ms>-<seq>`', () => {
    expect(isStreamId('1700000000000-0')).toBe(true)
    for (const bad of ['', 'abc', '1-', '-1', '1-2-3', null, undefined]) expect(isStreamId(bad)).toBe(false)
    expect(compareStreamIds('10-1', '9-5')).toBeGreaterThan(0)
    expect(compareStreamIds('10-1', '10-2')).toBeLessThan(0)
    expect(compareStreamIds('10-2', '10-2')).toBe(0)
  })
})

describe('scope filters', () => {
  const env = ev().envelope
  it('owner/admin e token de API ignoram o escopo; sem filtro o membro recebe', async () => {
    registerScopeFilter(() => false)
    const scope = { department_id: 'd1' }
    expect(await passesScope({ companyId: CO, userId: USER, role: 'owner', permissionKeys: null }, scope, env)).toBe(true)
    expect(await passesScope({ companyId: CO, userId: USER, role: 'admin', permissionKeys: null }, scope, env)).toBe(true)
    expect(await passesScope(null, scope, env)).toBe(true)
    expect(await passesScope({ companyId: CO, userId: USER, role: 'member', permissionKeys: null }, scope, env)).toBe(false)
    clearScopeFilters()
    expect(await passesScope({ companyId: CO, userId: USER, role: 'member', permissionKeys: null }, scope, env)).toBe(true)
  })

  it('todos os filtros precisam aceitar; filtro que lança nega; unregister desfaz', async () => {
    const subject = { companyId: CO, userId: USER, role: 'member' as const, permissionKeys: null }
    const off = registerScopeFilter(async () => true)
    const off2 = registerScopeFilter(() => {
      throw new Error('x')
    })
    expect(await passesScope(subject, { connection_id: 'c' }, env)).toBe(false)
    off2()
    expect(await passesScope(subject, { connection_id: 'c' }, env)).toBe(true)
    off()
  })
})

describe('RealtimePublisher', () => {
  const fakeRedis = () => {
    const calls: { xadd: unknown[][]; publish: Array<[string, FanoutMessage]> } = { xadd: [], publish: [] }
    const redis = {
      xadd: vi.fn(async (...args: unknown[]) => (calls.xadd.push(args), '1700000000000-7')),
      publish: vi.fn(async (ch: string, msg: string) => (calls.publish.push([ch, JSON.parse(msg)]), 1)),
    }
    return { redis: redis as unknown as RealtimeRedis, calls }
  }

  it('XADD no stream da empresa com MAXLEN ~ e PUBLISH do envelope com o id do stream', async () => {
    const { redis, calls } = fakeRedis()
    const p = new RealtimePublisher({ redis, now: () => new Date('2026-10-16T00:00:00Z') })
    const id = await p.publish(CO, 'company.updated', { name: 'X' }, { scope: { department_id: 'd1' } })
    expect(id).toBe('1700000000000-7')
    expect(calls.xadd[0]!.slice(0, 5)).toEqual([`crm:rt:${CO}`, 'MAXLEN', '~', 10_000, '*'])
    expect(calls.publish[0]).toEqual([
      'crm:rt',
      {
        k: 'event',
        event: {
          stream: `crm:rt:${CO}`,
          envelope: { id, type: 'company.updated', company_id: CO, at: '2026-10-16T00:00:00.000Z', data: { name: 'X' } },
          scope: { department_id: 'd1' },
          userId: null,
        },
      },
    ])
  })

  it('evento por usuário vai para crm:rt:user:<id>; tipo fora do catálogo ou data inválida lançam', async () => {
    const { redis, calls } = fakeRedis()
    const p = new RealtimePublisher({ redis })
    await p.publish(CO, 'member.permissions_changed', { user_id: USER }, { userId: USER })
    expect(calls.xadd[0]![0]).toBe(`crm:rt:user:${USER}`)
    await expect(p.publish(CO, 'nao.existe' as never, {} as never)).rejects.toThrow(/catálogo/)
    await expect(p.publish(CO, 'company.updated', { name: 42 } as never)).rejects.toThrow()
    expect(calls.xadd).toHaveLength(1)
  })

  it('endSession/endUserSessions publicam controle', async () => {
    const { redis, calls } = fakeRedis()
    const p = new RealtimePublisher({ redis })
    await p.endSession('s1')
    await p.endUserSessions(USER)
    expect(calls.publish.map(([, m]) => m)).toEqual([
      { k: 'control', control: { kind: 'end_session', sessionId: 's1' } },
      { k: 'control', control: { kind: 'end_user', userId: USER } },
    ])
  })

  it('eventFromStreamEntry reconstrói o evento do XRANGE', () => {
    const e = eventFromStreamEntry('crm:rt:x', '5-1', ['type', 'company.updated', 'company_id', CO, 'at', 'T', 'data', '{"a":1}', 'scope', '{"department_id":"d"}'])
    expect(e).toEqual({ stream: 'crm:rt:x', envelope: { id: '5-1', type: 'company.updated', company_id: CO, at: 'T', data: { a: 1 } }, scope: { department_id: 'd' }, userId: null })
    expect(eventFromStreamEntry('s', '1-1', ['type', 'x'])).toBeNull()
  })
})

describe('RealtimeConnection', () => {
  it('manda ping inicial com retry e entrega só eventos da empresa, com id e envelope', async () => {
    const hub = new FakeHub()
    const c = open(hub)
    await tick()
    expect(c.sent[0]).toEqual({ event: 'ping', data: '', retry: 3000 })
    const mine = ev()
    hub.emit(ev({ companyId: OTHER }))
    hub.emit(mine)
    await tick()
    expect(c.events()).toEqual([{ event: 'company.updated', id: mine.envelope.id, data: JSON.stringify(mine.envelope) }])
    c.conn.close()
    await c.running
  })

  it('evento de outro usuário (stream do usuário) não é entregue', async () => {
    const hub = new FakeHub()
    const c = open(hub)
    await tick()
    hub.emit(ev({ stream: hub.keys.user(USER), userId: 'outro' }))
    hub.emit(ev({ stream: hub.keys.user(USER), userId: USER }))
    await tick()
    expect(c.events()).toHaveLength(1)
    c.conn.close()
  })

  it('escopo: membro fora do escopo não recebe; owner recebe', async () => {
    registerScopeFilter((_s, scope) => scope.department_id === 'meu')
    const hub = new FakeHub()
    const m = open(hub)
    const o = open(hub, { member: member('owner') })
    await tick()
    hub.emit(ev({ scope: { department_id: 'outro' } }))
    hub.emit(ev({ scope: { department_id: 'meu' } }))
    await tick()
    expect(m.events()).toHaveLength(1)
    expect(o.events()).toHaveLength(2)
    m.conn.close()
    o.conn.close()
  })

  it('replay do Last-Event-ID em ordem, sem duplicar o que chega ao vivo durante o replay', async () => {
    const hub = new FakeHub()
    const old = ev()
    const missed1 = ev()
    const missed2 = ev()
    hub.history.push(old, missed1, missed2)
    const replay = hub.replay.bind(hub)
    // Durante o replay chega ao vivo um evento já incluído no replay e um novo.
    const live = ev()
    hub.replay = async (streams, after) => {
      const r = await replay(streams, after)
      hub.emit(missed2)
      hub.emit(live)
      return r
    }
    const c = open(hub, { lastEventId: old.envelope.id })
    await tick()
    expect(c.events().map((m) => m.id)).toEqual([missed1.envelope.id, missed2.envelope.id, live.envelope.id])
    c.conn.close()
  })

  it('heartbeat: ping a cada intervalo, reconfere o acesso e fecha quando a sessão cai', async () => {
    vi.useFakeTimers()
    const hub = new FakeHub()
    let active = true
    const checkAccess = vi.fn(async () => (active ? { member: member('member'), perms: new Set<string>() } : null))
    const c = open(hub, { heartbeatMs: 1000, checkAccess })
    await vi.advanceTimersByTimeAsync(2100)
    expect(c.sent.filter((m) => m.event === 'ping')).toHaveLength(3)
    expect(checkAccess).toHaveBeenCalledTimes(2)
    active = false
    await vi.advanceTimersByTimeAsync(1000)
    expect(c.conn.closed).toBe(true)
    await c.running
  })

  it('controle end_session fecha só a sessão certa; end_user fecha o usuário', async () => {
    const hub = new FakeHub()
    const a = open(hub)
    const b = open(hub, { auth: { kind: 'session', sessionId: 'sess-2' } })
    await tick()
    hub.control({ kind: 'end_session', sessionId: 'sess-1' })
    expect(a.conn.closed).toBe(true)
    expect(b.conn.closed).toBe(false)
    hub.control({ kind: 'end_user', userId: USER })
    expect(b.conn.closed).toBe(true)
    await Promise.all([a.running, b.running])
  })
})
