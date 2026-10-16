// T47: projeção de session.* nas conexões, eventos, pausa de runs e e-mail (Postgres descartável; dedupe em memória).
import { randomBytes } from 'node:crypto'
import { chats, companies, companyMembers, connections, contacts, createDb, flowRuns, flows, messages, users, type Database } from '@crm/db'
import { createTempDatabase, type TempDatabase } from '@crm/db/testing'
import { MemoryMailer } from '@crm/node-kit'
import type { SessionState, WaEvent } from '@crm/wa-port'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { memoryAlertDedupe } from './dedupe'
import { ConnectionStatusProjector, type ConnectionStatusOptions } from './projector'

let temp: TempDatabase
let db: Database

beforeAll(async () => {
  temp = await createTempDatabase({ migrate: true })
  db = createDb(temp.url, { max: 4 })
}, 120_000)

afterAll(async () => {
  await db?.$client.end()
  await temp?.drop()
})

const rnd = () => randomBytes(4).toString('hex')
type Pub = { companyId: string; type: string; data: Record<string, any> } // eslint-disable-line @typescript-eslint/no-explicit-any

async function world(opts: { emails?: boolean } = {}) {
  const tag = rnd()
  const [co] = await db
    .insert(companies)
    .values({ name: `Loja ${tag}`, slug: `t47-${tag}`, settings: opts.emails === false ? { connection_status_emails_enabled: false } : {} })
    .returning()
  const member = async (role: 'owner' | 'admin' | 'member') => {
    const [u] = await db.insert(users).values({ email: `${role}-${tag}@x.test`, passwordHash: 'x', name: role }).returning()
    await db.insert(companyMembers).values({ companyId: co!.id, userId: u!.id, role })
    return u!.email
  }
  const emails = { owner: await member('owner'), admin: await member('admin'), member: await member('member') }
  const sessionId = `s-${tag}`
  const [conn] = await db.insert(connections).values({ companyId: co!.id, sessionId, name: 'Vendas', phoneNumber: '+5511988887777' }).returning()
  const published: Pub[] = []
  const mailer = new MemoryMailer({ from: 'no-reply@crm.test' })
  let nowMs = Date.parse('2026-10-16T12:00:00.000Z')
  const make = (over: Partial<ConnectionStatusOptions> = {}) =>
    new ConnectionStatusProjector({
      db,
      publisher: { publish: async (companyId, type, data) => void published.push({ companyId, type, data }) },
      mailer,
      dedupe: memoryAlertDedupe(),
      appName: 'MeuCRM',
      now: () => new Date(nowMs),
      ...over,
    })
  const ev = {
    close: (reason?: 'transient' | 'loggedOut' | 'forbidden', status_code?: number): WaEvent => ({
      v: 1,
      type: 'session.connection',
      session_id: sessionId,
      at: new Date(nowMs).toISOString(),
      state: 'close',
      ...(reason ? { reason } : {}),
      ...(status_code ? { status_code } : {}),
    }),
    open: (): WaEvent => ({ v: 1, type: 'session.connection', session_id: sessionId, at: new Date(nowMs).toISOString(), state: 'open' }),
    state: (from: SessionState | null, to: SessionState): WaEvent => ({ v: 1, type: 'session.state', session_id: sessionId, at: new Date(nowMs).toISOString(), from, to }),
  }
  const types = () => published.map((p) => p.type)
  const of = (type: string) => published.filter((p) => p.type === type)
  const row = async () => (await db.select().from(connections).where(eq(connections.id, conn!.id)))[0]!
  return { companyId: co!.id, connectionId: conn!.id, sessionId, emails, published, mailer, make, ev, types, of, row, advance: (ms: number) => (nowMs += ms) }
}

/** Run `waiting` num chat da conexão (ou de outra conexão). */
async function waitingRun(w: Awaited<ReturnType<typeof world>>, connectionId = w.connectionId, status: 'waiting' | 'running' = 'waiting') {
  const [flow] = await db.insert(flows).values({ companyId: w.companyId, name: `Fluxo ${rnd()}` }).returning()
  const [ct] = await db.insert(contacts).values({ companyId: w.companyId, name: 'C', phoneE164: `+55119${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}` }).returning()
  const [chat] = await db.insert(chats).values({ companyId: w.companyId, contactId: ct!.id, connectionId }).returning()
  const [run] = await db
    .insert(flowRuns)
    .values({ companyId: w.companyId, flowId: flow!.id, contactId: ct!.id, chatId: chat!.id, status, wait: { kind: 'reply', handles: {}, deadline_at: '2026-10-16T12:10:00.000Z' } })
    .returning()
  return { runId: run!.id, flowId: flow!.id, chatId: chat!.id }
}

