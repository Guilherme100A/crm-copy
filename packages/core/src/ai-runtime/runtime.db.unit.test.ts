// Runtime do agente (T68) com Postgres real e fakes (FakeLlm/FakeStt/FakeTts, FakeWaGateway).
import { randomBytes } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { and, eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { LlmRequest } from '@crm/ai'
import { FakeLlm, FakeStt, FakeTts, text, toolCall } from '@crm/ai/testing'
import { aiConversationState, chats, companies, connections, contacts, createDb, departments, llmPrices, messages, type Database } from '@crm/db'
import { createTempDatabase, type TempDatabase } from '@crm/db/testing'
import { FsBlobStore, redisConnection } from '@crm/node-kit'
import { FakeWaGateway } from '@crm/wa-port/testing'
import { UsageGuard } from '../ai-metering/guard'
import { AiAgentsService } from '../ai-agents'
import type { CrmInboundEvent } from '../chats/ingest/chat-ingest'
import { MediaService } from '../media/service'
import { AiAgentRuntime, type AiAgentRuntimeOptions } from './runtime'
import type { AiTurnJobData } from './scheduler'

let temp: TempDatabase
let db: Database
let storage: string
let media: MediaService
const rnd = () => randomBytes(4).toString('hex')
type Published = { type: string; data: Record<string, unknown> }

/**
 * Agendador do buffer com relógio virtual (T126): mesma semântica do `memoryTurnScheduler` (um agendamento novo do
 * chat substitui o anterior), mas o tempo só anda com `advance(ms)`, que roda os turnos vencidos na ordem.
 */
function virtualTurnScheduler() {
  let now = 0
  let run: (job: AiTurnJobData) => Promise<unknown> = async () => undefined
  const timers = new Map<string, { due: number; job: AiTurnJobData }>()
  return {
    bind(fn: (job: AiTurnJobData) => Promise<unknown>) {
      run = fn
    },
    async schedule(job: AiTurnJobData, delayMs: number) {
      timers.set(job.chatId, { due: now + Math.max(0, delayMs), job })
    },
    async advance(ms: number) {
      now += ms
      const due = [...timers.entries()].filter(([, t]) => t.due <= now).sort((a, b) => a[1].due - b[1].due)
      for (const [chatId, t] of due) {
        timers.delete(chatId)
        await run(t.job)
      }
    },
  }
}

beforeAll(async () => {
  temp = await createTempDatabase({ migrate: true })
  db = createDb(temp.url, { max: 8 })
  storage = await mkdtemp(join(tmpdir(), 't68-'))
  media = new MediaService({ blobStore: new FsBlobStore(storage), signingKey: Buffer.alloc(32, 3) })
}, 60_000)

afterAll(async () => {
  await db?.$client.end()
  await temp?.drop()
  await rm(storage, { recursive: true, force: true })
})

interface Setup {
  companyId: string
  chatId: string
  contactId: string
  agentId: string
  gateway: FakeWaGateway
  published: Published[]
  runtime: AiAgentRuntime
  llm: FakeLlm
  stt: FakeStt
  tts: FakeTts
  inbound(text: string | null, extra?: Partial<typeof messages.$inferInsert>): Promise<string>
}

async function setup(opts: {
  settings?: Record<string, unknown>
  skills?: (companyId: string) => Promise<unknown[]>
  script?: ReturnType<typeof text>[]
  runtime?: Partial<AiAgentRuntimeOptions>
  sttText?: string
} = {}): Promise<Setup> {
  const [co] = await db.insert(companies).values({ name: 'C', slug: `c-${rnd()}` }).returning({ id: companies.id })
  const companyId = co!.id
  const phone = `+55119${Math.floor(10_000_000 + Math.random() * 89_999_999)}`
  const [ct] = await db.insert(contacts).values({ companyId, name: 'Ana', phoneE164: phone }).returning({ id: contacts.id })
  const agents = new AiAgentsService({ db, providerKeys: { isConfigured: () => true } })
  const agent = await agents.create(companyId, {
    name: 'Leo',
    generated_prompt: 'Você é o Leo, vendedor.',
    model: { provider: 'anthropic', model: 'm' },
    settings: { buffer_enabled: false, split_messages: false, ...opts.settings },
    skills: ((await opts.skills?.(companyId)) ?? []) as never,
  })
  await agents.publish(companyId, agent.id)
  const [conn] = await db.insert(connections).values({ companyId, sessionId: `sess-${rnd()}`, name: 'Principal' }).returning({ id: connections.id })
  const [chat] = await db.insert(chats).values({ companyId, connectionId: conn!.id, contactId: ct!.id, aiAgentId: agent.id }).returning({ id: chats.id })
  const gateway = new FakeWaGateway({ sessions: [{ id: 'sess-1', state: 'STABLE' }] })
  const published: Published[] = []
  const llm = new FakeLlm(opts.script ?? [text('Olá! Como posso ajudar?')])
  const stt = new FakeStt({ text: opts.sttText ?? 'transcrição' })
  const tts = new FakeTts()
  const runtime = new AiAgentRuntime({
    db,
    llm,
    stt,
    tts,
    waGateway: gateway,
    resolveSession: async () => 'sess-1',
    media,
    publisher: { publish: async (_c, type, data) => void published.push({ type, data: data as Record<string, unknown> }) },
    logger: { warn: (o, m) => console.warn(m, o), error: (o, m) => console.error(m, o) },
    ...opts.runtime,
  })
  const inbound = async (body: string | null, extra: Partial<typeof messages.$inferInsert> = {}) => {
    const waId = `w-${rnd()}`
    const [m] = await db
      .insert(messages)
      .values({ companyId, chatId: chat!.id, direction: 'inbound', senderType: 'contact', type: 'text', body, status: 'received', waMessageId: waId, ...extra })
      .returning({ id: messages.id, type: messages.type })
    const e: CrmInboundEvent = {
      company_id: companyId,
      connection_id: conn!.id,
      session_id: 'sess-1',
      chat_id: chat!.id,
      contact_id: ct!.id,
      message_id: m!.id,
      wa_message_id: waId,
      type: m!.type,
      text: body,
      from_me: false,
      chat_created: false,
      chat_reopened: false,
    }
    await runtime.onInbound(e)
    return m!.id
  }
  return { companyId, chatId: chat!.id, contactId: ct!.id, agentId: agent.id, gateway, published, runtime, llm, stt, tts, inbound }
}

const lastUserText = (req: LlmRequest) => {
  const u = [...req.messages].reverse().find((m) => m.role === 'user')
  return (u?.content as { type: string; text?: string }[]).map((p) => p.text ?? '').join('')
}
const chatRow = async (id: string) => (await db.select().from(chats).where(eq(chats.id, id)))[0]!
const stateRow = async (id: string) => (await db.select().from(aiConversationState).where(eq(aiConversationState.chatId, id)))[0]!

describe('AC-T68-01 buffer', () => {
  it('mensagens picadas dentro do buffer viram um único turno com todas na ordem', async () => {
    // Proporção do AC: 3 mensagens em 3 s com buffer de 5 s. T126: relógio virtual (agendador injetado no runtime) em
    // vez de sleep real — sob carga o tempo de cada inbound não pode encurtar a janela medida.
    const clock = virtualTurnScheduler()
    const s = await setup({ settings: { buffer_enabled: true, buffer_seconds: 5 }, runtime: { scheduler: clock } })
    clock.bind((job) => s.runtime.runTurn(job))
    await s.inbound('oi')
    await clock.advance(1500)
    await s.inbound('quero saber')
    await clock.advance(1500)
    await s.inbound('do plano anual')
    // cada mensagem reinicia a contagem: 4,999 s depois da última ainda não houve turno
    await clock.advance(4999)
    expect(s.llm.callCount).toBe(0)
    await clock.advance(1)
    await s.runtime.idle()
    expect(s.llm.callCount).toBe(1)
    expect(lastUserText(s.llm.calls[0]!)).toBe('oi\nquero saber\ndo plano anual')
    expect(s.gateway.sent).toHaveLength(1)
    // nada pendente: o tempo seguir não gera outro turno
    await clock.advance(60_000)
    expect(s.llm.callCount).toBe(1)
  })

  it('flush roda o turno pendente na hora', async () => {
    const s = await setup({ settings: { buffer_enabled: true, buffer_seconds: 60 } })
    await s.inbound('a')
    await s.inbound('b')
    await s.runtime.flush(s.chatId)
    expect(s.llm.callCount).toBe(1)
    expect(lastUserText(s.llm.calls[0]!)).toBe('a\nb')
  })
})

describe('AC-T68-02 transferir para humano', () => {
  it('a tool desliga o agente, atribui o departamento e publica chat.updated', async () => {
    let depId = ''
    const s = await setup({
      skills: async (companyId) => {
        const [d] = await db.insert(departments).values({ companyId, name: 'Suporte' }).returning({ id: departments.id })
        depId = d!.id
        return [{ when_text: 'cliente pede para falar com um humano', action_type: 'transfer_human', action_params: { department_id: depId } }]
      },
      script: [toolCall('transfer_human', { reason: 'pediu humano' }), text('Vou te passar para um atendente.')],
    })
    await s.inbound('quero falar com uma pessoa')
    await s.runtime.flush(s.chatId)
    expect(s.llm.calls[0]!.tools!.map((t) => t.name)).toContain('transfer_human')
    const chat = await chatRow(s.chatId)
    expect(chat).toMatchObject({ aiAgentId: null, departmentId: depId, status: 'waiting' })
    expect(await stateRow(s.chatId)).toMatchObject({ paused: true, pausedReason: 'transfer_human' })
    expect(s.published.some((p) => p.type === 'chat.updated' && p.data.chat_id === s.chatId)).toBe(true)
    // agente desligado: nova mensagem não chama o LLM
    await s.inbound('alô?')
    await s.runtime.flush(s.chatId)
    expect(s.llm.callCount).toBe(1)
  })
})

describe('AC-T68-03 áudio', () => {
  it('áudio recebido é transcrito antes do turno; resposta com preço nunca vira áudio', async () => {
    const s = await setup({ sttText: 'quanto custa o plano', script: [toolCall('send_audio', {}), text('O plano custa R$ 99,90 por mês.')] })
    const handle = { session_id: 'sess-1', message_id: 'wa-audio-1', mime: 'audio/ogg', size: 10, sha256: null, key: null, status: 'ready' }
    s.gateway.setMedia('wa-audio-1', new Uint8Array([1, 2, 3, 4]))
    await s.inbound(null, { type: 'audio', media: handle })
    await s.runtime.flush(s.chatId)
    expect(s.stt.calls).toHaveLength(1)
    expect(lastUserText(s.llm.calls[0]!)).toBe('[áudio] quanto custa o plano')
    expect(s.tts.calls).toHaveLength(0)
    const [sent] = await db.select().from(messages).where(and(eq(messages.chatId, s.chatId), eq(messages.direction, 'outbound')))
    expect(sent).toMatchObject({ type: 'text', senderType: 'ai' })
  })

  it('sem link/preço e dentro do limite, o áudio pedido vira nota de voz', async () => {
    const s = await setup({ script: [toolCall('send_audio', {}), text('Claro, posso te ajudar com isso agora mesmo.')] })
    await s.inbound('me explica por áudio')
    await s.runtime.flush(s.chatId)
    expect(s.tts.calls).toHaveLength(1)
    const [sent] = await db.select().from(messages).where(and(eq(messages.chatId, s.chatId), eq(messages.direction, 'outbound')))
    expect(sent!.type).toBe('audio')
    expect((await stateRow(s.chatId)).audioCount).toBe(1)
  })
})

describe('AC-T68-04 pause_on_human', () => {
  it('mensagem de atendente pausa o agente no chat', async () => {
    const s = await setup({ script: [text('primeira resposta'), text('não deveria')] })
    await s.inbound('oi')
    await s.runtime.flush(s.chatId)
    expect(s.llm.callCount).toBe(1)
    await db.insert(messages).values({ companyId: s.companyId, chatId: s.chatId, direction: 'outbound', senderType: 'user', type: 'text', body: 'assumo daqui', status: 'sent' })
    await s.inbound('e agora?')
    await s.runtime.flush(s.chatId)
    expect(s.llm.callCount).toBe(1)
    expect(await stateRow(s.chatId)).toMatchObject({ paused: true, pausedReason: 'human' })
  })
})

describe('AC-T68-05 sem saldo', () => {
  async function exhausted(action: 'notify' | 'flow' | 'none') {
    const redis = redisConnection({ url: process.env.REDIS_URL ?? 'redis://127.0.0.1:6379/1' })
    const flowsCalls: unknown[] = []
    const flowId = '00000000-0000-4000-8000-0000000000f1'
    const s = await setup({
      settings: { no_balance_action: action, no_balance_flow_id: flowId, no_balance_notify_phone: '11988887777', no_balance_notify_message: 'Agente sem saldo' },
      runtime: {
        guard: new UsageGuard({ db, redis, prefix: `crm:ai:used:t68-${rnd()}` }),
        flows: { startRun: async (_ctx, input) => void flowsCalls.push(input) },
      },
    })
    await db.insert(llmPrices).values({ provider: 'anthropic', model: 'm', effectiveFrom: new Date('2020-01-01'), inputPerMtokMicros: 1_000_000, outputPerMtokMicros: 1_000_000 }).onConflictDoNothing()
    await s.inbound('oi')
    await s.runtime.flush(s.chatId)
    redis.disconnect()
    return { s, flowsCalls, flowId }
  }

  it('notify: nenhuma chamada ao LLM, handoff e aviso pelo gateway', async () => {
    const { s } = await exhausted('notify')
    expect(s.llm.callCount).toBe(0)
    expect(await stateRow(s.chatId)).toMatchObject({ paused: true, pausedReason: 'no_balance' })
    expect((await chatRow(s.chatId)).aiAgentId).toBeNull()
    expect(s.gateway.sent.map((m) => m.phone)).toEqual(['+5511988887777'])
    expect(s.gateway.sent[0]!.actor).toBe(`crm:ai:${s.agentId}`)
  })

  it('flow: dispara o fluxo configurado', async () => {
    const { s, flowsCalls, flowId } = await exhausted('flow')
    expect(s.llm.callCount).toBe(0)
    expect(flowsCalls).toEqual([expect.objectContaining({ flowId, contactId: s.contactId, chatId: s.chatId })])
    expect(s.gateway.sent).toHaveLength(0)
  })
})

describe('AC-T68-06 envio como agente e providerData', () => {
  it('sender_type ai, actor crm:ai:<id> e providerData reenviado no turno seguinte', async () => {
    const s = await setup({ script: [text('Oi!', { providerData: { sig: 'abc' } }), text('Tudo certo.')] })
    await s.inbound('oi')
    await s.runtime.flush(s.chatId)
    await s.inbound('tudo bem?')
    await s.runtime.flush(s.chatId)
    expect(s.gateway.sent.map((m) => m.actor)).toEqual([`crm:ai:${s.agentId}`, `crm:ai:${s.agentId}`])
    const out = await db.select().from(messages).where(and(eq(messages.chatId, s.chatId), eq(messages.direction, 'outbound')))
    expect(out.every((m) => m.senderType === 'ai' && m.senderUserId === null)).toBe(true)
    const second = s.llm.calls[1]!
    expect(second.messages).toContainEqual({ role: 'assistant', content: [{ type: 'text', text: 'Oi!' }], providerData: { sig: 'abc' } })
    // o agente não assume o chat (sem auto-atribuição)
    expect((await chatRow(s.chatId)).assignedUserId).toBeNull()
  })
})

describe('T120 voz por empresa (resolveTts/resolveStt)', () => {
  it('usa o TTS/STT resolvido para a empresa do chat', async () => {
    const companyTts = new FakeTts()
    const companyStt = new FakeStt({ text: 'quero por áudio' })
    const seen: string[] = []
    const s = await setup({
      script: [toolCall('send_audio', {}), text('Claro, posso te ajudar com isso agora mesmo.')],
      runtime: {
        tts: undefined,
        stt: undefined,
        resolveTts: async (companyId) => (seen.push(`tts:${companyId}`), companyTts),
        resolveStt: async (companyId) => (seen.push(`stt:${companyId}`), companyStt),
      },
    })
    const handle = { session_id: 'sess-1', message_id: 'wa-audio-t120', mime: 'audio/ogg', size: 4, sha256: null, key: null, status: 'ready' }
    s.gateway.setMedia('wa-audio-t120', new Uint8Array([1, 2, 3, 4]))
    await s.inbound(null, { type: 'audio', media: handle })
    await s.runtime.flush(s.chatId)
    expect(companyStt.calls).toHaveLength(1)
    expect(companyTts.calls).toHaveLength(1)
    expect(seen).toEqual([`stt:${s.companyId}`, `tts:${s.companyId}`])
    const [sent] = await db.select().from(messages).where(and(eq(messages.chatId, s.chatId), eq(messages.direction, 'outbound')))
    expect(sent!.type).toBe('audio')
  })

  it('empresa sem chave de voz: a resposta sai em texto', async () => {
    const s = await setup({
      script: [toolCall('send_audio', {}), text('Claro, posso te ajudar com isso agora mesmo.')],
      runtime: { tts: undefined, resolveTts: async () => Promise.reject(new Error('sem chave elevenlabs')) },
    })
    await s.inbound('me explica por áudio')
    await s.runtime.flush(s.chatId)
    const [sent] = await db.select().from(messages).where(and(eq(messages.chatId, s.chatId), eq(messages.direction, 'outbound')))
    expect(sent).toMatchObject({ type: 'text', senderType: 'ai' })
  })
})
