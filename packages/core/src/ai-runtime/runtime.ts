// Runtime do agente de IA (T68; 07 §3.2, §3.3, §5): turno disparado pelo `crm.inbound` de chat com agente ativo.
// Buffer → entrada (texto, áudio transcrito, imagem descrita) → LLM medido com as habilidades como tools →
// resposta (dividida, assinada, áudio opcional) pelo ChatSendService como agente (sender_type `ai`).
// Chamadas internas rodam como sistema (sem escopo de usuário, como na T119).
import { and, desc, eq, gt, inArray, sql } from 'drizzle-orm'
import { z } from 'zod'
import {
  LlmQuotaExceededError,
  llmTool,
  type LlmMessage,
  type LlmProvider,
  type LlmProviderId,
  type LlmResult,
  type LlmTool,
  type SttProvider,
  type TtsProvider,
} from '@crm/ai'
import { aiAgents, aiConversationState, chatEvents, chats, companies, contacts, messages, type AiPauseReason, type Database } from '@crm/db'
import type { WaGateway } from '@crm/wa-port'
import { meterLlm } from '../ai-metering/meter'
import type { UsageGuard } from '../ai-metering/guard'
import { AiAgentsService, type AgentDto } from '../ai-agents'
import { BusinessHoursService } from '../business-hours/service'
import { isOpen } from '../business-hours/is-open'
import type { CrmInboundEvent, ChatPublisher } from '../chats/ingest/chat-ingest'
import { ChatLifecycleService } from '../chats/lifecycle/service'
import { chatScope, toChatDto } from '../chats/model/dto'
import { ChatSendService, type PttConverter, type Sender, type SessionResolver } from '../chats/send/service'
import { KanbanService, systemActor } from '../kanban/service'
import type { MediaService } from '../media/service'
import { memoryTurnScheduler, type AiTurnJobData, type TurnScheduler } from './scheduler'
import { canSpeak, splitReply } from './text-rules'

export const AI_FEATURE = 'ai_agent'
export const HISTORY_LIMIT = 40

export interface FlowStarter {
  startRun(ctx: { companyId: string }, input: { flowId: string; contactId: string; chatId?: string | null; trigger?: Record<string, unknown> | null }): Promise<unknown>
}

export interface KnowledgeSearch {
  search(input: { companyId: string; agentId: string; query: string }): Promise<string[]>
}

export interface TurnInfo {
  chatId: string
  messageIds: string[]
  llmCalls: number
  sent: string[]
  skipped?: string
}

export interface AiAgentRuntimeOptions {
  db: Database
  llm: LlmProvider
  waGateway: Pick<WaGateway, 'send' | 'react' | 'deleteForEveryone' | 'presence' | 'downloadMedia'>
  resolveSession: SessionResolver
  media: MediaService
  stt?: SttProvider
  tts?: TtsProvider
  /**
   * STT/TTS por empresa (BYOK, T38 `resolveStt`/`resolveTts`; T120). Têm precedência sobre `stt`/`tts`; erro na
   * resolução (empresa sem chave) = sem o recurso nesta mensagem (texto em vez de áudio, áudio não transcrito).
   */
  resolveStt?: (companyId: string) => Promise<SttProvider>
  resolveTts?: (companyId: string) => Promise<TtsProvider>
  pttConverter?: PttConverter
  publisher?: ChatPublisher
  /** Cobrança/cota (T24). Sem guard o LLM é chamado sem medição. */
  guard?: UsageGuard
  /** Agendador do buffer (padrão: em memória). */
  scheduler?: TurnScheduler
  flows?: FlowStarter
  knowledge?: KnowledgeSearch
  /** Envio pronto (testes); padrão: ChatSendService montado com as dependências acima. */
  send?: ChatSendService
  onTurn?: (info: TurnInfo) => void | Promise<void>
  now?: () => Date
  logger?: { warn(obj: object, msg?: string): void; error(obj: object, msg?: string): void }
}

