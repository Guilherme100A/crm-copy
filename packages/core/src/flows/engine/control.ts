// Controle de runs em espera (T30): agenda timers quando um nó espera, retoma por resposta (`resolveReply`) ou por
// prazo (`fireTimer`), cancela e pausa/retoma fluxos. Toda transição trava o run (FOR NO KEY UPDATE, igual ao
// `flow-step` da T25): resposta e timer simultâneos → só um avança; o outro vira no-op.
// Retomar = run `running` no nó destino do handle, `seq + 1` e novo `flow-step { runId, expectedSeq }`.
import { and, eq, inArray, sql } from 'drizzle-orm'
import { flowRuns, flowVersions, flows, type Database } from '@crm/db'
import type { Logger } from '@crm/node-kit'
import type { FlowDefinition } from '@crm/shared'
import type { EngineHooks, FlowStepJobData } from './runner'
import { FlowTimers, type FlowTimerJobData, type TimerScheduler } from './timers'
import { parseWait, type FlowWait } from './waits'

export interface InboundReply {
  text?: string | null
  message_id?: string | null
  type?: string | null
  [key: string]: unknown
}

export type AdvanceResult =
  | { advanced: true; handle: string; status: 'running' | 'completed'; expectedSeq: number }
  | { advanced: false; reason: 'not_found' | 'not_waiting' | 'stale' | 'paused' | 'not_reply' | 'cancelled' }
  // T111: confirmação de pagamento (`not_payment`: a espera não é desta cobrança; `busy`: passo em execução, tentar
  // de novo; `no_edge`: o nó Pagamento não tem a saída `payment_approved`).
  | { advanced: false; reason: 'not_payment' | 'busy' | 'no_edge' }

/** T111: o que o webhook de pagamento aplica no run retomado. */
export interface PaymentResume {
  /** Cobrança (`payment_charges.id`) que o run espera. */
  chargeId: string
  /** Variáveis do run depois da confirmação (recebe as atuais). */
  vars?: (current: Record<string, unknown>) => Record<string, unknown>
}

export interface FlowControlOptions {
  db: Database
  /** Agendador durável (BullMQ `flow-timer`); sem ele, os timers rodam em processo. */
  timers?: TimerScheduler
  /** Enfileira o `flow-step` que continua o run depois de retomado. */
  enqueueStep?: (job: FlowStepJobData) => Promise<void>
  now?: () => Date
  /** Atrasos até este valor rodam em processo (padrão 5000 ms). */
  shortDelayMs?: number
  logger?: Pick<Logger, 'warn' | 'error'>
}

type Tx = Parameters<Parameters<Database['transaction']>[0]>[0]
type RunRow = typeof flowRuns.$inferSelect

/** Runs que ainda podem ser cancelados. */
export const CANCELLABLE_RUN_STATUSES = ['running', 'waiting', 'paused'] as const

export class FlowControl {
  private readonly db: Database
  private readonly opts: FlowControlOptions
  readonly timers: FlowTimers

  constructor(opts: FlowControlOptions) {
    this.db = opts.db
    this.opts = opts
    this.timers = new FlowTimers((data) => this.fireTimer(data), {
      scheduler: opts.timers,
      shortDelayMs: opts.shortDelayMs,
      onError: (err) => opts.logger?.error({ err }, 'flow timer failed'),
    })
  }

  private now(): Date {
    return this.opts.now?.() ?? new Date()
  }

  /**
   * Hooks para `new FlowEngine({ hooks })`: quando um nó devolve `wait`, normaliza o objeto (o mesmo que o runner
   * grava em `flow_runs.wait`) e agenda o timer do prazo. Encadeia `inner` (hooks do chamador).
   */
  engineHooks(inner?: EngineHooks): EngineHooks {
    return {
      afterNode: async (info) => {
        if (info.outcome && 'wait' in info.outcome) {
          const raw = info.outcome.wait as Record<string, unknown>
          const wait = parseWait(raw, this.opts.now)
          if (wait) {
            // Com `delay_ms`, o prazo conta do relógio do controle e o job recebe o atraso exato.
            const delayMs = typeof raw.delay_ms === 'number' ? Math.max(0, raw.delay_ms) : undefined
            if (delayMs !== undefined) wait.deadline_at = new Date(this.now().getTime() + delayMs).toISOString()
            delete wait.delay_ms
            // Mesmo objeto do outcome: o runner persiste a versão normalizada (deadline_at calculado).
            Object.assign(raw, wait)
            delete raw.delay_ms
            await this.scheduleWait(info.runId, info.seq, wait, delayMs)
          }
        }
        await inner?.afterNode?.(info)
      },
    }
  }

