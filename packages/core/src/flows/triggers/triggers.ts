// Gatilhos de início de fluxo (T61; 06 §3.8, SPEC 10.2 nº 5): decide, para cada mensagem nova do contato
// (`crm.inbound`, T33), se um fluxo começa. Ordem:
//   1. idempotência por mensagem (`flow_trigger_events`): a mesma entrega duas vezes não cria dois runs;
//   2. mensagem que responde a um run em espera vai para o run (T30) e nenhum gatilho dispara;
//   3. palavra-chave (cancela o run ativo do contato e inicia o fluxo dela; vale mesmo com atendente/IA);
//   4. supressão: chat em atendimento humano ou com agente de IA ativo não recebe gatilhos automáticos;
//   5. ação fora do horário (T31), no máximo uma por chat a cada 12 h;
//   6. automáticos, só se o contato não tiver run ativo: boas-vindas > conversa finalizada > resposta padrão.
import { and, desc, eq, inArray, lt, ne, or, sql } from 'drizzle-orm'
import {
  ACTIVE_FLOW_RUN_STATUSES,
  aiAgents,
  aiConversationState,
  businessHourConfigs,
  chats,
  companies,
  connectionFlowConfigs,
  contacts,
  flowRuns,
  flowTriggerEvents,
  keywordTriggers,
  messages,
  outOfHoursActions,
  type Database,
  type FlowTriggerOutcome,
} from '@crm/db'
import type { WaGateway } from '@crm/wa-port'
import { BusinessHoursService } from '../../business-hours/service'
import { isOpen } from '../../business-hours/is-open'
import type { CrmInboundEvent } from '../../chats/ingest/chat-ingest'
import { FlowEngineError, type StartRunInput } from '../engine/runner'
import { matchKeywordRule } from './match'

/** Uma ação fora do horário por chat nesta janela. */
export const OUT_OF_HOURS_WINDOW_MS = 12 * 3600_000
/** `actor` dos envios automáticos do CRM (gate auth do pipeline). */
export const OUT_OF_HOURS_ACTOR = 'crm:system:business-hours'

export type TriggerType = 'keyword' | 'welcome' | 'finished_conversation' | 'default_response' | 'finished_attendance' | 'out_of_hours'
export type OutOfHoursResult = 'message' | 'flow' | 'window' | null

export interface FlowTriggerResult {
  outcome: FlowTriggerOutcome | 'duplicate'
  flow_id?: string | null
  run_id?: string | null
  keyword_trigger_id?: string | null
  out_of_hours?: OutOfHoursResult
  /** Código do FlowEngineError quando o fluxo escolhido não pôde começar (pausado, sem versão…). */
  error?: string
}

export interface FlowTriggersLogger {
  warn(obj: object, msg?: string): void
  error(obj: object, msg?: string): void
}

export interface FlowTriggersOptions {
  db: Database
  /** Início de run (FlowEngine.startRun, T25). */
  engine: { startRun(ctx: { companyId: string }, input: StartRunInput): Promise<{ runId: string; expectedSeq: number }> }
  /** Cancelar o run atual antes de uma palavra-chave (FlowControl.cancelForContact, T30): um run ativo por contato. */
  control: { cancelForContact(ctx: { companyId: string }, contactId: string): Promise<{ cancelled: number }> }
  /** Envio da mensagem fora do horário. Sem ele a ação `message` é pulada (com aviso). */
  waGateway?: Pick<WaGateway, 'send'>
  now?: () => Date
  logger?: FlowTriggersLogger
}

type ConfigRow = typeof connectionFlowConfigs.$inferSelect
const noopLog: FlowTriggersLogger = { warn: () => undefined, error: () => undefined }
const HOUR_MS = 3600_000

export class FlowTriggers {
  private readonly db: Database
  private readonly now: () => Date
  private readonly log: FlowTriggersLogger
  private readonly hours: BusinessHoursService

  constructor(private readonly opts: FlowTriggersOptions) {
    this.db = opts.db
    this.now = opts.now ?? (() => new Date())
    this.log = opts.logger ?? noopLog
    this.hours = new BusinessHoursService(opts.db)
  }