type StateRow = typeof aiConversationState.$inferSelect
type ChatRow = typeof chats.$inferSelect

/** Efeitos das tools num turno. */
interface TurnEffects {
  handoff: { reason: AiPauseReason; departmentId?: string | null } | null
  audio: boolean
  progress: boolean
  closed: boolean
}

const VISION_SCHEMA = z.object({
  description: z.string(),
  is_receipt: z.boolean(),
  amount_cents: z.number().int().nullable().optional(),
  pix_key: z.string().nullable().optional(),
  recipient_name: z.string().nullable().optional(),
})

const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim()

async function toBytes(body: ReadableStream<Uint8Array> | Uint8Array): Promise<Uint8Array> {
  if (body instanceof Uint8Array) return body
  const chunks: Uint8Array[] = []
  const reader = body.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (value) chunks.push(value)
  }
  return Buffer.concat(chunks)
}

export class AiAgentRuntime {
  readonly scheduler: TurnScheduler
  private readonly db: Database
  private readonly agents: AiAgentsService
  private readonly lifecycle: ChatLifecycleService
  private readonly kanban: KanbanService
  private readonly hours: BusinessHoursService
  private readonly send: ChatSendService
  private readonly now: () => Date
  private readonly memory?: ReturnType<typeof memoryTurnScheduler>

  constructor(private readonly opts: AiAgentRuntimeOptions) {
    this.db = opts.db
    this.now = opts.now ?? (() => new Date())
    this.agents = new AiAgentsService({ db: opts.db })
    this.lifecycle = new ChatLifecycleService({ db: opts.db, ...(opts.publisher ? { publisher: opts.publisher } : {}) })
    this.kanban = new KanbanService({ db: opts.db })
    this.hours = new BusinessHoursService(opts.db)
    this.send =
      opts.send ??
      new ChatSendService({
        db: opts.db,
        waGateway: opts.waGateway,
        resolveSession: opts.resolveSession,
        media: opts.media,
        pttConverter: opts.pttConverter ?? (async (data, mime) => ({ audio: data, mime, seconds: 0 })),
        ...(opts.publisher ? { publisher: opts.publisher } : {}),
      })
    if (opts.scheduler) this.scheduler = opts.scheduler
    else {
      this.memory = memoryTurnScheduler(
        (job) => this.runTurn(job),
        (err, job) => this.opts.logger?.error({ err, chatId: job.chatId }, 'ai agent: falha no turno'),
      )
      this.scheduler = this.memory
    }
  }

  /** Roda agora o turno pendente do chat (agendador em memória) ou, sem pendência, o turno de qualquer forma. */
  async flush(chatId: string): Promise<void> {
    if (this.memory?.pending().includes(chatId)) return this.memory.flush(chatId)
    const [st] = await this.db.select().from(aiConversationState).where(eq(aiConversationState.chatId, chatId))
    if (st && (st.pending as string[]).length) await this.runTurn({ companyId: st.companyId, chatId, gen: st.bufferGen })
  }

  /** Espera os turnos em andamento (agendador em memória). */
  async idle(): Promise<void> {
    await this.memory?.idle()
  }

  /** `crm.inbound` (T33): mensagem nova de contato. Agenda o turno se o chat tem agente ativo (AC-T68-01). */
  async onInbound(e: CrmInboundEvent): Promise<void> {
    const chat = await this.chat(e.company_id, e.chat_id)
    if (!chat?.aiAgentId) return
    const [agentRow] = await this.db.select({ id: aiAgents.id, status: aiAgents.status }).from(aiAgents).where(eq(aiAgents.id, chat.aiAgentId))
    if (!agentRow || agentRow.status !== 'active') return
    const agent = await this.agents.get(e.company_id, agentRow.id)
    const state = await this.ensureState(chat, agent.id)
    if (state.paused) return
    if (await this.pausedByHuman(chat, state, agent)) return

    const [updated] = await this.db
      .update(aiConversationState)
      .set({ pending: sql`${aiConversationState.pending} || ${JSON.stringify([e.message_id])}::jsonb`, bufferGen: sql`${aiConversationState.bufferGen} + 1`, updatedAt: this.now() })
      .where(eq(aiConversationState.chatId, chat.id))
      .returning({ gen: aiConversationState.bufferGen })
    const delay = agent.settings.buffer_enabled ? agent.settings.buffer_seconds * 1000 : 0
    await this.scheduler.schedule({ companyId: e.company_id, chatId: chat.id, gen: updated!.gen }, delay)
  }

