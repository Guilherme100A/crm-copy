// Postgres real: precedência dos gatilhos, resposta para run em espera, idempotência, supressão por atendente/IA e
// ação fora do horário com janela de 12 h (AC-T61-01..05).
import { and, eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  aiAgents,
  aiConversationState,
  businessHourConfigs,
  businessHours,
  chats,
  companies,
  connectionFlowConfigs,
  connections,
  contacts,
  createDb,
  flowRuns,
  flowTriggerEvents,
  keywordTriggers,
  messages,
  users,
  type Database,
  type KeywordCondition,
} from '@crm/db'
import { createTempDatabase, type TempDatabase } from '@crm/db/testing'
import type { FlowDefinition } from '@crm/shared'
import type { SendRequest } from '@crm/wa-port'
import { FlowStore } from '../store/store'
import { FlowControl } from '../engine/control'
import { FlowEngine } from '../engine/runner'
import type { CrmInboundEvent } from '../../chats/ingest/chat-ingest'
import { FlowTriggers, OUT_OF_HOURS_ACTOR } from './triggers'

let tmp: TempDatabase
let db: Database
let n = 0
beforeAll(async () => {
  tmp = await createTempDatabase({ migrate: true })
  db = createDb(tmp.url, { max: 10 })
}, 60_000)
afterAll(async () => {
  await db?.$client.end()
  await tmp?.drop()
})

const node = (id: string, type: string) => ({ id, type, name: id, position: { x: 0, y: 0 }, actions: [] })

interface World {
  companyId: string
  connectionId: string
  sessionId: string
  contactId: string
  chatId: string
  flows: Record<string, string>
  triggers: FlowTriggers
  sent: SendRequest[]
  clock: { t: Date }
}

/** Empresa, conexão, contato, chat e fluxos publicados (start → fim). */
async function world(names: string[] = ['welcome', 'default', 'finished', 'kw', 'kw2', 'ooh', 'attendance']): Promise<World> {
  n += 1
  const [c] = await db.insert(companies).values({ name: `C${n}`, slug: `c-t61-${n}-${Date.now()}`, timeZone: 'America/Sao_Paulo' }).returning()
  const companyId = c!.id
  const sessionId = `s-t61-${n}-${Date.now()}`
  const [conn] = await db.insert(connections).values({ companyId, sessionId, name: `Conexão ${n}` }).returning()
  const [contact] = await db.insert(contacts).values({ companyId, name: 'Ana', phoneE164: `+55119777${String(n).padStart(5, '0')}` }).returning()
  const [chat] = await db.insert(chats).values({ companyId, connectionId: conn!.id, contactId: contact!.id }).returning()
  const store = new FlowStore(db)
  const flows: Record<string, string> = {}
  for (const name of names) {
    const flow = await store.createFlow({ companyId }, { name: `${name}-${n}` })
    const def: FlowDefinition = { schema: 'crm.flow/v1', entry: 'start', nodes: [node('start', 'start')], edges: [], variables: [], refs: {} }
    await store.fromDefinition({ companyId }, flow.id, def)
    await store.publish({ companyId }, flow.id)
    flows[name] = flow.id
  }
  const clock = { t: new Date('2026-10-14T15:00:00Z') } // quarta, 12:00 em São Paulo
  const now = () => clock.t
  const control = new FlowControl({ db, timers: { schedule: async () => undefined, cancel: async () => undefined }, now })
  const engine = new FlowEngine({ db, wa: { send: async () => ({}) } as never, hooks: control.engineHooks(), now })
  const sent: SendRequest[] = []
  const triggers = new FlowTriggers({ db, engine, control, now, waGateway: { send: async (req) => (sent.push(req), {}) as never } })
  return { companyId, connectionId: conn!.id, sessionId, contactId: contact!.id, chatId: chat!.id, flows, triggers, sent, clock }
}

async function configure(w: World, values: Partial<typeof connectionFlowConfigs.$inferInsert>, kws: { flow: string; rule?: 'any' | 'all'; conditions: KeywordCondition[]; active?: boolean; position?: number }[] = []) {
  const [cfg] = await db.insert(connectionFlowConfigs).values({ companyId: w.companyId, connectionId: w.connectionId, ...values }).returning()
  for (const [i, k] of kws.entries())
    await db.insert(keywordTriggers).values({ companyId: w.companyId, configId: cfg!.id, flowId: w.flows[k.flow]!, ruleType: k.rule ?? 'any', conditions: k.conditions, active: k.active ?? true, position: k.position ?? i })
}

