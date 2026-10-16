// Disparos em massa (T60): criação com público resolvido na hora (manifesto `ids | all_except + filtros`, mesma
// semântica da listagem de contatos), cota mensal por empresa e cancelamento com devolução da cota. Sem exigência
// de consentimento prévio (SPEC 1.4 nº 3): só o opt-out bloqueia (destinatário `skipped`). O agendamento e o envio
// (fluxo por destinatário, pelo WaGateway/SendPipeline) são da T74.
import { and, asc, count, desc, eq, inArray, sql } from 'drizzle-orm'
import {
  companies,
  connections,
  flows,
  massDispatchQuotaBonuses,
  massDispatchRecipients,
  massDispatchSettings,
  massDispatchTargets,
  massDispatches,
  DEFAULT_MASS_DISPATCH_PER_CONNECTION_LIMIT,
  type Database,
  type MassDispatchStatus,
} from '@crm/db'
import { buildPageMeta, type PageMeta } from '@crm/shared'
import { CONNECTED_STATES, type WaGateway } from '@crm/wa-port'
import { SelectionError, parseSelection, selectionToJson, selectionWhere, type ContactSelection } from '../contacts-bulk/filters'
import { MassDispatchError, fieldError, parseSchedule, quotaPeriod, warmupCapacity, type ScheduleInput } from './rules'

type Tx = Parameters<Parameters<Database['transaction']>[0]>[0]
type Executor = Database | Tx
type DispatchRow = typeof massDispatches.$inferSelect

/** Estados em que ainda dá para cancelar (10 §4). */
export const CANCELLABLE_STATUSES: readonly MassDispatchStatus[] = ['preparing', 'scheduled', 'running', 'paused']
/** Destinatários que consomem cota. */
const CONSUMING = ['pending', 'started', 'failed'] as const
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Jobs da preparação/envio (fila `mass-dispatch`, T74). */
export interface MassDispatchJobs {
  enqueuePrepare(dispatchId: string): Promise<void>
  /** Remove os jobs pendentes do disparo. */
  cancel(dispatchId: string): Promise<void>
}

export interface MassDispatchActor {
  companyId: string
  userId: string | null
}

export interface QuotaDto {
  limit: number
  used: number
  remaining: number
  bonus: number
  billable_slots: number
  per_instance_limit: number
  period: string
}

export interface TargetInput {
  connection_id?: unknown
  flow_id?: unknown
}

export interface CreateMassDispatchInput extends ScheduleInput {
  name?: unknown
  targets?: TargetInput[]
  flow_b_id?: unknown
  manifest?: unknown
}

export interface Warning {
  code: 'only_first_n' | 'daily_limit_exceeds_warmup'
  message: string
  [key: string]: unknown
}

export interface MassDispatchTargetDto {
  id: string
  connection_id: string
  connection_name: string | null
  flow_id: string
  flow_name: string | null
  assigned_count: number
  sent_count: number
  failed_count: number
}

export interface MassDispatchDto {
  id: string
  name: string | null
  status: MassDispatchStatus
  targets: MassDispatchTargetDto[]
  connection_id: string | null
  connection_name: string | null
  flow_id: string | null
  flow_name: string | null
  flow_b_id: string | null
  flow_b_name: string | null
  weekdays: number[]
  window_start: string
  window_end: string
  time_zone: string
  interval_min_seconds: number
  interval_max_seconds: number
  daily_limit: number | null
  starts_scheduling_at: string
  total_count: number
  pending_count: number
  sent_count: number
  failed_count: number
  skipped_count: number
  cancelled_count: number
  progress_percent: number
  preparation_progress: Record<string, unknown>
  preparation_error: string | null
  first_sent_at: string | null
  last_sent_at: string | null
  finished_at: string | null
  created_at: string
  created_by: string | null
}

export interface RecipientDto {
  id: string
  contact_id: string
  status: string
  variant: string
  skip_reason: string | null
  target_id: string | null
  error: string | null
  started_at: string | null
}