  /** Turno: só roda se a geração do buffer ainda for a agendada (mensagem nova reinicia a contagem). */
  async runTurn(job: AiTurnJobData): Promise<TurnInfo> {
    const info: TurnInfo = { chatId: job.chatId, messageIds: [], llmCalls: 0, sent: [] }
    const finish = async (skipped?: string) => {
      if (skipped) info.skipped = skipped
      await this.opts.onTurn?.(info)
      return info
    }
    // Reivindica o buffer numa transação: só a geração agendada vale (uma mensagem nova depois reagenda).
    const pending = await this.db.transaction(async (tx) => {
      const [st] = await tx.select().from(aiConversationState).where(eq(aiConversationState.chatId, job.chatId)).for('update')
      if (!st || st.paused || st.bufferGen !== job.gen) return null
      await tx.update(aiConversationState).set({ pending: [], updatedAt: this.now() }).where(eq(aiConversationState.chatId, job.chatId))
      return (st.pending ?? []) as string[]
    })
    if (pending === null) return finish('stale')
    if (!pending.length) return finish('empty')
    info.messageIds = pending

    const chat = await this.chat(job.companyId, job.chatId)
    if (!chat?.aiAgentId) return finish('no_agent')
    const agent = await this.agents.get(job.companyId, chat.aiAgentId)
    if (agent.status !== 'active') return finish('agent_inactive')
    const [state] = await this.db.select().from(aiConversationState).where(eq(aiConversationState.chatId, chat.id))
    if (!state || state.paused) return finish('paused')
    if (await this.pausedByHuman(chat, state, agent)) return finish('human')
    if (agent.settings.business_hours_only && !(await this.withinHours(chat))) return finish('closed_hours')
    if (!agent.resolved_model || !agent.generated_prompt.trim()) return finish('not_configured')

    const input = await this.buildInput(chat, agent, pending)
    if (!input.trim()) return finish('empty_input')

    const effects: TurnEffects = { handoff: null, audio: false, progress: false, closed: false }
    const tools = this.tools(chat, agent, effects)
    const llm = this.opts.guard
      ? meterLlm(this.opts.llm, { guard: this.opts.guard, feature: AI_FEATURE, companyId: chat.companyId, agentId: agent.id })
      : this.opts.llm
    const history = (state.history ?? []) as LlmMessage[]
    const userMessage: LlmMessage = { role: 'user', content: [{ type: 'text', text: input }] }
    let result: LlmResult
    try {
      info.llmCalls++
      result = await llm.generate({
        model: { provider: agent.resolved_model.provider as LlmProviderId, model: agent.resolved_model.model },
        instructions: await this.instructions(chat, agent, state, input),
        messages: [...history, userMessage],
        tools,
        tenantId: chat.companyId,
        agentId: agent.id,
      })
    } catch (err) {
      if (err instanceof LlmQuotaExceededError) {
        info.llmCalls--
        await this.noBalance(chat, agent)
        return finish('no_balance')
      }
      throw err
    }
    if (result.finish === 'error') {
      this.opts.logger?.warn({ chatId: chat.id, error: result.error }, 'ai agent turn failed')
      return finish('llm_error')
    }

    // Histórico: a mensagem do usuário e a do assistente com o `providerData` do último passo (AC-T68-06).
    const providerData = [...result.steps].reverse().find((s) => s.providerData !== undefined)?.providerData
    const assistant: LlmMessage = { role: 'assistant', content: [{ type: 'text', text: result.text }], ...(providerData !== undefined ? { providerData } : {}) }
    const nextHistory = [...history, userMessage, assistant].slice(-HISTORY_LIMIT)

    const replyText = result.text.trim()
    if (replyText) info.sent = await this.reply(chat, agent, state, replyText, effects.audio)
    const stall = effects.progress ? 0 : state.stallCount + 1
    await this.db
      .update(aiConversationState)
      .set({
        history: nextHistory,
        stallCount: stall,
        repliesCount: state.repliesCount + (replyText ? 1 : 0),
        updatedAt: this.now(),
      })
      .where(eq(aiConversationState.chatId, chat.id))

    if (effects.handoff) await this.handoff(chat, effects.handoff.reason, effects.handoff.departmentId ?? null)
    else if (agent.settings.stall_limit_enabled && stall >= agent.settings.stall_limit) await this.handoff(chat, 'stall', null)
    return finish()
  }