describe('AC-T47-01 queda transitória', () => {
  it('close transient → connection.disconnected + disconnected_at; o alerta sai no máximo 1 vez em 5 s', async () => {
    const w = await world()
    const p = w.make()
    await p.handle(w.ev.open())
    w.published.length = 0
    await p.handle(w.ev.close('transient'))
    const r = await w.row()
    expect(r).toMatchObject({ connectionState: 'close', lastDisconnectReason: 'transient' })
    expect(r.disconnectedAt?.toISOString()).toBe('2026-10-16T12:00:00.000Z')
    expect(w.of('connection.disconnected')).toHaveLength(1)
    expect(w.of('connection.disconnected')[0]).toMatchObject({
      companyId: w.companyId,
      data: { connection_id: w.connectionId, session_id: w.sessionId, name: 'Vendas', phone_number: '+5511988887777', reason: 'transient', status: 'disconnected', disconnected_at: '2026-10-16T12:00:00.000Z' },
    })
    expect(w.of('connection.disconnected_alert')).toHaveLength(1)

    // 4,999 s depois: nova queda, sem novo alerta; 5 s depois da 1ª: alerta de novo
    w.advance(4_999)
    await p.handle(w.ev.close('transient'))
    expect(w.of('connection.disconnected')).toHaveLength(2)
    expect(w.of('connection.disconnected_alert')).toHaveLength(1)
    w.advance(1)
    await p.handle(w.ev.close('transient'))
    expect(w.of('connection.disconnected_alert')).toHaveLength(2)
    expect(w.of('connection.banned_alert')).toHaveLength(0)
  })
})

describe('AC-T47-02 forbidden e loggedOut', () => {
  it('close forbidden → status banned + connection.banned_alert (sem disconnected_alert)', async () => {
    const w = await world()
    const p = w.make()
    await p.handle(w.ev.open())
    await p.handle(w.ev.close('forbidden', 403))
    expect(await w.row()).toMatchObject({ connectionState: 'close', lastDisconnectReason: 'forbidden', lastStatusCode: 403 })
    expect(w.of('connection.banned_alert')).toHaveLength(1)
    expect(w.of('connection.banned_alert')[0]!.data).toMatchObject({ reason: 'forbidden', status_code: 403, status: 'banned' })
    expect(w.of('connection.disconnected_alert')).toHaveLength(0)
    expect(w.of('connection.status_changed').at(-1)!.data).toMatchObject({ status: 'banned', connection_state: 'close' })
  })

  it('close loggedOut → status disconnected (mesmo com a sessão ainda viva no gateway)', async () => {
    const w = await world()
    const gateway = { sessions: { get: async () => ({ status: 'STABLE' }) } } as never
    const p = w.make({ gateway })
    await p.handle(w.ev.open())
    await p.handle(w.ev.close('loggedOut', 401))
    expect(w.of('connection.disconnected').at(-1)!.data).toMatchObject({ reason: 'loggedOut', status: 'disconnected' })
    expect(w.of('connection.status_changed').at(-1)!.data.status).toBe('disconnected')
    expect(w.of('connection.disconnected_alert')).toHaveLength(1)
  })

  it('transient com a sessão viva no gateway: status connecting (o engine está reconectando)', async () => {
    const w = await world()
    const p = w.make({ gateway: { sessions: { get: async () => ({ status: 'STABLE' }) } } as never })
    await p.handle(w.ev.close('transient'))
    expect(w.of('connection.disconnected')[0]!.data.status).toBe('connecting')
  })
})