  /** Agenda o timer da espera (se tiver prazo). Reagendar o mesmo (run, seq, gen) não duplica. */
  async scheduleWait(runId: string, seq: number, wait: FlowWait, delayMs?: number): Promise<void> {
    if (!wait.deadline_at) return
    const delay = delayMs ?? new Date(wait.deadline_at).getTime() - this.now().getTime()
    await this.timers.schedule({ runId, seq, gen: wait.timer_gen ?? 0 }, Math.max(0, delay))
  }

  /**
   * Resposta do lead para o run em espera `reply`: segue o handle de resposta. Com `wait.reentry` (T62: menus e
   * buffer), a resposta volta ao PRÓPRIO nó, que decide o handle: o run fica no nó atual e as respostas se acumulam
   * em `vars.__replies`.
   */
  async resolveReply(runId: string, inbound: InboundReply): Promise<AdvanceResult> {
    return this.advance(runId, (run, wait) => {
      if (wait.kind !== 'reply') return { reason: 'not_reply' as const }
      const vars = { ...(run.vars ?? {}), last_user_message: inbound.text ?? '', reply: { ...inbound } }
      if (wait.reentry === true) {
        const prev = (run.vars as Record<string, unknown> | null)?.__replies
        return { handle: wait.handles.reply ?? 'source', stay: true, vars: { ...vars, __replies: [...(Array.isArray(prev) ? prev : []), { ...inbound }] } }
      }
      return { handle: wait.handles.reply ?? 'source', vars }
    })
  }

  /** Resposta para o run em espera do contato (vinda do `crm.inbound`). Sem run esperando → `not_found`. */
  async resolveReplyForContact(ctx: { companyId: string }, contactId: string, inbound: InboundReply): Promise<AdvanceResult> {
    const [run] = await this.db
      .select({ id: flowRuns.id })
      .from(flowRuns)
      .where(and(eq(flowRuns.companyId, ctx.companyId), eq(flowRuns.contactId, contactId), eq(flowRuns.status, 'waiting')))
      .limit(1)
    if (!run) return { advanced: false, reason: 'not_found' }
    return this.resolveReply(run.id, inbound)
  }

  /** Disparo do timer: segue o handle de timeout se o run ainda espera neste (seq, gen). */
  async fireTimer(data: FlowTimerJobData): Promise<AdvanceResult> {
    return this.advance(
      data.runId,
      (_run, wait) => ({ handle: wait.handles.timeout ?? 'timeout' }),
      { seq: data.seq, gen: data.gen ?? 0 },
    )
  }

  /** Cancela o run (não terminal) e remove o timer. Um timer antigo que dispare depois vira no-op. */
  async cancel(runId: string): Promise<{ cancelled: boolean }> {
    let timer: FlowTimerJobData | null = null
    const ok = await this.db.transaction(async (tx) => {
      const run = await this.lock(tx, runId)
      if (!run || !(CANCELLABLE_RUN_STATUSES as readonly string[]).includes(run.status)) return false
      const wait = parseWait(run.wait)
      if (wait?.deadline_at) timer = { runId, seq: run.seq, gen: wait.timer_gen ?? 0 }
      await tx
        .update(flowRuns)
        .set({ status: 'cancelled', wait: null, finishedAt: this.now(), updatedAt: sql`now()` })
        .where(eq(flowRuns.id, runId))
      return true
    })
    if (timer) await this.cancelTimer(timer)
    return { cancelled: ok }
  }

  /** "Parar fluxo" do chat (06 §5.5): cancela os runs não terminais do contato. */
  async cancelForContact(ctx: { companyId: string }, contactId: string): Promise<{ cancelled: number }> {
    const runs = await this.db
      .select({ id: flowRuns.id })
      .from(flowRuns)
      .where(and(eq(flowRuns.companyId, ctx.companyId), eq(flowRuns.contactId, contactId), inArray(flowRuns.status, [...CANCELLABLE_RUN_STATUSES])))
    let cancelled = 0
    for (const r of runs) if ((await this.cancel(r.id)).cancelled) cancelled++
    return { cancelled }
  }