  // ---------- entrada ----------

  private async buildInput(chat: ChatRow, agent: AgentDto, ids: string[]): Promise<string> {
    const rows = await this.db.select().from(messages).where(and(eq(messages.companyId, chat.companyId), inArray(messages.id, ids)))
    const byId = new Map(rows.map((r) => [r.id, r]))
    const lines: string[] = []
    for (const id of ids) {
      const m = byId.get(id)
      if (!m) continue
      if (m.type === 'audio' && m.media && agent.settings.understand_audio && (this.opts.stt || this.opts.resolveStt)) {
        const text = await this.transcribe(chat, m.media)
        if (text) lines.push(`[áudio] ${text}`)
        continue
      }
      if (m.type === 'image' && m.media && (agent.settings.understand_image || agent.settings.understand_receipt)) {
        const seen = await this.describeImage(chat, agent, m.media, m.body)
        if (seen) lines.push(seen)
        continue
      }
      if (m.body?.trim()) lines.push(m.body.trim())
    }
    return lines.join('\n')
  }

  private async transcribe(chat: ChatRow, media: Record<string, unknown>): Promise<string | null> {
    try {
      const sessionId = (media.session_id as string | undefined) ?? (await this.opts.resolveSession(chat.companyId, chat.connectionId))
      if (!sessionId) return null
      const bytes = await toBytes(await this.opts.waGateway.downloadMedia(sessionId, media as never))
      const stt = this.opts.resolveStt ? await this.opts.resolveStt(chat.companyId) : this.opts.stt!
      const res = await stt.transcribe({ audio: bytes, mime: String(media.mime ?? 'audio/ogg'), language: 'pt' })
      return res.text.trim() || null
    } catch (err) {
      this.opts.logger?.warn({ err, chatId: chat.id }, 'ai agent: falha ao transcrever áudio')
      return null
    }
  }