/** Mensagem recebida gravada (como o ingest faz) e o evento `crm.inbound` correspondente. */
async function inbound(w: World, text: string | null, opts: { created?: boolean; reopened?: boolean; at?: Date } = {}): Promise<CrmInboundEvent> {
  const [m] = await db
    .insert(messages)
    .values({ companyId: w.companyId, chatId: w.chatId, direction: 'inbound', senderType: 'contact', type: 'text', body: text, status: 'received', createdAt: opts.at ?? w.clock.t })
    .returning()
  return {
    company_id: w.companyId,
    connection_id: w.connectionId,
    session_id: w.sessionId,
    chat_id: w.chatId,
    contact_id: w.contactId,
    message_id: m!.id,
    wa_message_id: `WA-${m!.id}`,
    type: 'text',
    text,
    from_me: false,
    chat_created: opts.created ?? false,
    chat_reopened: opts.reopened ?? false,
  }
}

const runsOf = (w: World) => db.select().from(flowRuns).where(eq(flowRuns.contactId, w.contactId))
const activeRuns = async (w: World) => (await runsOf(w)).filter((r) => r.status === 'running' || r.status === 'waiting')

describe('AC-T61-01 palavra-chave', () => {
  it('casada dispara o fluxo dela mesmo com boas-vindas configurada (chat novo)', async () => {
    const w = await world()
    await configure(w, { welcomeFlowId: w.flows.welcome }, [{ flow: 'kw', conditions: [{ keyword: 'preço', match_type: 'contains' }] }])
    const r = await w.triggers.handleInbound(await inbound(w, 'Qual o PRECO?', { created: true }))
    expect(r).toMatchObject({ outcome: 'keyword', flow_id: w.flows.kw })
    const runs = await runsOf(w)
    expect(runs).toHaveLength(1)
    expect(runs[0]).toMatchObject({ flowId: w.flows.kw, chatId: w.chatId, trigger: { type: 'keyword', message_id: expect.any(String), keyword_trigger_id: r.keyword_trigger_id } })
  })

  it('any/all, ordem por posição, gatilho inativo ignorado e os seis tipos de casamento', async () => {
    const w = await world()
    await configure(w, {}, [
      { flow: 'kw', active: false, conditions: [{ keyword: 'oi', match_type: 'contains' }], position: 0 },
      { flow: 'kw2', rule: 'all', conditions: [{ keyword: 'quero', match_type: 'starts_with' }, { keyword: 'plano', match_type: 'ends_with' }], position: 1 },
      { flow: 'kw', rule: 'any', conditions: [{ keyword: 'menu', match_type: 'equals' }, { keyword: 'sair', match_type: 'excludes' }], position: 2 },
    ])
    // all: começa com "quero" E termina com "plano" → kw2 (antes do kw pela posição).
    expect(await w.triggers.handleInbound(await inbound(w, 'Quero o plano'))).toMatchObject({ outcome: 'keyword', flow_id: w.flows.kw2 })
    // all falha (não termina com "plano"); any do 3º casa por "excludes sair" → kw (cancela o run anterior).
    expect(await w.triggers.handleInbound(await inbound(w, 'quero falar'))).toMatchObject({ outcome: 'keyword', flow_id: w.flows.kw })
    const runs = await runsOf(w)
    expect(runs.map((r) => r.status).sort()).toEqual(['cancelled', 'running'])
    // "different": casa quando o texto é diferente da palavra.
    const w2 = await world()
    await configure(w2, {}, [{ flow: 'kw', conditions: [{ keyword: 'sim', match_type: 'different' }] }])
    expect((await w2.triggers.handleInbound(await inbound(w2, 'sim'))).outcome).toBe('none')
    expect((await w2.triggers.handleInbound(await inbound(w2, 'talvez'))).outcome).toBe('keyword')
  })

  it('vale mesmo com atendente humano no chat', async () => {
    const w = await world()
    const [u] = await db.insert(users).values({ email: `u${n}-${Date.now()}@x.com`, passwordHash: 'x', name: 'Atendente' }).returning()
    await db.update(chats).set({ status: 'attending', assignedUserId: u!.id }).where(eq(chats.id, w.chatId))
    await configure(w, { welcomeFlowId: w.flows.welcome }, [{ flow: 'kw', conditions: [{ keyword: 'menu', match_type: 'equals' }] }])
    expect(await w.triggers.handleInbound(await inbound(w, 'menu', { created: true }))).toMatchObject({ outcome: 'keyword' })
  })
})

