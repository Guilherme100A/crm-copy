// Execução de um agendamento (T64; AC-T64-02/03): chamado pelo job `schedules` no horário. Mensagem sai pelo
// ChatSendService (WaGateway.send → pipeline), em nome de quem agendou e com Idempotency-Key por ocorrência; fluxo
// cria o run pelo motor. Recorrente: o mesmo registro avança para a próxima ocorrência e um novo job é enfileirado.
import { and, eq } from 'drizzle-orm'
import { chats, companies, messageSchedules, users, type Database } from '@crm/db'
import type { SendMessageInput, Sender } from '../chats/send/service'
import { nextOccurrenceAfter, type ScheduleJobData } from './rules'

export interface ScheduleRunnerDeps {
  db: Database
  /** O `ChatSendService` (T49). */
  send: {
    send(companyId: string, chatId: string, sender: Sender, input: SendMessageInput, idempotencyKey?: string | null): Promise<{ message: { id: string } }>
  }
  /** O motor de fluxos (T25): `startRun` cria o run e enfileira o 1º passo. */
  flows: {
    startRun(ctx: { companyId: string }, input: { flowId: string; contactId: string; chatId?: string | null; trigger?: Record<string, unknown> | null }): Promise<unknown>
  }
  /** Agenda o job da próxima ocorrência (recorrência). */
  enqueue(job: ScheduleJobData, delayMs: number): Promise<void>
  now?: () => Date
  logger?: { warn(obj: object, msg?: string): void }
}

export type ScheduleRunResult =
  | { executed: true; status: 'sent' | 'failed' | 'pending'; message_id?: string; flow_run_id?: string; next_run_at?: string; error?: string }
  | { executed: false; reason: 'not_found' | 'not_pending' | 'stale' }

const DEFAULT_TZ = 'America/Sao_Paulo'

const runIdOf = (r: unknown): string | null => {
  const id = r && typeof r === 'object' ? (r as { runId?: unknown }).runId : null
  return typeof id === 'string' ? id : null
}

export async function runSchedule(deps: ScheduleRunnerDeps, job: ScheduleJobData): Promise<ScheduleRunResult> {
  const now = deps.now?.() ?? new Date()
  const [row] = await deps.db.select().from(messageSchedules).where(eq(messageSchedules.id, job.scheduleId)).limit(1)
  if (!row) return { executed: false, reason: 'not_found' }
  if (row.status !== 'pending') return { executed: false, reason: 'not_pending' }
  // Job de uma ocorrência antiga (reagendado ou recriado): não executa duas vezes.
  if (row.runAt.getTime() !== Date.parse(job.runAt)) return { executed: false, reason: 'stale' }

  const [ctx] = await deps.db
    .select({ contactId: chats.contactId, timeZone: companies.timeZone })
    .from(chats)
    .innerJoin(companies, eq(companies.id, chats.companyId))
    .where(and(eq(chats.id, row.chatId), eq(chats.companyId, row.companyId)))
    .limit(1)

  let messageId: string | undefined
  let flowRunId: string | undefined
  let error: string | undefined
  try {
    if (!ctx) throw new Error('Chat não encontrado')
    if (row.kind === 'message') {
      if (!row.createdByUserId) throw new Error('Quem agendou não existe mais')
      const [author] = await deps.db.select({ name: users.name }).from(users).where(eq(users.id, row.createdByUserId)).limit(1)
      if (!author) throw new Error('Quem agendou não existe mais')
      const r = await deps.send.send(
        row.companyId,
        row.chatId,
        { userId: row.createdByUserId, name: author.name },
        { type: 'text', text: row.text ?? '' },
        `schedule:${row.id}:${row.runAt.getTime()}`,
      )
      messageId = r.message.id
    } else {
      const r = await deps.flows.startRun(
        { companyId: row.companyId },
        { flowId: row.flowId!, contactId: ctx.contactId, chatId: row.chatId, trigger: { kind: 'schedule', schedule_id: row.id } },
      )
      flowRunId = runIdOf(r) ?? undefined
    }
  } catch (err) {
    error = (err instanceof Error ? err.message : String(err)).slice(0, 1000)
    deps.logger?.warn({ err, scheduleId: row.id }, 'agendamento falhou')
  }

  const next = nextOccurrenceAfter(row.runAt, row.recurrence, ctx?.timeZone ?? DEFAULT_TZ, now)
  const base = {
    runCount: row.runCount + 1,
    lastRunAt: now,
    lastError: error ?? null,
    ...(messageId ? { lastMessageId: messageId } : {}),
    ...(flowRunId ? { lastFlowRunId: flowRunId } : {}),
    updatedAt: now,
  }
  const where = and(eq(messageSchedules.id, row.id), eq(messageSchedules.status, 'pending'), eq(messageSchedules.runAt, row.runAt))

  if (next) {
    // Recorrente: volta a `pending` na próxima ocorrência (mesmo com falha nesta) e agenda o próximo job.
    const [updated] = await deps.db.update(messageSchedules).set({ ...base, status: 'pending', runAt: next }).where(where).returning({ id: messageSchedules.id })
    if (updated) await deps.enqueue({ scheduleId: row.id, runAt: next.toISOString() }, next.getTime() - now.getTime())
    return { executed: true, status: 'pending', next_run_at: next.toISOString(), ...(messageId ? { message_id: messageId } : {}), ...(flowRunId ? { flow_run_id: flowRunId } : {}), ...(error ? { error } : {}) }
  }
  const status = error ? 'failed' : 'sent'
  await deps.db.update(messageSchedules).set({ ...base, status }).where(where)
  return { executed: true, status, ...(messageId ? { message_id: messageId } : {}), ...(flowRunId ? { flow_run_id: flowRunId } : {}), ...(error ? { error } : {}) }
}