  /** Visão com saída estruturada: descreve a imagem e, se for comprovante, confere chave Pix e favorecido. */
  private async describeImage(chat: ChatRow, agent: AgentDto, media: Record<string, unknown>, caption: string | null): Promise<string | null> {
    if (!agent.resolved_model) return null
    try {
      const sessionId = (media.session_id as string | undefined) ?? (await this.opts.resolveSession(chat.companyId, chat.connectionId))
      if (!sessionId) return null
      const bytes = await toBytes(await this.opts.waGateway.downloadMedia(sessionId, media as never))
      const llm = this.opts.guard ? meterLlm(this.opts.llm, { guard: this.opts.guard, feature: AI_FEATURE, companyId: chat.companyId, agentId: agent.id }) : this.opts.llm
      const res = await llm.generate({
        model: { provider: agent.resolved_model.provider as LlmProviderId, model: agent.resolved_model.model },
        instructions: 'Descreva a imagem em uma frase. Diga se é um comprovante de pagamento e extraia valor, chave Pix e favorecido.',
        messages: [{ role: 'user', content: [{ type: 'image', mime: String(media.mime ?? 'image/jpeg'), data: bytes }] }],
        output: VISION_SCHEMA,
        tenantId: chat.companyId,
        agentId: agent.id,
      })
      const v = res.object as z.output<typeof VISION_SCHEMA> | undefined
      if (!v) return caption ? `[imagem] ${caption}` : null
      const parts = [`[imagem] ${v.description}`]
      if (caption) parts.push(`legenda: ${caption}`)
      if (v.is_receipt && agent.settings.understand_receipt) {
        const s = agent.settings
        const checks: string[] = []
        if (s.validate_receipt_pix_key && s.expected_pix_key) checks.push(norm(v.pix_key ?? '') === norm(s.expected_pix_key) ? 'chave Pix confere' : 'chave Pix NÃO confere')
        if (s.validate_receipt_recipient && s.expected_recipient_name)
          checks.push(norm(v.recipient_name ?? '').includes(norm(s.expected_recipient_name)) ? 'favorecido confere' : 'favorecido NÃO confere')
        parts.push(`comprovante${v.amount_cents != null ? ` de ${(v.amount_cents / 100).toFixed(2)}` : ''}${checks.length ? ` (${checks.join(', ')})` : ''}`)
      }
      return parts.join(' — ')
    } catch (err) {
      if (err instanceof LlmQuotaExceededError) throw err
      this.opts.logger?.warn({ err, chatId: chat.id }, 'ai agent: falha ao ler imagem')
      return caption ? `[imagem] ${caption}` : null
    }
  }

  private async instructions(chat: ChatRow, agent: AgentDto, state: StateRow, input: string): Promise<string> {
    const parts = [agent.generated_prompt.trim()]
    const fields = agent.collection_fields.filter((f) => f.enabled)
    if (fields.length) {
      const collected = state.collected ?? {}
      parts.push(`Colete com naturalidade e grave com a tool fill_field: ${fields.map((f) => `${f.key} (${f.label})${collected[f.key] ? ` = já coletado` : ''}`).join(', ')}.`)
    }
    if (!agent.use_emojis) parts.push('Não use emojis.')
    else parts.push('Use no máximo 1 emoji por mensagem.')
    if (this.opts.knowledge) {
      const hits = await this.opts.knowledge.search({ companyId: chat.companyId, agentId: agent.id, query: input }).catch(() => [])
      if (hits.length) parts.push(`Base de conhecimento (use se for relevante):\n${hits.map((h) => `- ${h}`).join('\n')}`)
    }
    return parts.join('\n\n')
  }

  // ---------- habilidades como tools (07 §3.3) ----------

