// Agendamentos (T64) com Postgres real: validação, fila (fake), execução pelo ChatSendService real + FakeWaGateway.
import { randomBytes } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { and, eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chats, companies, companyMembers, connections, contacts, createDb, flows, messageSchedules, messages, users, type Database } from '@crm/db'
import { createTempDatabase, type TempDatabase } from '@crm/db/testing'
import { FsBlobStore } from '@crm/node-kit'
import { FakeWaGateway } from '@crm/wa-port/testing'
import { ChatSendService } from '../chats/send/service'
import { MediaService } from '../media/service'
import { runSchedule } from './runner'
import { SCHEDULE_MAX_MS, type ScheduleJobData } from './rules'
import { SchedulesService } from './service'

let temp: TempDatabase
let db: Database
let dir: string

beforeAll(async () => {
  temp = await createTempDatabase({ migrate: true })
  db = createDb(temp.url, { max: 6 })
  dir = await mkdtemp(join(tmpdir(), 't64-'))
}, 120_000)

afterAll(async () => {
  await db?.$client.end()
  await temp?.drop()
  await rm(dir, { recursive: true, force: true })
})

let clock = Date.parse('2026-10-16T12:00:00Z')
const now = () => new Date(clock)

async function setup() {
  const slug = `c-${randomBytes(4).toString('hex')}`
  const [company] = await db.insert(companies).values({ name: slug, slug }).returning({ id: companies.id })
  const companyId = company!.id
  const [user] = await db.insert(users).values({ email: `${slug}@x.com`, passwordHash: 'x', name: 'Bia' }).returning({ id: users.id })
  await db.insert(companyMembers).values({ companyId, userId: user!.id, role: 'owner' })
  const [contact] = await db.insert(contacts).values({ companyId, name: 'Ana', phoneE164: '+5511999990001' }).returning({ id: contacts.id })
  const [conn] = await db.insert(connections).values({ companyId, sessionId: `sess-${slug}`, name: 'Conexão' }).returning({ id: connections.id })
  const [chat] = await db.insert(chats).values({ companyId, connectionId: conn!.id, contactId: contact!.id }).returning({ id: chats.id })
  const [flow] = await db.insert(flows).values({ companyId, name: 'Lembrete', publishedVersion: 1 }).returning({ id: flows.id })
  const [draft] = await db.insert(flows).values({ companyId, name: 'Rascunho' }).returning({ id: flows.id })
  const gw = new FakeWaGateway({ sessions: [{ id: 'sess-1', state: 'STABLE' }] })
  const jobs: { added: Array<[ScheduleJobData, number]>; removed: ScheduleJobData[] } = { added: [], removed: [] }
  const fakeJobs = { add: async (j: ScheduleJobData, d: number) => void jobs.added.push([j, d]), remove: async (j: ScheduleJobData) => void jobs.removed.push(j) }
  const svc = new SchedulesService({ db, jobs: fakeJobs, now })
  const send = new ChatSendService({
    db,
    waGateway: gw,
    resolveSession: async () => 'sess-1',
    media: new MediaService({ blobStore: new FsBlobStore(dir), signingKey: Buffer.alloc(32, 1) }),
    pttConverter: async (d, m) => ({ audio: d, mime: m, seconds: 1 }),
  })
  const started: unknown[] = []
  const enqueued: Array<[ScheduleJobData, number]> = []
  const deps = {
    db,
    send,
    flows: { startRun: async (ctx: unknown, input: unknown) => (started.push({ ctx, input }), { runId: '00000000-0000-4000-8000-00000000f001', expectedSeq: 0 }) },
    enqueue: async (j: ScheduleJobData, d: number) => void enqueued.push([j, d]),
    now,
  }
  const actor = { companyId, userId: user!.id, perms: new Set(['chat.view']) }
  return { companyId, userId: user!.id, chatId: chat!.id, contactId: contact!.id, flowId: flow!.id, draftFlowId: draft!.id, gw, svc, jobs, deps, started, enqueued, actor }
}

const iso = (ms: number) => new Date(ms).toISOString()
const fields = async (p: Promise<unknown>) => ((await p.catch((e: unknown) => e)) as { details?: { fields?: { path: string }[] } }).details?.fields?.map((f) => f.path)

