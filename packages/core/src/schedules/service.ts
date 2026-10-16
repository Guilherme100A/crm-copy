// Agendamentos de mensagem/fluxo do chat (T64; 03-chats F50–F51): criar (até 31 dias, recorrência), listar
// (por chat e status, só chats no escopo do ator — T119), detalhe e cancelar (remove o job). A execução fica no
// `runSchedule` (worker).
import { and, count, desc, eq, inArray, sql, type SQL } from 'drizzle-orm'
import { z } from 'zod'
import { chats, flows, messageSchedules, SCHEDULE_KINDS, SCHEDULE_RECURRENCES, type Database, type ScheduleStatus } from '@crm/db'
import { buildPageMeta, pageOffset, type PageResponse } from '@crm/shared'
import { ChatsError } from '../chats/lifecycle/errors'
import { actorScope, companyChats, scopeCondition, type ChatActor } from '../chats/query/context'
import { ChatQueryService } from '../chats/query/service'
import { scheduleInvalid, scheduleNotFound, SchedulesError } from './errors'
import { runAtProblem, SCHEDULE_MAX_DAYS, type ScheduleJobData } from './rules'

type Row = typeof messageSchedules.$inferSelect

export interface ScheduleDto {
  id: string
  chat_id: string
  kind: Row['kind']
  text: string | null
  quick_reply_id: string | null
  flow_id: string | null
  run_at: string
  recurrence: Row['recurrence']
  status: ScheduleStatus
  run_count: number
  last_run_at: string | null
  last_error: string | null
  last_message_id: string | null
  last_flow_run_id: string | null
  created_by_user_id: string | null
  created_at: string
  updated_at: string
}

const iso = (d: Date | null) => (d ? d.toISOString() : null)

export function toScheduleDto(r: Row): ScheduleDto {
  return {
    id: r.id,
    chat_id: r.chatId,
    kind: r.kind,
    text: r.text,
    quick_reply_id: r.quickReplyId,
    flow_id: r.flowId,
    run_at: r.runAt.toISOString(),
    recurrence: r.recurrence,
    status: r.status,
    run_count: r.runCount,
    last_run_at: iso(r.lastRunAt),
    last_error: r.lastError,
    last_message_id: r.lastMessageId,
    last_flow_run_id: r.lastFlowRunId,
    created_by_user_id: r.createdByUserId,
    created_at: r.createdAt.toISOString(),
    updated_at: r.updatedAt.toISOString(),
  }
}

/** Fila do job de execução (BullMQ em produção; fake nos testes). */
export interface ScheduleJobs {
  add(job: ScheduleJobData, delayMs: number): Promise<void>
  remove(job: ScheduleJobData): Promise<void>
}

const uuid = z.uuid('id inválido')

export const scheduleCreateSchema = z
  .object({
    kind: z.enum(SCHEDULE_KINDS, 'Tipo inválido (message ou flow)'),
    text: z.string().max(4096, 'No máximo 4096 caracteres').nullish(),
    quick_reply_id: uuid.nullish(),
    flow_id: uuid.nullish(),
    run_at: z.iso.datetime({ offset: true, message: 'Data e hora inválidas (ISO 8601)' }),
    recurrence: z.enum(SCHEDULE_RECURRENCES, 'Recorrência inválida').default('one_off'),
  })
  .superRefine((v, ctx) => {
    if (v.kind === 'message' && !v.text?.trim()) ctx.addIssue({ code: 'custom', path: ['text'], message: 'Escreva a mensagem' })
    if (v.kind === 'flow' && !v.flow_id) ctx.addIssue({ code: 'custom', path: ['flow_id'], message: 'Escolha o fluxo' })
  })
export type ScheduleCreateInput = z.output<typeof scheduleCreateSchema>

export interface ScheduleListQuery {
  chatId?: string
  status?: ScheduleStatus
  page: number
  limit: number
}

export interface SchedulesServiceOptions {
  db: Database
  jobs: ScheduleJobs
  now?: () => Date
}

export class SchedulesService {
  private readonly db: Database
  private readonly query: ChatQueryService
  private readonly now: () => Date

  constructor(private readonly opts: SchedulesServiceOptions) {
    this.db = opts.db
    this.query = new ChatQueryService(opts.db)
    this.now = opts.now ?? (() => new Date())
  }