describe('AC-T47-03 runs pausados na queda', () => {
  it('queda pausa só os runs waiting da conexão (flow.auto_paused); reconexão publica a contagem', async () => {
    const w = await world()
    const p = w.make()
    await p.handle(w.ev.open())
    const a = await waitingRun(w)
    const b = await waitingRun(w)
    const running = await waitingRun(w, w.connectionId, 'running')
    const [other] = await db.insert(connections).values({ companyId: w.companyId, sessionId: `s-${rnd()}`, name: 'Outra' }).returning()
    const elsewhere = await waitingRun(w, other!.id)

    await p.handle(w.ev.close('transient'))
    const status = async (id: string) => (await db.select().from(flowRuns).where(eq(flowRuns.id, id)))[0]!
    expect((await status(a.runId)).status).toBe('paused')
    expect((await status(b.runId)).status).toBe('paused')
    expect((await status(running.runId)).status).toBe('running')
    expect((await status(elsewhere.runId)).status).toBe('waiting')
    expect((await status(a.runId)).wait).toMatchObject({ kind: 'reply', paused_by: 'connection', connection_id: w.connectionId, paused_at: '2026-10-16T12:00:00.000Z', remaining_ms: 600_000 })
    const auto = w.of('flow.auto_paused')
    expect(auto).toHaveLength(1)
    expect(auto[0]!.data).toMatchObject({ connection_id: w.connectionId, paused_count: 2 })
    expect([...auto[0]!.data.run_ids].sort()).toEqual([a.runId, b.runId].sort())
    expect([...auto[0]!.data.flow_ids].sort()).toEqual([a.flowId, b.flowId].sort())

    // queda repetida: nada mais a pausar → sem novo flow.auto_paused
    await p.handle(w.ev.close('transient'))
    expect(w.of('flow.auto_paused')).toHaveLength(1)

    // mensagem recebida durante a queda conta em received_count
    w.advance(60_000)
    await db.insert(messages).values({ companyId: w.companyId, chatId: a.chatId, direction: 'inbound', senderType: 'contact', type: 'text', status: 'received', body: 'oi', createdAt: new Date('2026-10-16T12:01:00.000Z') })
    // anterior à queda: não conta
    await db.insert(messages).values({ companyId: w.companyId, chatId: a.chatId, direction: 'inbound', senderType: 'contact', type: 'text', status: 'received', body: 'antes', createdAt: new Date('2026-10-16T11:00:00.000Z') })

    await p.handle(w.ev.open())
    expect(w.of('connection.connected')).toHaveLength(2)
    const back = w.of('connection.reconnected_with_paused_flows')
    expect(back).toHaveLength(1)
    expect(back[0]!.data).toMatchObject({ connection_id: w.connectionId, name: 'Vendas', paused_count: 2, total_leads: 2, waiting_count: 0, failed_count: 0, received_count: 1 })
    // open repetido não repete os avisos
    await p.handle(w.ev.open())
    expect(w.of('connection.connected')).toHaveLength(2)
    expect(w.of('connection.reconnected_with_paused_flows')).toHaveLength(1)
  })

  it('reconexão sem runs pausados: só connection.connected', async () => {
    const w = await world()
    const p = w.make()
    await p.handle(w.ev.open())
    await p.handle(w.ev.close('transient'))
    await p.handle(w.ev.open())
    expect(w.of('connection.reconnected_with_paused_flows')).toHaveLength(0)
    expect(w.of('connection.connected')).toHaveLength(2)
  })
})

describe('AC-T47-04 e-mail de desconexão', () => {
  it('uma vez por queda, para owner e admin, com APP_NAME e sem "API Oficial"', async () => {
    const w = await world()
    const p = w.make()
    await p.handle(w.ev.open())
    await p.handle(w.ev.close('transient'))
    w.advance(10_000)
    await p.handle(w.ev.close('transient'))
    expect(w.mailer.sent).toHaveLength(1)
    const mail = w.mailer.sent[0]!
    expect([mail.to].flat().sort()).toEqual([w.emails.owner, w.emails.admin].sort())
    expect(mail.subject).toBe('MeuCRM: a conexão Vendas foi desconectada')
    for (const body of [mail.text!, mail.html!]) {
      expect(body).toContain('MeuCRM')
      expect(body).toContain('Vendas')
      expect(body).not.toMatch(/API Oficial|Official API|WABA/i)
    }
    // voltou e caiu de novo: nova queda, novo e-mail
    await p.handle(w.ev.open())
    await p.handle(w.ev.close('loggedOut'))
    expect(w.mailer.sent).toHaveLength(2)
  })

  it('sem e-mail com connection_status_emails_enabled=false, nem em close de conexão que nunca abriu', async () => {
    const off = await world({ emails: false })
    const p = off.make()
    await p.handle(off.ev.open())
    await p.handle(off.ev.close('transient'))
    expect(off.mailer.sent).toHaveLength(0)
    expect(off.of('connection.disconnected')).toHaveLength(1)

    const fresh = await world()
    await fresh.make().handle(fresh.ev.close('transient'))
    expect(fresh.mailer.sent).toHaveLength(0)
  })

  it('duas réplicas processando o mesmo open → close ao mesmo tempo: 1 e-mail', async () => {
    const w = await world()
    await w.make().handle(w.ev.open())
    const close = w.ev.close('transient')
    await Promise.all([w.make().handle(close), w.make().handle(close)])
    expect(w.mailer.sent).toHaveLength(1)
  })
})

