// Preparação e agendador dos disparos em massa (T74; 10 §4–5). A T60 cria o disparo (`preparing`) com os
// destinatários já resolvidos; aqui a preparação revisa o público, conta, distribui entre os alvos pela capacidade
// de cada conexão e agenda um tick por alvo. Cada tick inicia o fluxo de UM destinatário (pelo starter, que passa
// pelo WaGateway/SendPipeline) e agenda o próximo após um intervalo aleatório entre mín e máx, respeitando janela,
// dias da semana, limite diário e o estado da conexão. Todo job leva `dispatchId` (o cancelamento da T60 usa).
import { and, asc, count, eq, gte, inArray, isNull, sql } from 'drizzle-orm'
import { connections, massDispatchRecipients, massDispatchTargets, massDispatches, type Database, type MassDispatchStatus } from '@crm/db'
import { CONNECTED_STATES, type WaGateway } from '@crm/wa-port'
import { warmupCapacity } from '../mass-dispatch/rules'
import { massDispatchPerConnectionLimit } from '../mass-dispatch/service'
import { FlowControl } from '../flows/engine/control'
import { flowEngineStarter, type MassDispatchStarter } from './starter'
import { isWithinWindow, nextAllowedTime, nextDayWindowStart, zonedDayStart, type SendWindow } from './window'

type DispatchRow = typeof massDispatches.$inferSelect

export interface TickJob {
  kind: 'tick'
  dispatchId: string
  targetId: string
}

export interface MassDispatchRunnerDeps {
  db: Database
  wa: Pick<WaGateway, 'sessions'> & Partial<WaGateway>
  /** Envio de um destinatário (padrão: `flowEngineStarter` com `wa` e `control`). */
  starter?: MassDispatchStarter
  /** Agenda o próximo tick (fila `mass-dispatch`, job delayed). */
  schedule: (job: TickJob, delayMs: number) => Promise<void>
  publisher?: { publish(companyId: string, type: 'mass_dispatch.updated', data: never, opts?: object): Promise<unknown> }
  control?: Pick<FlowControl, 'cancelForContact'>
  now?: () => Date
  rng?: () => number
  /** Reagendamento após RATE_LIMIT/WARMUP_LIMIT (padrão 60 s). */
  retryDelayMs?: number
  /** Nova checagem de conexão desconectada (padrão 60 s). */
  pausedRecheckMs?: number
  logger?: { warn(obj: object, msg?: string): void }
}

export const PREPARATION_PHASES = ['queued', 'resolving_recipients', 'counting', 'scheduling', 'completed'] as const
/** No máximo um `mass_dispatch.updated` por segundo por disparo (mudança de status e fim sempre saem). */
export const UPDATE_THROTTLE_MS = 1000
const RUNNABLE: readonly MassDispatchStatus[] = ['scheduled', 'running', 'paused']

const lastPublished = new Map<string, number>()

function nowOf(deps: MassDispatchRunnerDeps): Date {
  return deps.now ? deps.now() : new Date()
}

const windowOf = (d: DispatchRow): SendWindow => ({ weekdays: d.weekdays, windowStart: d.windowStart, windowEnd: d.windowEnd, timeZone: d.timeZone })

async function counts(db: Database, dispatchId: string) {
  const rows = await db
    .select({ status: massDispatchRecipients.status, n: count() })
    .from(massDispatchRecipients)
    .where(eq(massDispatchRecipients.dispatchId, dispatchId))
    .groupBy(massDispatchRecipients.status)
  const by = (s: string) => rows.find((r) => r.status === s)?.n ?? 0
  return { pending: by('pending'), started: by('started'), failed: by('failed'), skipped: by('skipped'), cancelled: by('cancelled') }
}