describe('criar (AC-T64-01)', () => {
  it('mensagem até 31 dias enfileira o job com o atraso certo', async () => {
    const s = await setup()
    const at = clock + SCHEDULE_MAX_MS
    const sch = await s.svc.create(s.actor, s.chatId, { kind: 'message', text: '  Lembrete da consulta  ', run_at: iso(at) })
    expect(sch).toMatchObject({ kind: 'message', text: 'Lembrete da consulta', status: 'pending', recurrence: 'one_off', run_at: iso(at), created_by_user_id: s.userId })
    expect(s.jobs.added).toEqual([[{ scheduleId: sch.id, runAt: iso(at) }, SCHEDULE_MAX_MS]])
  })

  it('passado, além de 31 dias e conteúdo faltando → validation', async () => {
    const s = await setup()
    expect(await fields(s.svc.create(s.actor, s.chatId, { kind: 'message', text: 'x', run_at: iso(clock - 1000) }))).toEqual(['run_at'])
    expect(await fields(s.svc.create(s.actor, s.chatId, { kind: 'message', text: 'x', run_at: iso(clock + SCHEDULE_MAX_MS + 1000) }))).toEqual(['run_at'])
    expect(await fields(s.svc.create(s.actor, s.chatId, { kind: 'message', text: '  ', run_at: iso(clock + 60_000) }))).toEqual(['text'])
    expect(await fields(s.svc.create(s.actor, s.chatId, { kind: 'flow', run_at: iso(clock + 60_000) }))).toEqual(['flow_id'])
    expect(await fields(s.svc.create(s.actor, s.chatId, { kind: 'flow', flow_id: s.draftFlowId, run_at: iso(clock + 60_000) }))).toEqual(['flow_id'])
    expect(await fields(s.svc.create(s.actor, s.chatId, { kind: 'message', text: 'x', run_at: 'amanhã' }))).toEqual(['run_at'])
    expect(s.jobs.added).toEqual([])
    const other = await setup()
    await expect(s.svc.create(s.actor, other.chatId, { kind: 'message', text: 'x', run_at: iso(clock + 60_000) })).rejects.toMatchObject({ code: 'not_found' })
  })
})

describe('executar (AC-T64-02)', () => {
  it('mensagem sai pelo WaGateway em nome de quem agendou e fica sent', async () => {
    const s = await setup()
    const sch = await s.svc.create(s.actor, s.chatId, { kind: 'message', text: 'Olá, seu pedido chegou', run_at: iso(clock + 60_000) })
    const r = await runSchedule(s.deps, { scheduleId: sch.id, runAt: sch.run_at })
    expect(r).toMatchObject({ executed: true, status: 'sent', message_id: expect.any(String) })
    expect(s.gw.sent).toHaveLength(1)
    expect(s.gw.sent[0]).toMatchObject({ phone: '+5511999990001', content: { text: 'Olá, seu pedido chegou' }, actor: `crm:${s.userId}` })
    const [msg] = await db.select().from(messages).where(and(eq(messages.chatId, s.chatId), eq(messages.direction, 'outbound')))
    expect(msg).toMatchObject({ senderType: 'user', senderUserId: s.userId, body: 'Olá, seu pedido chegou' })
    const [row] = await db.select().from(messageSchedules).where(eq(messageSchedules.id, sch.id))
    expect(row).toMatchObject({ status: 'sent', runCount: 1, lastMessageId: msg!.id, lastError: null })
    // repetir o mesmo job não envia de novo
    expect(await runSchedule(s.deps, { scheduleId: sch.id, runAt: sch.run_at })).toEqual({ executed: false, reason: 'not_pending' })
    expect(s.gw.sent).toHaveLength(1)
  })

  it('fluxo agendado cria o run com o chat e o gatilho schedule', async () => {
    const s = await setup()
    const sch = await s.svc.create(s.actor, s.chatId, { kind: 'flow', flow_id: s.flowId, run_at: iso(clock + 60_000) })
    expect(await runSchedule(s.deps, { scheduleId: sch.id, runAt: sch.run_at })).toMatchObject({ executed: true, status: 'sent', flow_run_id: '00000000-0000-4000-8000-00000000f001' })
    expect(s.started).toEqual([{ ctx: { companyId: s.companyId }, input: { flowId: s.flowId, contactId: s.contactId, chatId: s.chatId, trigger: { kind: 'schedule', schedule_id: sch.id } } }])
    const [row] = await db.select().from(messageSchedules).where(eq(messageSchedules.id, sch.id))
    expect(row!.lastFlowRunId).toBe('00000000-0000-4000-8000-00000000f001')
  })

  it('falha one_off → failed com o erro', async () => {
    const s = await setup()
    const sch = await s.svc.create(s.actor, s.chatId, { kind: 'flow', flow_id: s.flowId, run_at: iso(clock + 60_000) })
    const r = await runSchedule({ ...s.deps, flows: { startRun: async () => Promise.reject(new Error('fluxo pausado')) } }, { scheduleId: sch.id, runAt: sch.run_at })
    expect(r).toMatchObject({ executed: true, status: 'failed', error: 'fluxo pausado' })
    const [row] = await db.select().from(messageSchedules).where(eq(messageSchedules.id, sch.id))
    expect(row).toMatchObject({ status: 'failed', lastError: 'fluxo pausado' })
  })
})