  /** Processa uma mensagem recebida. Falha → a marca de idempotência é desfeita (a entrega pode ser repetida). */
  async handleInbound(e: CrmInboundEvent): Promise<FlowTriggerResult> {
    const ctx = { companyId: e.company_id }
    const [claimed] = await this.db
      .insert(flowTriggerEvents)
      .values({ messageId: e.message_id, companyId: e.company_id, chatId: e.chat_id, contactId: e.contact_id, outcome: 'none' })
      .onConflictDoNothing()
      .returning({ messageId: flowTriggerEvents.messageId })
    if (!claimed) return { outcome: 'duplicate' }
    try {
      const result = await this.decide(e)
      await this.db
        .update(flowTriggerEvents)
        .set({
          outcome: result.outcome as FlowTriggerOutcome,
          flowId: result.flow_id ?? null,
          runId: result.run_id ?? null,
          keywordTriggerId: result.keyword_trigger_id ?? null,
          outOfHours: result.out_of_hours ?? null,
        })
        .where(eq(flowTriggerEvents.messageId, e.message_id))
      return result
    } catch (err) {
      await this.db
        .delete(flowTriggerEvents)
        .where(eq(flowTriggerEvents.messageId, e.message_id))
        .catch(() => undefined)
      this.log.error({ err: err instanceof Error ? err.message : String(err), message_id: e.message_id, company_id: ctx.companyId }, 'gatilhos de fluxo falharam')
      throw err
    }
  }

  /** "Atendimento finalizado" (06 §3.8): no momento em que o chat é resolvido. Sem config/run ativo → nada. */
  async handleAttendanceFinished(input: { companyId: string; chatId: string }): Promise<FlowTriggerResult> {
    const [chat] = await this.db
      .select({ id: chats.id, connectionId: chats.connectionId, contactId: chats.contactId })
      .from(chats)
      .where(and(eq(chats.companyId, input.companyId), eq(chats.id, input.chatId)))
      .limit(1)
    if (!chat) return { outcome: 'none' }
    const config = await this.config(input.companyId, chat.connectionId)
    if (!config?.finishedAttendanceFlowId) return { outcome: 'none' }
    if (await this.hasActiveRun(input.companyId, chat.contactId)) return { outcome: 'active_run' }
    const started = await this.start(input.companyId, config.finishedAttendanceFlowId, chat.contactId, chat.id, { type: 'finished_attendance' })
    return { outcome: 'none', flow_id: config.finishedAttendanceFlowId, run_id: started.runId, ...(started.error ? { error: started.error } : {}) }
  }

  // ------------------------------------------------------------------ decisão

  private async decide(e: CrmInboundEvent): Promise<FlowTriggerResult> {
    const companyId = e.company_id
    if (await this.isRunReply(e)) return { outcome: 'run_reply' }

    const config = await this.config(companyId, e.connection_id)

    // Palavra-chave: prioridade sobre tudo e vale mesmo com atendente ou IA (SPEC 10.2 nº 5).
    if (config) {
      const triggers = await this.db
        .select()
        .from(keywordTriggers)
        .where(and(eq(keywordTriggers.configId, config.id), eq(keywordTriggers.active, true)))
        .orderBy(keywordTriggers.position, keywordTriggers.createdAt)
      const hit = triggers.find((t) => matchKeywordRule(e.text, { rule_type: t.ruleType, conditions: t.conditions }))
      if (hit) {
        await this.opts.control.cancelForContact({ companyId }, e.contact_id)
        const started = await this.start(companyId, hit.flowId, e.contact_id, e.chat_id, { type: 'keyword', message_id: e.message_id, keyword_trigger_id: hit.id })
        return { outcome: 'keyword', flow_id: hit.flowId, run_id: started.runId, keyword_trigger_id: hit.id, ...(started.error ? { error: started.error } : {}) }
      }
    }

    if (await this.suppressed(companyId, e.chat_id)) return { outcome: 'suppressed' }

    const outOfHours = await this.outOfHours(e)
    if (outOfHours.result === 'flow') return { outcome: 'none', out_of_hours: 'flow', flow_id: outOfHours.flowId ?? null, run_id: outOfHours.runId ?? null }

    const auto = config ? await this.automatic(e, config) : null
    if (!auto) return { outcome: 'none', out_of_hours: outOfHours.result }
    if (await this.hasActiveRun(companyId, e.contact_id)) return { outcome: 'active_run', flow_id: auto.flowId, out_of_hours: outOfHours.result }
    const started = await this.start(companyId, auto.flowId, e.contact_id, e.chat_id, { type: auto.type, message_id: e.message_id })
    return { outcome: auto.type, flow_id: auto.flowId, run_id: started.runId, out_of_hours: outOfHours.result, ...(started.error ? { error: started.error } : {}) }
  }