describe('AC-T61-02 boas-vindas e resposta padrão', () => {
  it('boas-vindas só no primeiro contato (chat criado)', async () => {
    const w = await world()
    await configure(w, { welcomeFlowId: w.flows.welcome })
    expect(await w.triggers.handleInbound(await inbound(w, 'oi', { created: true }))).toMatchObject({ outcome: 'welcome', flow_id: w.flows.welcome })
    await db.update(flowRuns).set({ status: 'completed' }).where(eq(flowRuns.contactId, w.contactId))
    expect((await w.triggers.handleInbound(await inbound(w, 'oi de novo'))).outcome).toBe('none')
    expect(await runsOf(w)).toHaveLength(1)
  })

  it('resposta padrão só após delay_hours sem mensagem do contato', async () => {
    const w = await world()
    await configure(w, { defaultResponseFlowId: w.flows.default, defaultResponseDelayHours: 4 })
    const t0 = w.clock.t
    await inbound(w, 'antiga', { at: new Date(t0.getTime() - 3 * 3600_000) })
    expect((await w.triggers.handleInbound(await inbound(w, 'cedo demais'))).outcome).toBe('none')
    w.clock.t = new Date(t0.getTime() + 5 * 3600_000)
    const r = await w.triggers.handleInbound(await inbound(w, 'depois do atraso', { at: w.clock.t }))
    expect(r).toMatchObject({ outcome: 'default_response', flow_id: w.flows.default })
  })

  it('conversa finalizada quando o contato reabre; sem boas-vindas o chat novo cai na resposta padrão', async () => {
    const w = await world()
    await configure(w, { finishedConversationFlowId: w.flows.finished, defaultResponseFlowId: w.flows.default })
    expect(await w.triggers.handleInbound(await inbound(w, 'voltei', { reopened: true }))).toMatchObject({ outcome: 'finished_conversation', flow_id: w.flows.finished })
    const w2 = await world()
    await configure(w2, { defaultResponseFlowId: w2.flows.default })
    expect((await w2.triggers.handleInbound(await inbound(w2, 'primeira', { created: true }))).outcome).toBe('default_response')
  })

  it('automáticos não começam se o contato já tem run ativo', async () => {
    const w = await world()
    await configure(w, { welcomeFlowId: w.flows.welcome })
    await db.insert(flowRuns).values({ companyId: w.companyId, flowId: w.flows.kw!, contactId: w.contactId, status: 'running', seq: 0 })
    expect(await w.triggers.handleInbound(await inbound(w, 'oi', { created: true }))).toMatchObject({ outcome: 'active_run', flow_id: w.flows.welcome })
    expect(await activeRuns(w)).toHaveLength(1)
  })
})