describe('AC-T47-05 sessão sem conexão do CRM', () => {
  it('evento de sessão desconhecida é ignorado: nada gravado, nada publicado, nenhum e-mail', async () => {
    const w = await world()
    const p = w.make()
    const ghost = (e: WaEvent): WaEvent => ({ ...e, session_id: `fantasma-${rnd()}` }) as WaEvent
    for (const e of [w.ev.open(), w.ev.close('forbidden'), w.ev.state('NEW', 'WARMING')]) expect(await p.handle(ghost(e))).toMatchObject({ connectionId: null, published: [] })
    expect(await p.handle({ v: 1, type: 'session.qr', session_id: 'fantasma', at: new Date().toISOString(), qr: 'data:image/png;base64,AA' })).toMatchObject({ connectionId: null })
    expect(w.published).toEqual([])
    expect(w.mailer.sent).toEqual([])
    expect((await w.row()).connectionState).toBeNull()
  })
})

describe('session.state, qr e pairing code', () => {
  it('WARMING antes do open (ordem do engine) e DEGRADED: status recalculado e health_degraded', async () => {
    const w = await world()
    const p = w.make()
    await p.handle(w.ev.close('transient'))
    // o state WARMING chega alguns ms antes do open: ainda "connecting"; o open fecha em "connected"
    await p.handle(w.ev.state('NEW', 'WARMING'))
    expect(w.of('connection.status_changed').at(-1)!.data).toMatchObject({ status: 'connecting', session_state: 'WARMING', badges: ['warming'] })
    await p.handle(w.ev.open())
    expect(w.of('connection.status_changed').at(-1)!.data).toMatchObject({ status: 'connected', connection_state: 'open' })
    await p.handle(w.ev.state('STABLE', 'DEGRADED'))
    expect(w.of('connection.health_degraded')).toHaveLength(1)
    expect(w.of('connection.health_degraded')[0]!.data).toMatchObject({ from: 'STABLE', to: 'DEGRADED' })
    expect(w.of('connection.status_changed').at(-1)!.data).toMatchObject({ status: 'connected', badges: ['degraded'] })
  })

  it('open antes do WARMING também termina connected', async () => {
    const w = await world()
    const p = w.make()
    await p.handle(w.ev.open())
    await p.handle(w.ev.state('NEW', 'WARMING'))
    expect(w.of('connection.status_changed').at(-1)!.data).toMatchObject({ status: 'connected', session_state: 'WARMING' })
  })

  it('qr e pairing code publicam o código e marcam qr_requested_at', async () => {
    const w = await world()
    const p = w.make()
    await p.handle({ v: 1, type: 'session.qr', session_id: w.sessionId, at: new Date().toISOString(), qr: 'data:image/png;base64,QR1' })
    await p.handle({ v: 1, type: 'session.pairing_code', session_id: w.sessionId, at: new Date().toISOString(), code: 'ABCD-1234' })
    expect(w.of('connection.qr_updated')[0]!.data).toEqual({ connection_id: w.connectionId, session_id: w.sessionId, qr_code: 'data:image/png;base64,QR1' })
    expect(w.of('connection.pairing_code')[0]!.data).toEqual({ connection_id: w.connectionId, session_id: w.sessionId, code: 'ABCD-1234' })
    expect((await w.row()).qrRequestedAt).toBeInstanceOf(Date)
  })
})