  private tools(chat: ChatRow, agent: AgentDto, effects: TurnEffects): LlmTool[] {
    const list: LlmTool[] = []
    const names = new Map<string, number>()
    const nameFor = (base: string) => {
      const n = (names.get(base) ?? 0) + 1
      names.set(base, n)
      return n === 1 ? base : `${base}_${n}`
    }
    const actor = systemActor(chat.companyId)
    for (const skill of agent.skills.filter((s) => s.enabled)) {
      const params = (skill.action_params ?? {}) as Record<string, unknown>
      const desc = skill.when_text || skill.action_type
      switch (skill.action_type) {
        case 'transfer_human':
          list.push(
            llmTool({
              name: nameFor('transfer_human'),
              description: `Transferir para um atendente humano. Quando: ${desc}`,
              input: z.object({ reason: z.string().max(500).optional() }),
              execute: async () => {
                effects.handoff = { reason: 'transfer_human', departmentId: typeof params.department_id === 'string' ? params.department_id : null }
                effects.progress = true
                return { ok: true }
              },
            }),
          )
          break
        case 'apply_label':
          list.push(
            llmTool({
              name: nameFor('apply_label'),
              description: `${params.mode === 'remove' ? 'Remover' : 'Aplicar'} etiqueta. Quando: ${desc}`,
              input: z.object({}),
              execute: async () => {
                const labelId = params.label_id
                if (typeof labelId !== 'string') return { ok: false, error: 'etiqueta não configurada' }
                if (params.mode === 'remove') await this.lifecycle.removeLabel(actor, chat.id, labelId)
                else await this.lifecycle.addLabel(actor, chat.id, labelId)
                effects.progress = true
                return { ok: true }
              },
            }),
          )
          break
        case 'trigger_flow':
          list.push(
            llmTool({
              name: nameFor('trigger_flow'),
              description: `Disparar um fluxo. Quando: ${desc}`,
              input: z.object({}),
              execute: async () => {
                if (!this.opts.flows || typeof params.flow_id !== 'string') return { ok: false, error: 'fluxo indisponível' }
                await this.opts.flows.startRun({ companyId: chat.companyId }, { flowId: params.flow_id, contactId: chat.contactId, chatId: chat.id, trigger: { kind: 'ai_agent', agent_id: agent.id } })
                effects.progress = true
                if (!params.return_to_agent) effects.handoff = { reason: 'flow' }
                return { ok: true }
              },
            }),
          )
          break
        case 'close_conversation':
          list.push(
            llmTool({
              name: nameFor('close_conversation'),
              description: `Encerrar a conversa. Quando: ${desc}`,
              input: z.object({}),
              execute: async () => {
                effects.closed = true
                effects.progress = true
                effects.handoff = { reason: 'closed' }
                return { ok: true }
              },
            }),
          )
          break
        case 'fill_field':
          // Coberta pela fill_field geral abaixo (campos de coleta).
          break
        default:
          if ((skill.action_type as string) === 'move_card')
            list.push(
              llmTool({
                name: nameFor('move_card'),
                description: `Mover o card no CRM/Kanban. Quando: ${desc}`,
                input: z.object({}),
                execute: async () => {
                  if (typeof params.crm_id !== 'string' || typeof params.column_id !== 'string') return { ok: false, error: 'coluna não configurada' }
                  await this.kanban.setChatColumn(actor, chat.id, params.crm_id, params.column_id)
                  effects.progress = true
                  return { ok: true }
                },
              }),
            )
      }
    }
    // move_card também pode vir de action_params de outras habilidades no futuro (T50); fill_field cobre a coleta.
    const fields = agent.collection_fields.filter((f) => f.enabled).map((f) => f.key)
    if (fields.length)
      list.push(
        llmTool({
          name: 'fill_field',
          description: 'Grava um dado do cliente quando ele aparecer na conversa.',
          input: z.object({ key: z.enum(fields as [string, ...string[]]), value: z.string().min(1).max(500) }),
          execute: async ({ key, value }) => {
            await this.db
              .update(aiConversationState)
              .set({ collected: sql`${aiConversationState.collected} || ${JSON.stringify({ [key]: value })}::jsonb` })
              .where(eq(aiConversationState.chatId, chat.id))
            if (key === 'nome') await this.db.update(contacts).set({ name: value, updatedAt: this.now() }).where(and(eq(contacts.id, chat.contactId), eq(contacts.name, '')))
            if (key === 'email' && /^\S+@\S+\.\S+$/.test(value))
              await this.db.update(contacts).set({ email: value.toLowerCase(), updatedAt: this.now() }).where(and(eq(contacts.id, chat.contactId), sql`${contacts.email} is null`))
            effects.progress = true
            return { ok: true }
          },
        }),
      )
    if (agent.settings.audio_choice_enabled && (this.opts.tts || this.opts.resolveTts))
      list.push(
        llmTool({
          name: 'send_audio',
          description: agent.settings.audio_guidance?.trim() || 'Responder com áudio (nota de voz) em vez de texto.',
          input: z.object({}),
          execute: async () => {
            effects.audio = true
            return { ok: true }
          },
        }),
      )
    return list
  }

  // ---------- saída ----------