describe('recorrência (AC-T64-03)', () => {
  it('diária: mesmo registro volta a pending no dia seguinte e enfileira o próximo job', async () => {
    const s = await setup()
    const first = clock + 60_000
    const sch = await s.svc.create(s.actor, s.chatId, { kind: 'message', text: 'Bom dia!', run_at: iso(first), recurrence: 'daily' })
    clock = first + 5_000
    const r = await runSchedule(s.deps, { scheduleId: sch.id, runAt: sch.run_at })
    const next = iso(first + 24 * 3600_000)
    expect(r).toMatchObject({ executed: true, status: 'pending', next_run_at: next })
    expect(s.enqueued).toEqual([[{ scheduleId: sch.id, runAt: next }, first + 24 * 3600_000 - clock]])
    const [row] = await db.select().from(messageSchedules).where(eq(messageSchedules.id, sch.id))
    expect(row).toMatchObject({ status: 'pending', runCount: 1, recurrence: 'daily' })
    expect(row!.runAt.toISOString()).toBe(next)
    // o job antigo (run_at anterior) agora é stale
    expect(await runSchedule(s.deps, { scheduleId: sch.id, runAt: sch.run_at })).toEqual({ executed: false, reason: 'stale' })
    expect(s.gw.sent).toHaveLength(1)
  })

  it('semanal e mensal; recorrente com falha continua pending', async () => {
    const s = await setup()
    const at = Date.parse('2026-10-31T13:00:00Z')
    clock = at - 3600_000
    const monthly = await s.svc.create(s.actor, s.chatId, { kind: 'flow', flow_id: s.flowId, run_at: iso(at), recurrence: 'monthly' })
    const weekly = await s.svc.create(s.actor, s.chatId, { kind: 'flow', flow_id: s.flowId, run_at: iso(at), recurrence: 'weekly' })
    clock = at
    const failing = { ...s.deps, flows: { startRun: async () => Promise.reject(new Error('x')) } }
    expect(await runSchedule(failing, { scheduleId: monthly.id, runAt: monthly.run_at })).toMatchObject({ status: 'pending', next_run_at: '2026-11-30T13:00:00.000Z', error: 'x' })
    expect(await runSchedule(s.deps, { scheduleId: weekly.id, runAt: weekly.run_at })).toMatchObject({ status: 'pending', next_run_at: '2026-11-07T13:00:00.000Z' })
    const [m] = await db.select().from(messageSchedules).where(eq(messageSchedules.id, monthly.id))
    expect(m).toMatchObject({ status: 'pending', lastError: 'x' })
  })
})

describe('cancelar e listar (AC-T64-04)', () => {
  it('cancelar remove o job; executar cancelado não envia; lista filtra por chat e status', async () => {
    const s = await setup()
    const a = await s.svc.create(s.actor, s.chatId, { kind: 'message', text: 'a', run_at: iso(clock + 60_000) })
    const b = await s.svc.create(s.actor, s.chatId, { kind: 'message', text: 'b', run_at: iso(clock + 120_000) })
    const cancelled = await s.svc.cancel(s.actor, a.id)
    expect(cancelled.status).toBe('cancelled')
    expect(s.jobs.removed).toEqual([{ scheduleId: a.id, runAt: a.run_at }])
    await expect(s.svc.cancel(s.actor, a.id)).rejects.toMatchObject({ code: 'conflict' })
    expect(await runSchedule(s.deps, { scheduleId: a.id, runAt: a.run_at })).toEqual({ executed: false, reason: 'not_pending' })
    expect(s.gw.sent).toHaveLength(0)

    const page = await s.svc.list(s.actor, { chatId: s.chatId, page: 1, limit: 20 })
    expect(page.items.map((x) => x.id)).toEqual([b.id, a.id])
    expect(page.page.total_count).toBe(2)
    expect((await s.svc.list(s.actor, { chatId: s.chatId, status: 'cancelled', page: 1, limit: 20 })).items.map((x) => x.id)).toEqual([a.id])
    expect((await s.svc.list(s.actor, { status: 'pending', page: 1, limit: 20 })).items.map((x) => x.id)).toEqual([b.id])
    const other = await setup()
    await expect(other.svc.get(other.actor, b.id)).rejects.toMatchObject({ code: 'not_found' })
    expect((await other.svc.list(other.actor, { page: 1, limit: 20 })).items).toEqual([])
  })
})