/** Publica `mass_dispatch.updated` respeitando o limite de 1/s (`force` ignora o limite). */
async function publishUpdate(deps: MassDispatchRunnerDeps, dispatchId: string, force: boolean): Promise<void> {
  if (!deps.publisher) return
  const at = nowOf(deps).getTime()
  const prev = lastPublished.get(dispatchId)
  if (!force && prev !== undefined && at - prev < UPDATE_THROTTLE_MS) return
  const [d] = await deps.db.select().from(massDispatches).where(eq(massDispatches.id, dispatchId))
  if (!d) return
  const c = await counts(deps.db, dispatchId)
  lastPublished.set(dispatchId, at)
  try {
    await deps.publisher.publish(d.companyId, 'mass_dispatch.updated', {
      mass_dispatch_id: d.id,
      status: d.status,
      preparation_progress: d.preparationProgress,
      total_count: c.pending + c.started + c.failed,
      pending_count: c.pending,
      sent_count: c.started,
      failed_count: c.failed,
      skipped_count: c.skipped,
    } as never)
  } catch (err) {
    deps.logger?.warn({ err, dispatch_id: dispatchId }, 'falha ao publicar mass_dispatch.updated')
  }
}

async function setProgress(deps: MassDispatchRunnerDeps, d: DispatchRow, progress: Record<string, unknown>, extra: Partial<typeof massDispatches.$inferInsert> = {}, force = false) {
  await deps.db
    .update(massDispatches)
    .set({ preparationProgress: progress, updatedAt: nowOf(deps), ...extra })
    .where(eq(massDispatches.id, d.id))
  await publishUpdate(deps, d.id, force || extra.status !== undefined)
}

/** Capacidade de hoje da conexão: warm-up (T60) ou, terminado, o limite por conexão; desconectada = 0. */
async function connectionCapacity(deps: MassDispatchRunnerDeps, sessionId: string | null, fallback: number): Promise<number> {
  if (!sessionId) return 0
  try {
    const s = await deps.wa.sessions.get(sessionId)
    if (!(CONNECTED_STATES as readonly string[]).includes(s.status)) return 0
    return warmupCapacity(s.warmupStartedAt, nowOf(deps)) ?? fallback
  } catch {
    return 0
  }
}

/** Partes inteiras proporcionais aos pesos (maior resto; empate pela ordem). Pesos todos 0 → partes iguais. */
export function proportionalSplit(total: number, weights: readonly number[]): number[] {
  if (!weights.length) return []
  const w = weights.some((x) => x > 0) ? weights.map((x) => Math.max(0, x)) : weights.map(() => 1)
  const sum = w.reduce((a, b) => a + b, 0)
  const raw = w.map((x) => (total * x) / sum)
  const out = raw.map(Math.floor)
  let rest = total - out.reduce((a, b) => a + b, 0)
  const order = raw.map((r, i) => ({ i, frac: r - Math.floor(r) })).sort((a, b) => b.frac - a.frac || a.i - b.i)
  for (const { i } of order) {
    if (rest <= 0) break
    if (w[i]! > 0) {
      out[i]!++
      rest--
    }
  }
  return out
}

export interface PrepareResult {
  status: MassDispatchStatus | 'missing'
  target_count: number
  assigned: Record<string, number>
  ticks: Array<{ targetId: string; delayMs: number }>
}