const iso = (d: Date | null) => (d ? d.toISOString() : null)

export interface MassDispatchServiceOptions {
  db: Database
  waGateway?: Pick<WaGateway, 'sessions'>
  jobs?: MassDispatchJobs
  now?: () => Date
}

// ---------------------------------------------------------------- cota (também usada pelo admin, T95)

export async function massDispatchPerConnectionLimit(db: Executor): Promise<number> {
  const [row] = await db.select({ v: massDispatchSettings.perConnectionLimit }).from(massDispatchSettings).where(eq(massDispatchSettings.id, 1))
  return row?.v ?? DEFAULT_MASS_DISPATCH_PER_CONNECTION_LIMIT
}

export async function setMassDispatchPerConnectionLimit(db: Database, limit: number): Promise<number> {
  if (!Number.isInteger(limit) || limit < 0) throw fieldError('per_connection_limit', 'Use um inteiro ≥ 0')
  await db
    .insert(massDispatchSettings)
    .values({ id: 1, perConnectionLimit: limit })
    .onConflictDoUpdate({ target: massDispatchSettings.id, set: { perConnectionLimit: limit, updatedAt: new Date() } })
  return limit
}

async function companyTimeZone(db: Executor, companyId: string): Promise<string> {
  const [c] = await db.select({ tz: companies.timeZone }).from(companies).where(eq(companies.id, companyId))
  return c?.tz ?? 'America/Sao_Paulo'
}

/** Soma `delta` ao bônus do período atual da empresa (pode ser negativo: reduz a cota; o limite nunca fica abaixo de 0). */
export async function addMassDispatchBonus(db: Database, companyId: string, delta: number, now = new Date()): Promise<number> {
  if (!Number.isInteger(delta)) throw fieldError('bonus_delta', 'Use um inteiro')
  const period = quotaPeriod(now, await companyTimeZone(db, companyId))
  const [row] = await db
    .insert(massDispatchQuotaBonuses)
    .values({ companyId, period, bonus: delta })
    .onConflictDoUpdate({
      target: [massDispatchQuotaBonuses.companyId, massDispatchQuotaBonuses.period],
      set: { bonus: sql`${massDispatchQuotaBonuses.bonus} + ${delta}`, updatedAt: new Date() },
    })
    .returning({ bonus: massDispatchQuotaBonuses.bonus })
  return row!.bonus
}

export async function massDispatchQuota(db: Executor, companyId: string, now = new Date()): Promise<QuotaDto> {
  const period = quotaPeriod(now, await companyTimeZone(db, companyId))
  const [slots] = await db.select({ n: count() }).from(connections).where(eq(connections.companyId, companyId))
  const perInstance = await massDispatchPerConnectionLimit(db)
  const [b] = await db
    .select({ bonus: massDispatchQuotaBonuses.bonus })
    .from(massDispatchQuotaBonuses)
    .where(and(eq(massDispatchQuotaBonuses.companyId, companyId), eq(massDispatchQuotaBonuses.period, period)))
  const [u] = await db
    .select({ n: count() })
    .from(massDispatchRecipients)
    .innerJoin(massDispatches, eq(massDispatches.id, massDispatchRecipients.dispatchId))
    .where(and(eq(massDispatches.companyId, companyId), eq(massDispatches.quotaPeriod, period), inArray(massDispatchRecipients.status, [...CONSUMING])))
  const bonus = b?.bonus ?? 0
  const limit = Math.max(0, (slots?.n ?? 0) * perInstance + bonus)
  const used = u?.n ?? 0
  return { limit, used, remaining: Math.max(0, limit - used), bonus, billable_slots: slots?.n ?? 0, per_instance_limit: perInstance, period }
}

// ---------------------------------------------------------------- serviço

export class MassDispatchService {
  private readonly db: Database
  private readonly now: () => Date

  constructor(private readonly opts: MassDispatchServiceOptions) {
    this.db = opts.db
    this.now = opts.now ?? (() => new Date())
  }