  /** Pausa o fluxo: status `paused`; runs em espera congelam com o restante do prazo e perdem o timer. */
  async pauseFlow(ctx: { companyId: string }, flowId: string): Promise<{ paused_runs: number }> {
    const now = this.now()
    const timers: FlowTimerJobData[] = []
    const count = await this.db.transaction(async (tx) => {
      await tx.update(flows).set({ status: 'paused', updatedAt: now }).where(and(eq(flows.id, flowId), eq(flows.companyId, ctx.companyId)))
      const runs = await tx
        .select()
        .from(flowRuns)
        .where(and(eq(flowRuns.companyId, ctx.companyId), eq(flowRuns.flowId, flowId), eq(flowRuns.status, 'waiting')))
        .for('no key update')
      for (const run of runs) {
        const wait = parseWait(run.wait) ?? { kind: 'reply', handles: {}, deadline_at: null }
        const remaining = wait.deadline_at ? Math.max(0, new Date(wait.deadline_at).getTime() - now.getTime()) : null
        if (wait.deadline_at) timers.push({ runId: run.id, seq: run.seq, gen: wait.timer_gen ?? 0 })
        await tx
          .update(flowRuns)
          .set({ status: 'paused', wait: { ...wait, remaining_ms: remaining, paused_at: now.toISOString() }, updatedAt: sql`now()` })
          .where(eq(flowRuns.id, run.id))
      }
      return runs.length
    })
    for (const t of timers) await this.cancelTimer(t)
    return { paused_runs: count }
  }