  /** Run do contato esperando resposta, ou um run que já recebeu esta mensagem (o listener da T30 rodou antes). */
  private async isRunReply(e: CrmInboundEvent): Promise<boolean> {
    const [run] = await this.db
      .select({ id: flowRuns.id })
      .from(flowRuns)
      .where(
        and(
          eq(flowRuns.companyId, e.company_id),
          eq(flowRuns.contactId, e.contact_id),
          or(
            and(eq(flowRuns.status, 'waiting'), sql`coalesce(${flowRuns.wait}->>'kind', 'reply') = 'reply'`),
            sql`${flowRuns.vars}->'reply'->>'message_id' = ${e.message_id}`,
          ),
        ),
      )
      .limit(1)
    return Boolean(run)
  }

  private async config(companyId: string, connectionId: string): Promise<ConfigRow | undefined> {
    const [cfg] = await this.db
      .select()
      .from(connectionFlowConfigs)
      .where(and(eq(connectionFlowConfigs.companyId, companyId), eq(connectionFlowConfigs.connectionId, connectionId)))
      .limit(1)
    return cfg
  }

  /** Atendente humano no chat (`attending` com atendente) ou agente de IA ativo e não pausado. */
  private async suppressed(companyId: string, chatId: string): Promise<boolean> {
    const [chat] = await this.db
      .select({ status: chats.status, assignedUserId: chats.assignedUserId, aiAgentId: chats.aiAgentId })
      .from(chats)
      .where(and(eq(chats.companyId, companyId), eq(chats.id, chatId)))
      .limit(1)
    if (!chat) return false
    if (chat.status === 'attending' && chat.assignedUserId) return true
    if (!chat.aiAgentId) return false
    const [agent] = await this.db.select({ status: aiAgents.status }).from(aiAgents).where(eq(aiAgents.id, chat.aiAgentId)).limit(1)
    if (agent?.status !== 'active') return false
    const [state] = await this.db.select({ paused: aiConversationState.paused }).from(aiConversationState).where(eq(aiConversationState.chatId, chatId)).limit(1)
    return !state?.paused
  }

  private async hasActiveRun(companyId: string, contactId: string): Promise<boolean> {
    const [run] = await this.db
      .select({ id: flowRuns.id })
      .from(flowRuns)
      .where(and(eq(flowRuns.companyId, companyId), eq(flowRuns.contactId, contactId), inArray(flowRuns.status, [...ACTIVE_FLOW_RUN_STATUSES])))
      .limit(1)
    return Boolean(run)
  }

  /** Boas-vindas (chat novo) > conversa finalizada (chat reaberto) > resposta padrão (inatividade ≥ atraso). */
  private async automatic(e: CrmInboundEvent, config: ConfigRow): Promise<{ type: 'welcome' | 'finished_conversation' | 'default_response'; flowId: string } | null> {
    if (e.chat_created && config.welcomeFlowId) return { type: 'welcome', flowId: config.welcomeFlowId }
    if (e.chat_reopened && config.finishedConversationFlowId) return { type: 'finished_conversation', flowId: config.finishedConversationFlowId }
    if (!config.defaultResponseFlowId) return null
    const last = await this.previousInboundAt(e)
    if (last && this.now().getTime() - last.getTime() < config.defaultResponseDelayHours * HOUR_MS) return null
    return { type: 'default_response', flowId: config.defaultResponseFlowId }
  }

  /** Mensagem anterior do contato neste chat (antes da atual). */
  private async previousInboundAt(e: CrmInboundEvent): Promise<Date | null> {
    const [current] = await this.db.select({ createdAt: messages.createdAt }).from(messages).where(eq(messages.id, e.message_id)).limit(1)
    const [prev] = await this.db
      .select({ createdAt: messages.createdAt })
      .from(messages)
      .where(
        and(
          eq(messages.companyId, e.company_id),
          eq(messages.chatId, e.chat_id),
          eq(messages.direction, 'inbound'),
          ne(messages.id, e.message_id),
          ...(current ? [lt(messages.createdAt, current.createdAt)] : []),
        ),
      )
      .orderBy(desc(messages.createdAt))
      .limit(1)
    return prev?.createdAt ?? null
  }