  quota(companyId: string): Promise<QuotaDto> {
    return massDispatchQuota(this.db, companyId, this.now())
  }

  async create(actor: MassDispatchActor, input: CreateMassDispatchInput): Promise<{ massDispatch: MassDispatchDto; warnings: Warning[] }> {
    const now = this.now()
    const { companyId } = actor
    const tz = await companyTimeZone(this.db, companyId)
    const schedule = parseSchedule(input, { timeZone: tz, now })
    const name = input.name === undefined || input.name === null ? null : String(input.name).trim().slice(0, 200) || null
    let selection: ContactSelection
    if (!input.manifest || typeof input.manifest !== 'object' || Array.isArray(input.manifest)) throw fieldError('manifest', 'Envie o manifesto do público')
    const manifest = input.manifest as Record<string, unknown>
    if (manifest.version !== undefined && manifest.version !== 1) throw fieldError('manifest.version', 'Versão do manifesto suportada: 1')
    try {
      selection = parseSelection({ ...manifest, mode: manifest.mode ?? 'ids' }, ['ids', 'all_except'])
    } catch (err) {
      if (err instanceof SelectionError) throw fieldError(`manifest.${err.path}`, err.message)
      throw err
    }

    const targets = await this.validateTargets(companyId, input.targets ?? [])
    const flowBId = input.flow_b_id === undefined || input.flow_b_id === null || input.flow_b_id === '' ? null : String(input.flow_b_id)
    if (flowBId) await this.assertFlow(companyId, flowBId, 'flow_b_id')

    const warnings: Warning[] = []
    if (schedule.dailyLimit !== null) {
      let capacity: number | null = 0
      for (const t of new Map(targets.map((x) => [x.connectionId, x])).values()) {
        const c = warmupCapacity(t.warmupStartedAt, now)
        capacity = capacity === null || c === null ? null : capacity + c
      }
      if (capacity !== null && schedule.dailyLimit > capacity)
        warnings.push({
          code: 'daily_limit_exceeds_warmup',
          message: `O limite diário (${schedule.dailyLimit}) passa da capacidade de aquecimento das conexões hoje (${capacity}); os envios além dela serão adiados`,
          daily_limit: schedule.dailyLimit,
          capacity,
        })
    }

    const where = selectionWhere(companyId, selection)
    const result = await this.db.transaction(async (tx) => {
      // Uma criação por vez por empresa: a cota restante não pode ser usada duas vezes.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`mass_dispatch:${companyId}`}))`)
      const quota = await massDispatchQuota(tx, companyId, now)
      if (quota.remaining <= 0) throw new MassDispatchError('quota_exceeded', 'Cota mensal de disparos esgotada', { quota })

      const [eligible] = (
        await tx.execute(sql`select count(*)::int as n from crm.contacts where ${where} and not crm.contacts.opt_out and crm.contacts.phone_e164 is not null`)
      ).rows as [{ n: number }]
      const [skippable] = (
        await tx.execute(sql`select count(*)::int as n from crm.contacts where ${where} and (crm.contacts.opt_out or crm.contacts.phone_e164 is null)`)
      ).rows as [{ n: number }]
      if (eligible.n + skippable.n === 0) throw fieldError('manifest', 'Selecione ao menos um contato')

      const [row] = await tx
        .insert(massDispatches)
        .values({
          companyId,
          name,
          status: 'preparing',
          flowBId,
          weekdays: schedule.weekdays,
          windowStart: schedule.windowStart,
          windowEnd: schedule.windowEnd,
          timeZone: schedule.timeZone,
          intervalMinSeconds: schedule.intervalMinSeconds,
          intervalMaxSeconds: schedule.intervalMaxSeconds,
          dailyLimit: schedule.dailyLimit,
          startsSchedulingAt: schedule.startsSchedulingAt,
          quotaPeriod: quota.period,
          manifest: selectionToJson(selection),
          createdBy: actor.userId,
        })
        .returning()
      const dispatch = row!
      const inserted = await tx
        .insert(massDispatchTargets)
        .values(targets.map((t, i) => ({ companyId, dispatchId: dispatch.id, connectionId: t.connectionId, flowId: t.flowId, position: i })))
        .returning({ id: massDispatchTargets.id })
      // Com um alvo só, o destinatário já nasce dele; com vários, a T74 distribui pela capacidade.
      const targetId = inserted.length === 1 ? inserted[0]!.id : null

      const variant = flowBId ? sql`case when (hashtext(crm.contacts.id::text) & 1) = 1 then 'b' else 'a' end` : sql`'a'`
      const take = Math.min(eligible.n, quota.remaining)
      await tx.execute(sql`
        insert into crm.mass_dispatch_recipients (company_id, dispatch_id, contact_id, status, skip_reason, variant)
        select ${companyId}, ${dispatch.id}, crm.contacts.id, 'skipped',
               case when crm.contacts.opt_out then 'opt_out' else 'no_phone' end, ${variant}
        from crm.contacts where ${where} and (crm.contacts.opt_out or crm.contacts.phone_e164 is null)`)
      if (take > 0)
        await tx.execute(sql`
          insert into crm.mass_dispatch_recipients (company_id, dispatch_id, contact_id, status, variant, target_id)
          select ${companyId}, ${dispatch.id}, crm.contacts.id, 'pending', ${variant}, ${targetId}::uuid
          from crm.contacts where ${where} and not crm.contacts.opt_out and crm.contacts.phone_e164 is not null
          order by crm.contacts.created_at asc, crm.contacts.id asc
          limit ${take}`)
      await tx
        .update(massDispatches)
        .set({ preparationProgress: { phase: 'queued', scheduled_count: 0, target_count: take } })
        .where(eq(massDispatches.id, dispatch.id))
      if (take < eligible.n)
        warnings.unshift({
          code: 'only_first_n',
          message: `A cota restante (${quota.remaining}) cobre só os ${take} primeiros contatos de ${eligible.n}`,
          n: take,
          total: eligible.n,
        })
      return dispatch.id
    })

    await this.opts.jobs?.enqueuePrepare(result)
    return { massDispatch: await this.get(companyId, result), warnings }
  }