/** Preparação: resolving_recipients → counting → scheduling → completed (status `scheduled`) e 1º tick por alvo. */
export async function prepareMassDispatch(deps: MassDispatchRunnerDeps, dispatchId: string): Promise<PrepareResult> {
  const [d] = await deps.db.select().from(massDispatches).where(eq(massDispatches.id, dispatchId))
  if (!d) return { status: 'missing', target_count: 0, assigned: {}, ticks: [] }
  if (d.status !== 'preparing') return { status: d.status, target_count: 0, assigned: {}, ticks: [] }
  try {
    // 1) Revê o público: quem pediu opt-out (ou perdeu o telefone) desde a criação não recebe.
    await setProgress(deps, d, { phase: 'resolving_recipients', scheduled_count: 0, target_count: 0 }, {}, true)
    await deps.db.execute(sql`
      update crm.mass_dispatch_recipients r
      set status = 'skipped', skip_reason = case when c.opt_out then 'opt_out' else 'no_phone' end, updated_at = now()
      from crm.contacts c
      where r.dispatch_id = ${d.id} and r.status = 'pending' and c.id = r.contact_id and (c.opt_out or c.phone_e164 is null)`)

    // 2) Conta os pendentes.
    const [pending] = await deps.db
      .select({ n: count() })
      .from(massDispatchRecipients)
      .where(and(eq(massDispatchRecipients.dispatchId, d.id), eq(massDispatchRecipients.status, 'pending')))
    const target = pending?.n ?? 0
    await setProgress(deps, d, { phase: 'counting', scheduled_count: 0, target_count: target })

    // 3) Distribui os sem alvo, proporcional à capacidade de hoje de cada conexão.
    const targets = await deps.db
      .select({ id: massDispatchTargets.id, sessionId: connections.sessionId })
      .from(massDispatchTargets)
      .leftJoin(connections, eq(connections.id, massDispatchTargets.connectionId))
      .where(eq(massDispatchTargets.dispatchId, d.id))
      .orderBy(asc(massDispatchTargets.position))
    const fallback = await massDispatchPerConnectionLimit(deps.db)
    const capacities = await Promise.all(targets.map((t) => connectionCapacity(deps, t.sessionId, fallback)))
    await setProgress(deps, d, { phase: 'scheduling', scheduled_count: 0, target_count: target })
    const unassigned = await deps.db
      .select({ id: massDispatchRecipients.id })
      .from(massDispatchRecipients)
      .where(and(eq(massDispatchRecipients.dispatchId, d.id), eq(massDispatchRecipients.status, 'pending'), isNull(massDispatchRecipients.targetId)))
      .orderBy(asc(massDispatchRecipients.createdAt), asc(massDispatchRecipients.id))
    const shares = proportionalSplit(unassigned.length, capacities)
    let offset = 0
    for (const [i, t] of targets.entries()) {
      const ids = unassigned.slice(offset, offset + shares[i]!).map((r) => r.id)
      offset += shares[i]!
      for (let k = 0; k < ids.length; k += 1000)
        await deps.db
          .update(massDispatchRecipients)
          .set({ targetId: t.id, updatedAt: nowOf(deps) })
          .where(inArray(massDispatchRecipients.id, ids.slice(k, k + 1000)))
      await setProgress(deps, d, { phase: 'scheduling', scheduled_count: offset, target_count: target })
    }

    const assignedRows = await deps.db
      .select({ targetId: massDispatchRecipients.targetId, n: count() })
      .from(massDispatchRecipients)
      .where(and(eq(massDispatchRecipients.dispatchId, d.id), eq(massDispatchRecipients.status, 'pending')))
      .groupBy(massDispatchRecipients.targetId)
    const assigned: Record<string, number> = Object.fromEntries(targets.map((t) => [t.id, 0]))
    for (const r of assignedRows) if (r.targetId && r.targetId in assigned) assigned[r.targetId] = r.n

    // 4) Pronto: agendado. Um tick por alvo com destinatários, no próximo horário permitido.
    const [current] = await deps.db.select({ status: massDispatches.status }).from(massDispatches).where(eq(massDispatches.id, d.id))
    if (current?.status !== 'preparing') return { status: current?.status ?? 'missing', target_count: target, assigned, ticks: [] }
    const done = target === 0
    await setProgress(
      deps,
      d,
      { phase: 'completed', scheduled_count: target, target_count: target },
      done ? { status: 'completed', finishedAt: nowOf(deps) } : { status: 'scheduled' },
      true,
    )
    const ticks: Array<{ targetId: string; delayMs: number }> = []
    if (!done) {
      const now = nowOf(deps)
      const from = d.startsSchedulingAt > now ? d.startsSchedulingAt : now
      const delayMs = Math.max(0, nextAllowedTime(from, windowOf(d)).getTime() - now.getTime())
      for (const t of targets)
        if (assigned[t.id]) {
          await deps.schedule({ kind: 'tick', dispatchId: d.id, targetId: t.id }, delayMs)
          ticks.push({ targetId: t.id, delayMs })
        }
    }
    return { status: done ? 'completed' : 'scheduled', target_count: target, assigned, ticks }
  } catch (err) {
    await deps.db
      .update(massDispatches)
      .set({ status: 'failed', preparationError: err instanceof Error ? err.message : String(err), finishedAt: nowOf(deps), updatedAt: nowOf(deps) })
      .where(eq(massDispatches.id, d.id))
    await publishUpdate(deps, d.id, true)
    throw err
  }
}