describe('AC-T61-03 resposta para run em espera e idempotência', () => {
  it('mensagem para run waiting (reply) vai para o run: nenhum gatilho, nem palavra-chave', async () => {
    const w = await world()
    await configure(w, { welcomeFlowId: w.flows.welcome }, [{ flow: 'kw', conditions: [{ keyword: 'oi', match_type: 'contains' }] }])
    const [run] = await db
      .insert(flowRuns)
      .values({ companyId: w.companyId, flowId: w.flows.finished!, contactId: w.contactId, status: 'waiting', seq: 1, wait: { kind: 'reply', handles: { reply: 'source' } } })
      .returning()
    expect(await w.triggers.handleInbound(await inbound(w, 'oi', { created: true }))).toEqual({ outcome: 'run_reply' })
    expect((await runsOf(w)).map((r) => r.id)).toEqual([run!.id])
  })

  it('run que já recebeu a mensagem (listener da T30 rodou antes) também conta como resposta', async () => {
    const w = await world()
    await configure(w, { defaultResponseFlowId: w.flows.default })
    const e = await inbound(w, 'resposta')
    await db.insert(flowRuns).values({ companyId: w.companyId, flowId: w.flows.finished!, contactId: w.contactId, status: 'completed', seq: 3, vars: { reply: { message_id: e.message_id, text: 'resposta' } } })
    expect((await w.triggers.handleInbound(e)).outcome).toBe('run_reply')
  })

  it('o mesmo evento entregue duas vezes (inclusive em paralelo) cria um run só', async () => {
    const w = await world()
    await configure(w, { welcomeFlowId: w.flows.welcome })
    const e = await inbound(w, 'oi', { created: true })
    const [a, b] = await Promise.all([w.triggers.handleInbound(e), w.triggers.handleInbound(e)])
    expect([a.outcome, b.outcome].sort()).toEqual(['duplicate', 'welcome'])
    expect((await w.triggers.handleInbound(e)).outcome).toBe('duplicate')
    expect(await runsOf(w)).toHaveLength(1)
    const [row] = await db.select().from(flowTriggerEvents).where(eq(flowTriggerEvents.messageId, e.message_id))
    expect(row).toMatchObject({ outcome: 'welcome', flowId: w.flows.welcome })
  })
})

describe('AC-T61-04 supressão por atendente humano ou agente de IA', () => {
  it('chat em atendimento humano não recebe boas-vindas nem resposta padrão', async () => {
    const w = await world()
    const [u] = await db.insert(users).values({ email: `h${n}-${Date.now()}@x.com`, passwordHash: 'x', name: 'Humano' }).returning()
    await db.update(chats).set({ status: 'attending', assignedUserId: u!.id }).where(eq(chats.id, w.chatId))
    await configure(w, { welcomeFlowId: w.flows.welcome, defaultResponseFlowId: w.flows.default })
    expect((await w.triggers.handleInbound(await inbound(w, 'oi', { created: true }))).outcome).toBe('suppressed')
    expect((await w.triggers.handleInbound(await inbound(w, 'oi 2'))).outcome).toBe('suppressed')
    expect(await runsOf(w)).toHaveLength(0)
  })

  it('agente de IA ativo suprime; agente pausado no chat ou inativo não suprime', async () => {
    const w = await world()
    const [agent] = await db.insert(aiAgents).values({ companyId: w.companyId, status: 'active' }).returning()
    await db.update(chats).set({ aiAgentId: agent!.id }).where(eq(chats.id, w.chatId))
    await configure(w, { welcomeFlowId: w.flows.welcome, defaultResponseFlowId: w.flows.default })
    expect((await w.triggers.handleInbound(await inbound(w, 'oi', { created: true }))).outcome).toBe('suppressed')
    await db.insert(aiConversationState).values({ chatId: w.chatId, companyId: w.companyId, agentId: agent!.id, paused: true, pausedReason: 'human' })
    expect((await w.triggers.handleInbound(await inbound(w, 'oi 2'))).outcome).toBe('default_response')
  })
})