  async cancel(companyId: string, id: string): Promise<{ massDispatch: MassDispatchDto; releasedCount: number }> {
    const released = await this.db.transaction(async (tx) => {
      const row = await this.row(tx, companyId, id, true)
      if (!CANCELLABLE_STATUSES.includes(row.status)) throw new MassDispatchError('invalid_transition', `Disparo ${row.status} não pode ser cancelado`, { status: row.status })
      const gone = await tx
        .update(massDispatchRecipients)
        .set({ status: 'cancelled', updatedAt: this.now() })
        .where(and(eq(massDispatchRecipients.dispatchId, id), eq(massDispatchRecipients.status, 'pending')))
        .returning({ id: massDispatchRecipients.id })
      await tx.update(massDispatches).set({ status: 'cancelled', finishedAt: this.now(), updatedAt: this.now() }).where(eq(massDispatches.id, id))
      return gone.length
    })
    await this.opts.jobs?.cancel(id)
    return { massDispatch: await this.get(companyId, id), releasedCount: released }
  }

  async get(companyId: string, id: string): Promise<MassDispatchDto> {
    const row = await this.row(this.db, companyId, id)
    return (await this.hydrate([row]))[0]!
  }

  async list(companyId: string, q: { page: number; limit: number }): Promise<{ items: MassDispatchDto[]; page: PageMeta }> {
    const rows = await this.db
      .select()
      .from(massDispatches)
      .where(eq(massDispatches.companyId, companyId))
      .orderBy(desc(massDispatches.createdAt), desc(massDispatches.id))
      .limit(q.limit)
      .offset((q.page - 1) * q.limit)
    const [t] = await this.db.select({ n: count() }).from(massDispatches).where(eq(massDispatches.companyId, companyId))
    return { items: await this.hydrate(rows), page: buildPageMeta(q, { total: t?.n ?? 0 }) }
  }