export type TickAction = 'started' | 'rescheduled' | 'skipped' | 'failed' | 'waiting' | 'completed' | 'stopped'
export type TickReason = 'outside_window' | 'daily_limit' | 'target_paused' | 'rate_limit' | 'warmup_limit' | 'not_started' | 'cancelled' | 'no_pending'

export interface TickResult {
  action: TickAction
  reason?: TickReason
  recipient_id?: string
  run_id?: string | null
  delay_ms?: number
  next_at?: string
}

/** Intervalo aleatório entre mín e máx (ms). */
export function intervalMs(minSeconds: number, maxSeconds: number, rng: () => number = Math.random): number {
  const r = Math.min(Math.max(rng(), 0), 1)
  return Math.round((minSeconds + r * (Math.max(maxSeconds, minSeconds) - minSeconds)) * 1000)
}

async function again(deps: MassDispatchRunnerDeps, job: TickJob, delayMs: number, result: TickResult): Promise<TickResult> {
  const ms = Math.max(0, Math.round(delayMs))
  await deps.schedule(job, ms)
  return { ...result, delay_ms: ms, next_at: new Date(nowOf(deps).getTime() + ms).toISOString() }
}

/** Um passo do agendador para um alvo: no máximo um destinatário iniciado. */
export async function runMassDispatchTick(deps: MassDispatchRunnerDeps, job: { dispatchId: string; targetId: string }): Promise<TickResult> {
  const tick: TickJob = { kind: 'tick', dispatchId: job.dispatchId, targetId: job.targetId }
  const now = nowOf(deps)
  const [d] = await deps.db.select().from(massDispatches).where(eq(massDispatches.id, job.dispatchId))
  if (!d || !RUNNABLE.includes(d.status)) return { action: 'stopped', reason: d?.status === 'cancelled' ? 'cancelled' : undefined }
  const [target] = await deps.db
    .select({ id: massDispatchTargets.id, connectionId: massDispatchTargets.connectionId, flowId: massDispatchTargets.flowId, sessionId: connections.sessionId })
    .from(massDispatchTargets)
    .leftJoin(connections, eq(connections.id, massDispatchTargets.connectionId))
    .where(and(eq(massDispatchTargets.id, job.targetId), eq(massDispatchTargets.dispatchId, d.id)))
  if (!target) return { action: 'stopped' }
  const w = windowOf(d)

  if (now < d.startsSchedulingAt) return again(deps, tick, nextAllowedTime(d.startsSchedulingAt, w).getTime() - now.getTime(), { action: 'waiting', reason: 'not_started' })
  if (!isWithinWindow(now, w)) return again(deps, tick, nextAllowedTime(now, w).getTime() - now.getTime(), { action: 'waiting', reason: 'outside_window' })

  if (d.dailyLimit !== null) {
    const [today] = await deps.db
      .select({ n: count() })
      .from(massDispatchRecipients)
      .where(and(eq(massDispatchRecipients.dispatchId, d.id), eq(massDispatchRecipients.status, 'started'), gte(massDispatchRecipients.startedAt, zonedDayStart(now, d.timeZone))))
    if ((today?.n ?? 0) >= d.dailyLimit) {
      if (d.status !== 'paused') {
        await deps.db.update(massDispatches).set({ status: 'paused', updatedAt: now }).where(eq(massDispatches.id, d.id))
        await publishUpdate(deps, d.id, true)
      }
      return again(deps, tick, nextDayWindowStart(now, w).getTime() - now.getTime(), { action: 'waiting', reason: 'daily_limit' })
    }
  }

  // Conexão do alvo caída: pausa só este alvo e confere de novo depois.
  let connected = false
  if (target.sessionId) {
    try {
      connected = (CONNECTED_STATES as readonly string[]).includes((await deps.wa.sessions.get(target.sessionId)).status)
    } catch {
      connected = false
    }
  }
  if (!connected) return again(deps, tick, deps.pausedRecheckMs ?? 60_000, { action: 'waiting', reason: 'target_paused' })

  const [recipient] = await deps.db
    .select()
    .from(massDispatchRecipients)
    .where(and(eq(massDispatchRecipients.dispatchId, d.id), eq(massDispatchRecipients.targetId, target.id), eq(massDispatchRecipients.status, 'pending')))
    .orderBy(asc(massDispatchRecipients.createdAt), asc(massDispatchRecipients.id))
    .limit(1)
  if (!recipient) return finishTarget(deps, d)

  if (d.status !== 'running') {
    await deps.db
      .update(massDispatches)
      .set({ status: 'running', updatedAt: now, ...(d.firstSentAt ? {} : { firstSentAt: now }) })
      .where(eq(massDispatches.id, d.id))
    await publishUpdate(deps, d.id, true)
  }

  const starter =
    deps.starter ??
    flowEngineStarter({ db: deps.db, wa: deps.wa as WaGateway, control: deps.control ?? new FlowControl({ db: deps.db }) })
  const flowId = recipient.variant === 'b' && d.flowBId ? d.flowBId : target.flowId
  const res = await starter.start({
    companyId: d.companyId,
    dispatchId: d.id,
    recipientId: recipient.id,
    contactId: recipient.contactId,
    connectionId: target.connectionId,
    flowId,
  })
  const at = nowOf(deps)
  const next = intervalMs(d.intervalMinSeconds, d.intervalMaxSeconds, deps.rng)

  if (res.ok) {
    await deps.db
      .update(massDispatchRecipients)
      .set({ status: 'started', startedAt: at, flowRunId: res.runId, error: null, updatedAt: at })
      .where(eq(massDispatchRecipients.id, recipient.id))
    await deps.db.update(massDispatches).set({ lastSentAt: at, updatedAt: at }).where(eq(massDispatches.id, d.id))
    await publishUpdate(deps, d.id, false)
    return again(deps, tick, next, { action: 'started', recipient_id: recipient.id, run_id: res.runId })
  }
  if (res.code === 'RATE_LIMIT' || res.code === 'WARMUP_LIMIT')
    return again(deps, tick, deps.retryDelayMs ?? 60_000, { action: 'rescheduled', reason: res.code === 'RATE_LIMIT' ? 'rate_limit' : 'warmup_limit', recipient_id: recipient.id })
  if (res.code === 'SESSION_NOT_CONNECTED') return again(deps, tick, deps.pausedRecheckMs ?? 60_000, { action: 'waiting', reason: 'target_paused', recipient_id: recipient.id })
  const skipped = res.code === 'CONTACT_NOT_ALLOWED'
  await deps.db
    .update(massDispatchRecipients)
    .set(skipped ? { status: 'skipped', skipReason: 'contact_not_allowed', updatedAt: at } : { status: 'failed', error: res.message.slice(0, 500), flowRunId: res.runId ?? null, updatedAt: at })
    .where(eq(massDispatchRecipients.id, recipient.id))
  await publishUpdate(deps, d.id, false)
  return again(deps, tick, next, { action: skipped ? 'skipped' : 'failed', recipient_id: recipient.id, run_id: res.runId ?? null })
}

/** Alvo sem pendentes: se o disparo inteiro acabou, conclui. */
async function finishTarget(deps: MassDispatchRunnerDeps, d: DispatchRow): Promise<TickResult> {
  const c = await counts(deps.db, d.id)
  if (c.pending === 0) {
    const at = nowOf(deps)
    const done = await deps.db
      .update(massDispatches)
      .set({ status: 'completed', finishedAt: at, updatedAt: at })
      .where(and(eq(massDispatches.id, d.id), inArray(massDispatches.status, [...RUNNABLE])))
      .returning({ id: massDispatches.id })
    if (done.length) await publishUpdate(deps, d.id, true)
  }
  return { action: 'completed', reason: 'no_pending' }
}

/** Variante A/B do contato (mesmo hash que a T60 usa no banco: `hashtext(id) & 1`). */
export async function variantForContact(db: Database, contactId: string): Promise<'a' | 'b'> {
  const res = await db.execute(sql`select (hashtext(${contactId}::uuid::text) & 1) = 1 as b`)
  return (res.rows[0] as { b: boolean }).b ? 'b' : 'a'
}