  /** Retoma o fluxo: status `active`; runs pausados voltam a esperar com prazo = agora + restante (timer novo). */
  async resumeFlow(ctx: { companyId: string }, flowId: string): Promise<{ resumed_runs: number }> {
    const now = this.now()
    const toSchedule: Array<{ runId: string; seq: number; wait: FlowWait }> = []
    const count = await this.db.transaction(async (tx) => {
      await tx.update(flows).set({ status: 'active', updatedAt: now }).where(and(eq(flows.id, flowId), eq(flows.companyId, ctx.companyId)))
      const runs = await tx
        .select()
        .from(flowRuns)
        .where(and(eq(flowRuns.companyId, ctx.companyId), eq(flowRuns.flowId, flowId), eq(flowRuns.status, 'paused')))
        .for('no key update')
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
        await tx.update(flowRuns).set({ status: 'waiting', wait: next, updatedAt: sql`now()` }).where(eq(flowRuns.id, run.id))
        toSchedule.push({ runId: run.id, seq: run.seq, wait: next })
      }
      return runs.length
    })
    for (const s of toSchedule) await this.scheduleWait(s.runId, s.seq, s.wait)
    return { resumed_runs: count }
  }

  // ---------------------------------------------------------------- T111: pagamento

  /** Webhook aprovado para o run que espera NO nó Pagamento (`wait.kind = 'payment'` desta cobrança). */
  async resolvePayment(runId: string, input: PaymentResume): Promise<AdvanceResult> {
    return this.advance(runId, (run, wait) => {
      if (wait.kind !== 'payment' || wait.charge_id !== input.chargeId) return { reason: 'not_reply' as const }
      return { handle: wait.handles.reply ?? 'source', vars: input.vars ? input.vars({ ...(run.vars ?? {}) }) : undefined }
    }).then((r) => (!r.advanced && r.reason === 'not_reply' ? { advanced: false as const, reason: 'not_payment' as const } : r))
  }

  /**
   * "Interrompe o contato" (19 §5.5): leva o run — esperando (qualquer espera) ou já concluído — ao destino da aresta
   * `handle` do nó Pagamento `nodeKey`, cancelando o timer pendente. Run em execução → `busy` (o job tenta de novo);
   * pausado/cancelado/falho → não move.
   */
  async interruptForPayment(runId: string, input: PaymentResume & { nodeKey: string; handle: string }): Promise<AdvanceResult> {
    let timer: FlowTimerJobData | null = null
    let enqueue: FlowStepJobData | null = null
    const result = await this.db.transaction(async (tx): Promise<AdvanceResult> => {
      const run = await this.lock(tx, runId)
      if (!run) return { advanced: false, reason: 'not_found' }
      if (run.status === 'cancelled') return { advanced: false, reason: 'cancelled' }
      if (run.status === 'paused') return { advanced: false, reason: 'paused' }
      if (run.status === 'running') return { advanced: false, reason: 'busy' }
      if (run.status !== 'waiting' && run.status !== 'completed') return { advanced: false, reason: 'not_waiting' }
      const [flow] = await tx.select({ status: flows.status }).from(flows).where(eq(flows.id, run.flowId)).limit(1)
      if (flow?.status === 'paused') return { advanced: false, reason: 'paused' }
      const edge = (await this.definition(tx, run.versionId))?.edges.find((e) => e.from === input.nodeKey && e.handle === input.handle)
      if (!edge) return { advanced: false, reason: 'no_edge' }
      const wait = run.status === 'waiting' ? parseWait(run.wait) : null
      const seq = run.seq + 1
      await tx
        .update(flowRuns)
        .set({
          status: 'running',
          currentNodeKey: edge.to,
          seq,
          wait: null,
          vars: input.vars ? input.vars({ ...(run.vars ?? {}) }) : run.vars,
          finishedAt: null,
          updatedAt: sql`now()`,
        })
        .where(eq(flowRuns.id, run.id))
      if (wait?.deadline_at) timer = { runId, seq: run.seq, gen: wait.timer_gen ?? 0 }
      enqueue = { runId, expectedSeq: seq }
      return { advanced: true, handle: input.handle, status: 'running', expectedSeq: seq }
    })
    if (timer) await this.cancelTimer(timer)
    if (enqueue) await this.opts.enqueueStep?.(enqueue)
    return result
  }

  // ---------------------------------------------------------------- internos

  private async lock(tx: Tx, runId: string): Promise<RunRow | undefined> {
    const [run] = await tx.select().from(flowRuns).where(sql`${flowRuns.id}::text = ${runId}`).for('no key update').limit(1)
    return run
  }

  /**
   * Retoma o run em espera pelo handle escolhido por `pick`. `guard` (timer) exige o mesmo `seq`/`gen` da espera.
   */
  private async advance(
    runId: string,
    pick: (run: RunRow, wait: FlowWait) => { handle: string; vars?: Record<string, unknown>; stay?: boolean } | { reason: 'not_reply' },
    guard?: { seq: number; gen: number },
  ): Promise<AdvanceResult> {
    let timer: FlowTimerJobData | null = null
    let enqueue: FlowStepJobData | null = null
    const result = await this.db.transaction(async (tx): Promise<AdvanceResult> => {
      const run = await this.lock(tx, runId)
      if (!run) return { advanced: false, reason: 'not_found' }
      if (run.status === 'cancelled') return { advanced: false, reason: 'cancelled' }
      if (run.status === 'paused') return { advanced: false, reason: 'paused' }
      if (run.status !== 'waiting') return { advanced: false, reason: 'not_waiting' }
      const wait = parseWait(run.wait)
      if (!wait) return { advanced: false, reason: 'not_waiting' }
      if (guard && (guard.seq !== run.seq || guard.gen !== (wait.timer_gen ?? 0))) return { advanced: false, reason: 'stale' }
      // Timer vencido de fluxo pausado (pausa sem passar pelos runs): congela em vez de avançar.
      const [flow] = await tx.select({ status: flows.status }).from(flows).where(eq(flows.id, run.flowId)).limit(1)
      if (flow?.status === 'paused') return { advanced: false, reason: 'paused' }

      const choice = pick(run, wait)
      if ('reason' in choice) return { advanced: false, reason: choice.reason }
      const from = run.currentNodeKey ?? ''
      // `stay` (espera com reentry): reexecuta o mesmo nó, sem seguir aresta.
      const edge = choice.stay ? { to: from } : (await this.definition(tx, run.versionId))?.edges.find((e) => e.from === from && e.handle === choice.handle)
      const seq = run.seq + 1
      const done = !edge
      await tx
        .update(flowRuns)
        .set({
          status: done ? 'completed' : 'running',
          currentNodeKey: edge?.to ?? null,
          seq,
          wait: null,
          vars: choice.vars ?? run.vars,
          finishedAt: done ? this.now() : null,
          updatedAt: sql`now()`,
        })
        .where(eq(flowRuns.id, run.id))
      if (wait.deadline_at && !guard) timer = { runId, seq: run.seq, gen: wait.timer_gen ?? 0 }
      if (!done) enqueue = { runId, expectedSeq: seq }
      return { advanced: true, handle: choice.handle, status: done ? 'completed' : 'running', expectedSeq: seq }
    })
    if (timer) await this.cancelTimer(timer)
    if (enqueue) await this.opts.enqueueStep?.(enqueue)
    return result
  }

  private async definition(tx: Tx, versionId: string | null): Promise<FlowDefinition | null> {
    if (!versionId) return null
    const [v] = await tx.select({ definition: flowVersions.definition }).from(flowVersions).where(eq(flowVersions.id, versionId)).limit(1)
    return (v?.definition as unknown as FlowDefinition) ?? null
  }

  private async cancelTimer(data: FlowTimerJobData) {
    try {
      await this.timers.cancel(data)
    } catch (err) {
      this.opts.logger?.warn({ err, runId: data.runId }, 'could not remove flow timer')
    }
  }
}