  async recipients(companyId: string, id: string, q: { page: number; limit: number; status?: string }): Promise<{ items: RecipientDto[]; page: PageMeta }> {
    await this.row(this.db, companyId, id)
    const where = q.status
      ? and(eq(massDispatchRecipients.dispatchId, id), eq(massDispatchRecipients.status, q.status as never))
      : eq(massDispatchRecipients.dispatchId, id)
    const rows = await this.db
      .select()
      .from(massDispatchRecipients)
      .where(where)
      .orderBy(asc(massDispatchRecipients.createdAt), asc(massDispatchRecipients.id))
      .limit(q.limit)
      .offset((q.page - 1) * q.limit)
    const [t] = await this.db.select({ n: count() }).from(massDispatchRecipients).where(where)
    return {
      items: rows.map((r) => ({
        id: r.id,
        contact_id: r.contactId,
        status: r.status,
        variant: r.variant,
        skip_reason: r.skipReason,
        target_id: r.targetId,
        error: r.error,
        started_at: iso(r.startedAt),
      })),
      page: buildPageMeta(q, { total: t?.n ?? 0 }),
    }
  }

  // ---------------------------------------------------------------- internos

  private async row(db: Executor, companyId: string, id: string, lock = false): Promise<DispatchRow> {
    if (!UUID_RE.test(id)) throw new MassDispatchError('not_found', 'Disparo não encontrado')
    const q = db.select().from(massDispatches).where(and(eq(massDispatches.companyId, companyId), eq(massDispatches.id, id)))
    const [row] = lock ? await q.for('update') : await q
    if (!row) throw new MassDispatchError('not_found', 'Disparo não encontrado')
    return row
  }

  /** Conexão da empresa e conectada (409); fluxo da empresa, ativo e publicado (422). */
  private async validateTargets(companyId: string, raw: TargetInput[]) {
    if (!raw.length) throw fieldError('targets', 'Escolha ao menos um número e um fluxo')
    const out: Array<{ connectionId: string; flowId: string; warmupStartedAt: string | null }> = []
    for (const [i, t] of raw.entries()) {
      const connectionId = String(t.connection_id ?? '').trim()
      const flowId = String(t.flow_id ?? '').trim()
      if (!UUID_RE.test(connectionId)) throw fieldError(`targets.${i}.connection_id`, 'Conexão inválida')
      if (!UUID_RE.test(flowId)) throw fieldError(`targets.${i}.flow_id`, 'Fluxo inválido')
      const [conn] = await this.db
        .select({ sessionId: connections.sessionId })
        .from(connections)
        .where(and(eq(connections.companyId, companyId), eq(connections.id, connectionId)))
      if (!conn) throw fieldError(`targets.${i}.connection_id`, 'Conexão não encontrada')
      await this.assertFlow(companyId, flowId, `targets.${i}.flow_id`)
      let state: string | null = null
      let warmupStartedAt: string | null = null
      if (conn.sessionId && this.opts.waGateway) {
        try {
          const s = await this.opts.waGateway.sessions.get(conn.sessionId)
          state = s.status
          warmupStartedAt = s.warmupStartedAt
        } catch {
          state = null
        }
      }
      if (!state || !(CONNECTED_STATES as readonly string[]).includes(state))
        throw new MassDispatchError('session_not_connected', 'A conexão do alvo não está conectada', { connection_id: connectionId, state })
      out.push({ connectionId, flowId, warmupStartedAt })
    }
    return out
  }

  private async assertFlow(companyId: string, flowId: string, path: string): Promise<void> {
    if (!UUID_RE.test(flowId)) throw fieldError(path, 'Fluxo inválido')
    const [flow] = await this.db
      .select({ status: flows.status, published: flows.publishedVersion })
      .from(flows)
      .where(and(eq(flows.companyId, companyId), eq(flows.id, flowId)))
    if (!flow) throw fieldError(path, 'Fluxo não encontrado')
    if (flow.status !== 'active' || flow.published === null) throw fieldError(path, 'O fluxo precisa estar ativo e publicado para ser disparado')
  }