describe('AC-T61-05 ação fora do horário', () => {
  /** Seg–sex 09:00–18:00 em São Paulo. */
  async function hours(w: World, action: { actionType: 'message' | 'flow'; messageText?: string; flowId?: string }) {
    const [cfg] = await db
      .insert(businessHourConfigs)
      .values({ companyId: w.companyId, connectionId: w.connectionId, active: true, actionType: action.actionType, messageText: action.messageText ?? null, flowId: action.flowId ?? null })
      .returning()
    for (const day of [1, 2, 3, 4, 5]) await db.insert(businessHours).values({ companyId: w.companyId, configId: cfg!.id, dayOfWeek: day, startTime: '09:00', endTime: '18:00' })
  }

  it('mensagem uma vez por janela de 12 h no fuso da empresa; dentro do horário não roda', async () => {
    const w = await world()
    await hours(w, { actionType: 'message', messageText: 'Voltamos às 9h' })
    // Quarta 12:00 em SP: aberto.
    expect((await w.triggers.handleInbound(await inbound(w, 'oi'))).out_of_hours).toBeNull()
    // Quarta 22:00 em SP (01:00 UTC de quinta): fechado → envia.
    w.clock.t = new Date('2026-10-15T01:00:00Z')
    expect((await w.triggers.handleInbound(await inbound(w, 'alguém?'))).out_of_hours).toBe('message')
    expect(w.sent).toEqual([
      expect.objectContaining({ sessionId: w.sessionId, phone: expect.stringMatching(/^\+55/), content: { text: 'Voltamos às 9h' }, actor: OUT_OF_HOURS_ACTOR }),
    ])
    expect(w.sent[0]).not.toHaveProperty('contactId')
    // 11 h depois (sábado não; quinta 09:00 = aberto). Fica em sábado de madrugada para seguir fechado.
    w.clock.t = new Date('2026-10-15T08:00:00Z') // quinta 05:00 SP, 7 h depois
    expect((await w.triggers.handleInbound(await inbound(w, 'oi?'))).out_of_hours).toBe('window')
    w.clock.t = new Date('2026-10-15T13:30:00Z') // quinta 10:30 SP: aberto
    expect((await w.triggers.handleInbound(await inbound(w, 'bom dia'))).out_of_hours).toBeNull()
    w.clock.t = new Date('2026-10-16T01:30:00Z') // quinta 22:30 SP, 24,5 h após o envio
    expect((await w.triggers.handleInbound(await inbound(w, 'de novo'))).out_of_hours).toBe('message')
    expect(w.sent).toHaveLength(2)
  })

  it('fluxo fora do horário inicia um run (uma vez na janela) e ocupa o contato', async () => {
    const w = await world()
    await hours(w, { actionType: 'flow', flowId: w.flows.ooh })
    await configure(w, { welcomeFlowId: w.flows.welcome })
    w.clock.t = new Date('2026-10-18T15:00:00Z') // domingo: fechado
    const r = await w.triggers.handleInbound(await inbound(w, 'oi', { created: true }))
    expect(r).toMatchObject({ outcome: 'none', out_of_hours: 'flow', flow_id: w.flows.ooh })
    expect((await activeRuns(w)).map((x) => x.flowId)).toEqual([w.flows.ooh])
    await db.update(flowRuns).set({ status: 'completed' }).where(eq(flowRuns.contactId, w.contactId))
    expect((await w.triggers.handleInbound(await inbound(w, 'oi 2'))).out_of_hours).toBe('window')
  })

  it('não roda com atendente humano nem quando a mensagem foi para um run', async () => {
    const w = await world()
    await hours(w, { actionType: 'message', messageText: 'Fechado' })
    w.clock.t = new Date('2026-10-18T15:00:00Z')
    await db.insert(flowRuns).values({ companyId: w.companyId, flowId: w.flows.kw!, contactId: w.contactId, status: 'waiting', seq: 1, wait: { kind: 'reply', handles: {} } })
    expect((await w.triggers.handleInbound(await inbound(w, 'resposta'))).outcome).toBe('run_reply')
    await db.update(flowRuns).set({ status: 'completed', wait: null }).where(eq(flowRuns.contactId, w.contactId))
    const [u] = await db.insert(users).values({ email: `o${n}-${Date.now()}@x.com`, passwordHash: 'x', name: 'H' }).returning()
    await db.update(chats).set({ status: 'attending', assignedUserId: u!.id }).where(eq(chats.id, w.chatId))
    expect((await w.triggers.handleInbound(await inbound(w, 'oi'))).outcome).toBe('suppressed')
    expect(w.sent).toHaveLength(0)
  })
})

describe('atendimento finalizado', () => {
  it('inicia o fluxo configurado ao concluir o atendimento', async () => {
    const w = await world()
    await configure(w, { finishedAttendanceFlowId: w.flows.attendance })
    const r = await w.triggers.handleAttendanceFinished({ companyId: w.companyId, chatId: w.chatId })
    expect(r).toMatchObject({ flow_id: w.flows.attendance, run_id: expect.any(String) })
    const [run] = await db.select().from(flowRuns).where(and(eq(flowRuns.contactId, w.contactId), eq(flowRuns.flowId, w.flows.attendance!)))
    expect(run?.trigger).toEqual({ type: 'finished_attendance' })
  })
})
