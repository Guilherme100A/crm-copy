// Fluxos pausados na queda da conexão (08 §5.13; T71): contagem, "Retomar" e "Cancelar" dos runs que o projetor
// (T47) pausou com `wait.paused_by = 'connection'` e `wait.connection_id`. Retomar faz o mesmo que o `resumeFlow`
// (T30): o run volta a `waiting` com prazo = agora + restante e `timer_gen + 1` (o timer antigo vira no-op) e
// publica `flow.resumed`. Cancelar passa cada run pelo `cancel` do FlowControl (remove o timer).
import { connections, flowRuns, type Database } from '@crm/db'
import { and, count, countDistinct, eq, sql } from 'drizzle-orm'
import { parseWait, type FlowWait } from '../flows/engine/waits'
import { PAUSED_BY_CONNECTION, type ConnectionStatusPublisher } from './projector'

export interface PausedFlowsControl {
  /** Agenda o timer da espera retomada (`FlowControl.scheduleWait`). */
  scheduleWait(runId: string, seq: number, wait: FlowWait): Promise<void>
  /** Cancela o run e remove o timer (`FlowControl.cancel`). */
  cancel(runId: string): Promise<{ cancelled: boolean }>
}

export interface PausedFlowsOptions {
  db: Database
  control: PausedFlowsControl
  publisher?: ConnectionStatusPublisher
  now?: () => Date
}

export interface PausedFlowsSummary {
  paused_count: number
  total_leads: number
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Filtro dos runs pausados pela queda desta conexão. */
export const pausedByConnection = (companyId: string, connectionId: string) =>
  and(
    eq(flowRuns.companyId, companyId),
    eq(flowRuns.status, 'paused'),
    sql`${flowRuns.wait}->>'paused_by' = ${PAUSED_BY_CONNECTION}`,
    sql`${flowRuns.wait}->>'connection_id' = ${connectionId}`,
  )

/** Pausados pela queda, por conexão da empresa (para o DTO da lista). */
export async function pausedFlowCountsByConnection(db: Database, companyId: string): Promise<Map<string, number>> {
  const rows = await db
    .select({ connectionId: sql<string>`${flowRuns.wait}->>'connection_id'`, n: count() })
    .from(flowRuns)
    .where(and(eq(flowRuns.companyId, companyId), eq(flowRuns.status, 'paused'), sql`${flowRuns.wait}->>'paused_by' = ${PAUSED_BY_CONNECTION}`))
    .groupBy(sql`${flowRuns.wait}->>'connection_id'`)
  return new Map(rows.map((r) => [r.connectionId, Number(r.n)]))
}

export class ConnectionPausedFlows {
  private readonly db: Database
  private readonly now: () => Date

  constructor(private readonly opts: PausedFlowsOptions) {
    this.db = opts.db
    this.now = opts.now ?? (() => new Date())
  }

  /** `null` = conexão inexistente ou de outra empresa. */
  async summary(companyId: string, connectionId: string): Promise<PausedFlowsSummary | null> {
    if (!(await this.connection(companyId, connectionId))) return null
    const [r] = await this.db.select({ n: count(), leads: countDistinct(flowRuns.contactId) }).from(flowRuns).where(pausedByConnection(companyId, connectionId))
    return { paused_count: Number(r?.n ?? 0), total_leads: Number(r?.leads ?? 0) }
  }

  /** Retoma os runs pausados pela queda; `null` = conexão desconhecida. */
  async resume(companyId: string, connectionId: string): Promise<{ resumed: number } | null> {
    const conn = await this.connection(companyId, connectionId)
    if (!conn) return null
    const now = this.now()
    const toSchedule: Array<{ runId: string; seq: number; wait: FlowWait }> = []
    await this.db.transaction(async (tx) => {
      const runs = await tx.select().from(flowRuns).where(pausedByConnection(companyId, connectionId)).for('no key update')
      for (const run of runs) {
        const wait = parseWait(run.wait) ?? { kind: 'reply', handles: {}, deadline_at: null }
        const remaining = typeof wait.remaining_ms === 'number' ? wait.remaining_ms : null
        const next: FlowWait = {
          ...wait,
          deadline_at: remaining === null ? null : new Date(now.getTime() + remaining).toISOString(),
          timer_gen: (wait.timer_gen ?? 0) + 1,
          remaining_ms: null,
        }
        delete next.paused_at
        delete next.paused_by
        delete next.connection_id
        await tx.update(flowRuns).set({ status: 'waiting', wait: next, updatedAt: sql`now()` }).where(eq(flowRuns.id, run.id))
        toSchedule.push({ runId: run.id, seq: run.seq, wait: next })
      }
    })
    for (const s of toSchedule) await this.opts.control.scheduleWait(s.runId, s.seq, s.wait)
    await this.opts.publisher
      ?.publish(companyId, 'flow.resumed', { connection_id: conn.id, session_id: conn.sessionId, resumed_count: toSchedule.length })
      .catch(() => undefined)
    return { resumed: toSchedule.length }
  }

  /** Cancela os runs pausados pela queda; devolve os ids cancelados (`null` = conexão desconhecida). */
  async cancel(companyId: string, connectionId: string): Promise<{ cancelled: string[] } | null> {
    if (!(await this.connection(companyId, connectionId))) return null
    const runs = await this.db.select({ id: flowRuns.id }).from(flowRuns).where(pausedByConnection(companyId, connectionId))
    const cancelled: string[] = []
    for (const r of runs) if ((await this.opts.control.cancel(r.id)).cancelled) cancelled.push(r.id)
    return { cancelled }
  }

  private async connection(companyId: string, connectionId: string) {
    if (!UUID_RE.test(connectionId)) return undefined
    const [row] = await this.db
      .select({ id: connections.id, sessionId: connections.sessionId })
      .from(connections)
      .where(and(eq(connections.id, connectionId), eq(connections.companyId, companyId)))
    return row
  }
}