  private async hydrate(rows: DispatchRow[]): Promise<MassDispatchDto[]> {
    if (!rows.length) return []
    const ids = rows.map((r) => r.id)
    const targetRows = await this.db
      .select({ target: massDispatchTargets, connectionName: connections.name, flowName: flows.name })
      .from(massDispatchTargets)
      .leftJoin(connections, eq(connections.id, massDispatchTargets.connectionId))
      .leftJoin(flows, eq(flows.id, massDispatchTargets.flowId))
      .where(inArray(massDispatchTargets.dispatchId, ids))
      .orderBy(asc(massDispatchTargets.position))
    const counts = await this.db
      .select({ dispatchId: massDispatchRecipients.dispatchId, targetId: massDispatchRecipients.targetId, status: massDispatchRecipients.status, n: count() })
      .from(massDispatchRecipients)
      .where(inArray(massDispatchRecipients.dispatchId, ids))
      .groupBy(massDispatchRecipients.dispatchId, massDispatchRecipients.targetId, massDispatchRecipients.status)
    const flowBIds = [...new Set(rows.map((r) => r.flowBId).filter((x): x is string => !!x))]
    const flowB = flowBIds.length ? new Map((await this.db.select({ id: flows.id, name: flows.name }).from(flows).where(inArray(flows.id, flowBIds))).map((f) => [f.id, f.name])) : new Map<string, string>()

    return rows.map((r) => {
      const by = (status: string, targetId?: string) =>
        counts.filter((c) => c.dispatchId === r.id && c.status === status && (targetId === undefined || c.targetId === targetId)).reduce((s, c) => s + c.n, 0)
      const targets = targetRows
        .filter((t) => t.target.dispatchId === r.id)
        .map((t) => ({
          id: t.target.id,
          connection_id: t.target.connectionId,
          connection_name: t.connectionName,
          flow_id: t.target.flowId,
          flow_name: t.flowName,
          assigned_count: by('pending', t.target.id) + by('started', t.target.id) + by('failed', t.target.id),
          sent_count: by('started', t.target.id),
          failed_count: by('failed', t.target.id),
        }))
      const pending = by('pending')
      const sent = by('started')
      const failed = by('failed')
      const total = pending + sent + failed
      return {
        id: r.id,
        name: r.name,
        status: r.status,
        targets,
        connection_id: targets[0]?.connection_id ?? null,
        connection_name: targets[0]?.connection_name ?? null,
        flow_id: targets[0]?.flow_id ?? null,
        flow_name: targets[0]?.flow_name ?? null,
        flow_b_id: r.flowBId,
        flow_b_name: r.flowBId ? (flowB.get(r.flowBId) ?? null) : null,
        weekdays: r.weekdays,
        window_start: r.windowStart,
        window_end: r.windowEnd,
        time_zone: r.timeZone,
        interval_min_seconds: r.intervalMinSeconds,
        interval_max_seconds: r.intervalMaxSeconds,
        daily_limit: r.dailyLimit,
        starts_scheduling_at: r.startsSchedulingAt.toISOString(),
        total_count: total,
        pending_count: pending,
        sent_count: sent,
        failed_count: failed,
        skipped_count: by('skipped'),
        cancelled_count: by('cancelled'),
        progress_percent: total ? Math.floor(((sent + failed) / total) * 100) : 0,
        preparation_progress: r.preparationProgress,
        preparation_error: r.preparationError,
        first_sent_at: iso(r.firstSentAt),
        last_sent_at: iso(r.lastSentAt),
        finished_at: iso(r.finishedAt),
        created_at: r.createdAt.toISOString(),
        created_by: r.createdBy,
      }
    })
  }
}