  async create(actor: ChatActor, chatId: string, input: unknown): Promise<ScheduleDto> {
    const chat = await this.visibleChat(actor, chatId)
    const parsed = scheduleCreateSchema.safeParse(input ?? {})
    if (!parsed.success)
      throw new SchedulesError('validation', 'Dados inválidos', { fields: parsed.error.issues.map((i) => ({ path: i.path.map(String).join('.'), message: i.message })) })
    const data = parsed.data
    const runAt = new Date(data.run_at)
    const problem = runAtProblem(runAt, this.now())
    if (problem === 'past') throw scheduleInvalid('run_at', 'Escolha um horário no futuro')
    if (problem === 'too_far') throw scheduleInvalid('run_at', `No máximo ${SCHEDULE_MAX_DAYS} dias à frente`)
    if (data.kind === 'flow') await this.assertFlow(actor.companyId, data.flow_id!)

    const [row] = await this.db
      .insert(messageSchedules)
      .values({
        companyId: actor.companyId,
        chatId: chat.id,
        kind: data.kind,
        text: data.kind === 'message' ? data.text!.trim() : null,
        quickReplyId: data.kind === 'message' ? (data.quick_reply_id ?? null) : null,
        flowId: data.kind === 'flow' ? data.flow_id! : null,
        runAt,
        recurrence: data.recurrence,
        createdByUserId: actor.userId,
      })
      .returning()
    try {
      await this.opts.jobs.add({ scheduleId: row!.id, runAt: row!.runAt.toISOString() }, runAt.getTime() - this.now().getTime())
    } catch (err) {
      // Sem job o agendamento nunca rodaria: desfaz.
      await this.db.delete(messageSchedules).where(eq(messageSchedules.id, row!.id))
      throw err
    }
    return toScheduleDto(row!)
  }

  async get(actor: ChatActor, id: string): Promise<ScheduleDto> {
    return toScheduleDto(await this.visibleRow(actor, id))
  }

  /** Lista da empresa (só chats visíveis ao ator), mais próximos primeiro entre os pendentes. */
  async list(actor: ChatActor, q: ScheduleListQuery): Promise<PageResponse<ScheduleDto>> {
    const conds: (SQL | undefined)[] = [eq(messageSchedules.companyId, actor.companyId)]
    if (q.chatId) conds.push(eq(messageSchedules.chatId, (await this.visibleChat(actor, q.chatId)).id))
    else {
      const scope = await actorScope(this.db, actor)
      const visible = scopeCondition(scope)
      if (visible) conds.push(inArray(messageSchedules.chatId, this.db.select({ id: chats.id }).from(chats).where(and(companyChats(actor.companyId), visible))))
    }
    if (q.status) conds.push(eq(messageSchedules.status, q.status))
    const where = and(...conds)
    const [rows, [total]] = await Promise.all([
      this.db
        .select()
        .from(messageSchedules)
        .where(where)
        .orderBy(sql`case when ${messageSchedules.status} = 'pending' then 0 else 1 end`, sql`case when ${messageSchedules.status} = 'pending' then ${messageSchedules.runAt} end asc`, desc(messageSchedules.updatedAt), desc(messageSchedules.id))
        .limit(q.limit)
        .offset(pageOffset(q)),
      this.db.select({ n: count() }).from(messageSchedules).where(where),
    ])
    return { items: rows.map(toScheduleDto), page: buildPageMeta(q, { total: Number(total?.n ?? 0) }) }
  }

  /** Cancela um agendamento pendente e remove o job da fila (AC-T64-04). */
  async cancel(actor: ChatActor, id: string): Promise<ScheduleDto> {
    const row = await this.visibleRow(actor, id)
    if (row.status !== 'pending') throw new SchedulesError('conflict', 'Só agendamentos pendentes podem ser cancelados', { status: row.status })
    const now = this.now()
    const [updated] = await this.db
      .update(messageSchedules)
      .set({ status: 'cancelled', cancelledAt: now, updatedAt: now })
      .where(and(eq(messageSchedules.id, row.id), eq(messageSchedules.status, 'pending')))
      .returning()
    if (!updated) throw new SchedulesError('conflict', 'O agendamento mudou de estado', { status: 'unknown' })
    await this.opts.jobs.remove({ scheduleId: row.id, runAt: row.runAt.toISOString() })
    return toScheduleDto(updated)
  }

  // ---------- internos ----------

  private async visibleChat(actor: ChatActor, chatId: string) {
    try {
      return await this.query.row(actor, chatId)
    } catch (err) {
      if (err instanceof ChatsError && err.code === 'not_found') throw new SchedulesError('not_found', 'Chat não encontrado')
      throw err
    }
  }

  private async visibleRow(actor: ChatActor, id: string): Promise<Row> {
    if (!uuid.safeParse(id).success) throw scheduleNotFound()
    const [row] = await this.db
      .select()
      .from(messageSchedules)
      .where(and(eq(messageSchedules.companyId, actor.companyId), eq(messageSchedules.id, id)))
      .limit(1)
    if (!row) throw scheduleNotFound()
    // O chat precisa estar no escopo (T119): fora dele, igual a inexistente.
    try {
      await this.query.row(actor, row.chatId)
    } catch (err) {
      if (err instanceof ChatsError && err.code === 'not_found') throw scheduleNotFound()
      throw err
    }
    return row
  }

  private async assertFlow(companyId: string, flowId: string): Promise<void> {
    const [flow] = await this.db
      .select({ status: flows.status, publishedVersion: flows.publishedVersion })
      .from(flows)
      .where(and(eq(flows.companyId, companyId), eq(flows.id, flowId)))
      .limit(1)
    if (!flow) throw scheduleInvalid('flow_id', 'Fluxo não encontrado')
    if (flow.status === 'paused' || flow.status === 'archived') throw scheduleInvalid('flow_id', 'O fluxo precisa estar ativo')
    if (!flow.publishedVersion) throw scheduleInvalid('flow_id', 'O fluxo ainda não tem versão publicada')
  }
}