  // ------------------------------------------------------------------ fora do horário

  /** Ação fora do horário da conexão (T31), no fuso da empresa e no máximo uma por chat a cada 12 h. */
  private async outOfHours(e: CrmInboundEvent): Promise<{ result: OutOfHoursResult; flowId?: string; runId?: string | null }> {
    const [cfg] = await this.db
      .select({ active: businessHourConfigs.active })
      .from(businessHourConfigs)
      .where(and(eq(businessHourConfigs.companyId, e.company_id), eq(businessHourConfigs.connectionId, e.connection_id)))
      .limit(1)
    if (!cfg?.active) return { result: null }
    const hours = await this.hours.get(e.company_id, e.connection_id)
    const [company] = await this.db.select({ timeZone: companies.timeZone }).from(companies).where(eq(companies.id, e.company_id)).limit(1)
    const now = this.now()
    if (isOpen(hours, now, company?.timeZone ?? 'America/Sao_Paulo')) return { result: null }

    if (hours.action_type === 'flow') {
      if (!hours.flow_id) return { result: null }
      if (await this.hasActiveRun(e.company_id, e.contact_id)) return { result: null }
      if (!(await this.claimWindow(e, now))) return { result: 'window' }
      const started = await this.start(e.company_id, hours.flow_id, e.contact_id, e.chat_id, { type: 'out_of_hours', message_id: e.message_id })
      return { result: 'flow', flowId: hours.flow_id, runId: started.runId }
    }

    const text = hours.message_text?.trim()
    if (!text) return { result: null }
    if (!this.opts.waGateway) {
      this.log.warn({ company_id: e.company_id, chat_id: e.chat_id }, 'mensagem fora do horário sem WaGateway configurado')
      return { result: null }
    }
    const [contact] = await this.db.select({ phone: contacts.phoneE164 }).from(contacts).where(eq(contacts.id, e.contact_id)).limit(1)
    if (!contact?.phone) {
      this.log.warn({ company_id: e.company_id, contact_id: e.contact_id }, 'mensagem fora do horário: contato sem telefone')
      return { result: null }
    }
    if (!(await this.claimWindow(e, now))) return { result: 'window' }
    await this.opts.waGateway.send({
      sessionId: e.session_id,
      phone: contact.phone,
      content: { text },
      actor: OUT_OF_HOURS_ACTOR,
      contactId: e.contact_id,
      clientMessageId: `out-of-hours-${e.message_id}`,
    })
    return { result: 'message' }
  }

  /** Marca a ação do chat se a última foi há ≥ 12 h (atômico: duas mensagens simultâneas não disparam duas). */
  private async claimWindow(e: CrmInboundEvent, now: Date): Promise<boolean> {
    const threshold = new Date(now.getTime() - OUT_OF_HOURS_WINDOW_MS)
    const rows = await this.db
      .insert(outOfHoursActions)
      .values({ companyId: e.company_id, chatId: e.chat_id, lastActionAt: now })
      .onConflictDoUpdate({
        target: outOfHoursActions.chatId,
        set: { lastActionAt: now },
        setWhere: sql`${outOfHoursActions.lastActionAt} <= ${threshold.toISOString()}::timestamptz`,
      })
      .returning({ chatId: outOfHoursActions.chatId })
    return rows.length > 0
  }

  // ------------------------------------------------------------------ início do run

  private async start(
    companyId: string,
    flowId: string,
    contactId: string,
    chatId: string,
    trigger: { type: TriggerType } & Record<string, unknown>,
  ): Promise<{ runId: string | null; error?: string }> {
    try {
      const { runId } = await this.opts.engine.startRun({ companyId }, { flowId, contactId, chatId, trigger })
      return { runId }
    } catch (err) {
      if (err instanceof FlowEngineError) {
        this.log.warn({ company_id: companyId, flow_id: flowId, contact_id: contactId, trigger: trigger.type, code: err.code }, 'gatilho não iniciou o fluxo')
        return { runId: null, error: err.code }
      }
      throw err
    }
  }
}