  /** TTS da empresa (BYOK) ou o fixo; empresa sem chave de voz → `null` (responde em texto). */
  private async ttsFor(chat: ChatRow): Promise<TtsProvider | null> {
    if (!this.opts.resolveTts) return this.opts.tts ?? null
    try {
      return await this.opts.resolveTts(chat.companyId)
    } catch (err) {
      this.opts.logger?.warn({ err, chatId: chat.id }, 'ai agent: sem TTS para a empresa; resposta em texto')
      return null
    }
  }

  /** Envia a resposta como agente: áudio se pedido e permitido, senão texto dividido (AC-T68-03/06). */
  private async reply(chat: ChatRow, agent: AgentDto, state: StateRow, text: string, wantsAudio: boolean): Promise<string[]> {
    const sender: Sender = { userId: agent.id, name: agent.name, kind: 'ai', agentId: agent.id }
    const s = agent.settings
    const sign = s.sign_name && state.repliesCount === 0
    const sent: string[] = []
    const voice = wantsAudio && canSpeak(text) && state.audioCount < s.audio_max_per_conversation ? await this.ttsFor(chat) : null
    if (voice) {
      // O LLM decide pela tool `send_audio`; a regra fixa (canSpeak) e o limite por conversa podem vetar.
      const tts = await voice.synthesize({ text, voiceId: s.audio_voice || 'default', format: 'ogg_opus' })
      const media = await this.opts.media.store(chat.companyId, tts.audio, tts.mime, 'resposta.ogg')
      const { message } = await this.send.send(chat.companyId, chat.id, sender, { type: 'audio', mediaId: media.id, ptt: true })
      sent.push(message.id)
      await this.db
        .update(aiConversationState)
        .set({ audioCount: sql`${aiConversationState.audioCount} + 1` })
        .where(eq(aiConversationState.chatId, chat.id))
      return sent
    }
    const parts = s.split_messages ? splitReply(text) : [text]
    for (const [i, part] of parts.entries()) {
      const { message } = await this.send.send(chat.companyId, chat.id, sender, { type: 'text', text: part, signature: sign && i === 0 })
      sent.push(message.id)
    }
    return sent
  }

  /** Desliga o agente no chat (handoff): sem agente, departamento configurado, fila de espera (AC-T68-02). */
  private async handoff(chat: ChatRow, reason: AiPauseReason, departmentId: string | null): Promise<void> {
    const now = this.now()
    const updated = await this.db.transaction(async (tx) => {
      await tx
        .update(aiConversationState)
        .set({ paused: true, pausedReason: reason, pending: [], updatedAt: now })
        .where(eq(aiConversationState.chatId, chat.id))
      const set: Partial<typeof chats.$inferInsert> = { aiAgentId: null, updatedAt: now }
      if (departmentId) set.departmentId = departmentId
      if (reason === 'closed') Object.assign(set, { status: 'resolved', resolvedAt: now })
      else if (chat.status !== 'resolved') Object.assign(set, { status: 'waiting', assignedUserId: null })
      const [row] = await tx.update(chats).set(set).where(and(eq(chats.companyId, chat.companyId), eq(chats.id, chat.id))).returning()
      await tx.insert(chatEvents).values({
        companyId: chat.companyId,
        chatId: chat.id,
        type: reason === 'closed' ? 'resolved' : 'ai_transferred',
        actorUserId: null,
        detail: { reason, agent_id: chat.aiAgentId, ...(departmentId ? { department_id: departmentId } : {}) },
      })
      return row!
    })
    try {
      await this.opts.publisher?.publish(chat.companyId, 'chat.updated', { chat_id: chat.id, chat: toChatDto(updated) as never }, { scope: chatScope(updated) })
    } catch {
      // realtime é melhor-esforço
    }
  }

  /** Cota/saldo esgotado: nenhuma chamada ao LLM; handoff + `no_balance_action` (AC-T68-05). */
  private async noBalance(chat: ChatRow, agent: AgentDto): Promise<void> {
    const s = agent.settings
    await this.handoff(chat, 'no_balance', null)
    try {
      if (s.no_balance_action === 'flow' && s.no_balance_flow_id && this.opts.flows)
        await this.opts.flows.startRun({ companyId: chat.companyId }, { flowId: s.no_balance_flow_id, contactId: chat.contactId, chatId: chat.id, trigger: { kind: 'ai_no_balance', agent_id: agent.id } })
      if (s.no_balance_action === 'notify' && s.no_balance_notify_phone) {
        const sessionId = await this.opts.resolveSession(chat.companyId, chat.connectionId)
        const digits = `${s.no_balance_notify_country_code || ''}${s.no_balance_notify_phone}`.replace(/\D/g, '')
        if (sessionId && digits)
          await this.opts.waGateway.send({
            sessionId,
            phone: `+${digits}`,
            content: { text: s.no_balance_notify_message?.trim() || `O agente ${agent.name} parou por falta de saldo de IA.` },
            actor: `crm:ai:${agent.id}`,
          })
      }
    } catch (err) {
      this.opts.logger?.error({ err, chatId: chat.id }, 'ai agent: falha na ação sem saldo')
    }
  }

  // ---------- estado ----------

  private async chat(companyId: string, chatId: string): Promise<ChatRow | null> {
    const [row] = await this.db.select().from(chats).where(and(eq(chats.companyId, companyId), eq(chats.id, chatId))).limit(1)
    return row ?? null
  }

  /** Estado do chat; agente trocado ou estado ausente → começa de novo (ativo desde agora). */
  private async ensureState(chat: ChatRow, agentId: string): Promise<StateRow> {
    const now = this.now()
    const [existing] = await this.db.select().from(aiConversationState).where(eq(aiConversationState.chatId, chat.id))
    if (existing && existing.agentId === agentId) {
      // Pausado por handoff e agente religado no chat (ai_agent_id voltou): reativa.
      if (existing.paused && existing.pausedReason !== 'human') {
        const [row] = await this.db
          .update(aiConversationState)
          .set({ paused: false, pausedReason: null, activeSince: now, stallCount: 0, updatedAt: now })
          .where(eq(aiConversationState.chatId, chat.id))
          .returning()
        return row!
      }
      return existing
    }
    const fresh = { companyId: chat.companyId, agentId, paused: false, pausedReason: null, activeSince: now, pending: [], bufferGen: 0, history: [], collected: {}, audioCount: 0, stallCount: 0, repliesCount: 0, updatedAt: now }
    const [row] = await this.db
      .insert(aiConversationState)
      .values({ chatId: chat.id, ...fresh })
      .onConflictDoUpdate({ target: aiConversationState.chatId, set: fresh })
      .returning()
    return row!
  }

  /** `pause_on_human`: mensagem de atendente (sender_type `user`) depois que o agente começou (AC-T68-04). */
  private async pausedByHuman(chat: ChatRow, state: StateRow, agent: AgentDto): Promise<boolean> {
    if (!agent.settings.pause_on_human) return false
    const [human] = await this.db
      .select({ id: messages.id })
      .from(messages)
      .where(and(eq(messages.chatId, chat.id), eq(messages.senderType, 'user'), gt(messages.createdAt, state.activeSince)))
      .orderBy(desc(messages.createdAt))
      .limit(1)
    if (!human) return false
    await this.db
      .update(aiConversationState)
      .set({ paused: true, pausedReason: 'human', pending: [], updatedAt: this.now() })
      .where(eq(aiConversationState.chatId, chat.id))
    return true
  }

  private async withinHours(chat: ChatRow): Promise<boolean> {
    const cfg = await this.hours.get(chat.companyId, chat.connectionId)
    const [co] = await this.db.select({ tz: companies.timeZone }).from(companies).where(eq(companies.id, chat.companyId))
    return isOpen(cfg, this.now(), co?.tz ?? 'America/Sao_Paulo')
  }
}
