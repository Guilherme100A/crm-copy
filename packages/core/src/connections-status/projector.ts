// Projeção dos eventos de sessão nas conexões (T47, 08-conexoes.md §4 e §7): `session.connection|state|qr|pairing_code`
// atualizam `crm.connections` e publicam os eventos `connection.*` e `flow.auto_paused` da empresa dona da conexão.
// Queda: pausa os runs `waiting` da conexão, alerta (dedupe por janela) e e-mail para owner/admin uma vez por queda.
// Volta: `connection.connected` e, havendo runs pausados pela queda, `connection.reconnected_with_paused_flows`.
// Tudo é publicado DEPOIS do commit. Não depende da ordem entre `session.state` e `session.connection` (no onOpen do
// engine o WARMING sai alguns ms antes do `open`): cada evento recalcula o status com o que já está gravado.
import { chats, companies, companyMembers, connections, flowRuns, messages, users, type Database } from '@crm/db'
import type { RealtimeEventType } from '@crm/shared'
import type { DisconnectKind, SessionState, WaEvent, WaGateway } from '@crm/wa-port'
import { and, count, countDistinct, eq, gte, inArray, sql } from 'drizzle-orm'
import { deriveConnectionStatus, type ConnectionUiStatus } from '../connections/status'
import { memoryAlertDedupe, redisAlertDedupe, type AlertDedupe, type DedupeRedis } from './dedupe'
import { disconnectEmail } from './email'

export const DEFAULT_ALERT_WINDOW_MS = 5_000

export interface ConnectionStatusPublisher {
  publish(companyId: string, type: RealtimeEventType, data: Record<string, unknown>): Promise<unknown>
}

export interface ConnectionStatusMailer {
  send(message: { to: string | string[]; subject: string; text?: string; html?: string }): Promise<unknown>
}

export interface ConnectionStatusOptions {
  db: Database
  publisher: ConnectionStatusPublisher
  /** Sem mailer, o e-mail de desconexão não sai (o resto da projeção segue). */
  mailer?: ConnectionStatusMailer
  /** Estado da sessão para o status de UI; sem ele, `open` vale conectada e `close` desconectada. */
  gateway?: Pick<WaGateway, 'sessions'>
  /** Dedupe do alerta. Default: Redis (`redis`) ou memória do processo. */
  dedupe?: AlertDedupe
  redis?: DedupeRedis
  /** Default: `APP_NAME` ou `CRM`. */
  appName?: string
  /** Base da web para o link do e-mail (`WEB_PUBLIC_URL`). */
  webUrl?: string | null
  now?: () => Date
  alertWindowMs?: number
  logger?: { warn(obj: object, msg?: string): void; error(obj: object, msg?: string): void }
}

export interface ProjectionResult {
  /** `null` = a sessão não é de nenhuma conexão do CRM (evento ignorado, AC-T47-05). */
  connectionId: string | null
  published: RealtimeEventType[]
  emailed: boolean
}

type ConnectionRow = typeof connections.$inferSelect

/** Marca gravada em `flow_runs.wait` dos runs pausados por queda da conexão. */
export const PAUSED_BY_CONNECTION = 'connection'

export class ConnectionStatusProjector {
  private readonly db: Database
  private readonly dedupe: AlertDedupe
  private readonly now: () => Date
  private readonly windowMs: number
  private readonly appName: string

  constructor(private readonly opts: ConnectionStatusOptions) {
    this.db = opts.db
    this.dedupe = opts.dedupe ?? (opts.redis ? redisAlertDedupe(opts.redis) : memoryAlertDedupe())
    this.now = opts.now ?? (() => new Date())
    this.windowMs = opts.alertWindowMs ?? DEFAULT_ALERT_WINDOW_MS
    this.appName = opts.appName ?? (process.env.APP_NAME?.trim() || 'CRM')
  }

  async handle(event: WaEvent): Promise<ProjectionResult> {
    switch (event.type) {
      case 'session.connection':
        return event.state === 'open' ? this.onOpen(event) : this.onClose(event)
      case 'session.state':
        return this.onState(event)
      case 'session.qr':
        return this.onCode(event.session_id, 'connection.qr_updated', { qr_code: event.qr })
      case 'session.pairing_code':
        return this.onCode(event.session_id, 'connection.pairing_code', { code: event.code })
      default:
        return { connectionId: null, published: [], emailed: false }
    }
  }

  // ---------------------------------------------------------------- session.connection

  private async onClose(event: Extract<WaEvent, { type: 'session.connection' }>): Promise<ProjectionResult> {
    const at = new Date(event.at)
    const reason: DisconnectKind | null = event.reason ?? null
    const tx = await this.db.transaction(async (tx) => {
      const [prev] = await tx.select().from(connections).where(eq(connections.sessionId, event.session_id)).for('update')
      if (!prev) return null
      const [row] = await tx
        .update(connections)
        .set({ connectionState: 'close', disconnectedAt: at, lastDisconnectReason: reason, lastStatusCode: event.status_code ?? null, updatedAt: this.now() })
        .where(eq(connections.id, prev.id))
        .returning()
      const paused = await this.pauseWaitingRuns(tx, row!)
      return { prev, row: row!, paused }
    })
    if (!tx) return { connectionId: null, published: [], emailed: false }
    const { prev, row, paused } = tx
    const out: ProjectionResult = { connectionId: row.id, published: [], emailed: false }
    const status = await this.statusOf(row)
    const drop = {
      ...this.base(row),
      name: row.name,
      phone_number: row.phoneNumber,
      reason,
      status_code: event.status_code ?? null,
      status: status.status,
      disconnected_at: at.toISOString(),
    }
    await this.publish(row, out, 'connection.updated', this.base(row))
    await this.publish(row, out, 'connection.status_changed', { ...this.base(row), ...status })
    await this.publish(row, out, 'connection.disconnected', drop)
    const alert = reason === 'forbidden' ? 'connection.banned_alert' : 'connection.disconnected_alert'
    if (await this.dedupe.claim(`${row.id}:${alert}`, this.now().getTime(), this.windowMs)) await this.publish(row, out, alert, drop)
    if (paused.length)
      await this.publish(row, out, 'flow.auto_paused', {
        ...this.base(row),
        paused_count: paused.length,
        run_ids: paused.map((r) => r.id),
        flow_ids: [...new Set(paused.map((r) => r.flowId))],
      })
    // Uma vez por queda: só a transição open → close (lida com a linha travada) manda e-mail.
    if (prev.connectionState === 'open') out.emailed = await this.sendDisconnectEmail(row, reason, at)
    return out
  }

  private async onOpen(event: Extract<WaEvent, { type: 'session.connection' }>): Promise<ProjectionResult> {
    const at = new Date(event.at)
    const tx = await this.db.transaction(async (tx) => {
      const [prev] = await tx.select().from(connections).where(eq(connections.sessionId, event.session_id)).for('update')
      if (!prev) return null
      const [row] = await tx
        .update(connections)
        .set({ connectionState: 'open', connectedAt: at, lastDisconnectReason: null, lastStatusCode: null, updatedAt: this.now() })
        .where(eq(connections.id, prev.id))
        .returning()
      return { prev, row: row! }
    })
    if (!tx) return { connectionId: null, published: [], emailed: false }
    const { prev, row } = tx
    const out: ProjectionResult = { connectionId: row.id, published: [], emailed: false }
    await this.publish(row, out, 'connection.updated', this.base(row))
    await this.publish(row, out, 'connection.status_changed', { ...this.base(row), ...(await this.statusOf(row)) })
    if (prev.connectionState === 'open') return out
    await this.publish(row, out, 'connection.connected', { ...this.base(row), name: row.name, phone_number: row.phoneNumber, connected_at: at.toISOString() })
    const counts = await this.pausedFlowCounts(row, prev.disconnectedAt)
    if (counts.paused_count > 0) await this.publish(row, out, 'connection.reconnected_with_paused_flows', { ...this.base(row), name: row.name, ...counts })
    return out
  }

  // ---------------------------------------------------------------- session.state / qr / pairing_code

  private async onState(event: Extract<WaEvent, { type: 'session.state' }>): Promise<ProjectionResult> {
    const row = await this.connectionOf(event.session_id)
    if (!row) return { connectionId: null, published: [], emailed: false }
    const out: ProjectionResult = { connectionId: row.id, published: [], emailed: false }
    await this.publish(row, out, 'connection.status_changed', { ...this.base(row), ...(await this.statusOf(row, event.to)) })
    if (event.to === 'DEGRADED' && event.from !== 'DEGRADED') await this.publish(row, out, 'connection.health_degraded', { ...this.base(row), from: event.from ?? 'NEW', to: event.to })
    return out
  }

  private async onCode(sessionId: string, type: 'connection.qr_updated' | 'connection.pairing_code', data: Record<string, string>): Promise<ProjectionResult> {
    const [row] = await this.db
      .update(connections)
      .set({ qrRequestedAt: sql`coalesce(${connections.qrRequestedAt}, now())`, updatedAt: this.now() })
      .where(eq(connections.sessionId, sessionId))
      .returning()
    if (!row) return { connectionId: null, published: [], emailed: false }
    const out: ProjectionResult = { connectionId: row.id, published: [], emailed: false }
    await this.publish(row, out, type, { ...this.base(row), ...data })
    return out
  }

  // ---------------------------------------------------------------- runs de fluxo

  /** Runs `waiting` cujo chat é desta conexão → `paused` (o timer pendente vira no-op: o advance ignora run pausado). */
  private async pauseWaitingRuns(tx: Parameters<Parameters<Database['transaction']>[0]>[0], row: ConnectionRow): Promise<Array<{ id: string; flowId: string }>> {
    const now = this.now()
    const res = await tx.execute<{ id: string; flow_id: string }>(sql`
      update ${flowRuns} r
      set status = 'paused',
          wait = coalesce(r.wait, '{}'::jsonb) || jsonb_build_object(
            'paused_by', ${PAUSED_BY_CONNECTION}::text,
            'connection_id', ${row.id}::text,
            'paused_at', ${now.toISOString()}::text,
            'remaining_ms', case when r.wait->>'deadline_at' is null then null
              else greatest(0, floor(extract(epoch from ((r.wait->>'deadline_at')::timestamptz - ${now.toISOString()}::timestamptz)) * 1000))::bigint end),
          updated_at = now()
      from ${chats} c
      where c.id = r.chat_id and c.connection_id = ${row.id} and c.company_id = ${row.companyId}
        and r.company_id = ${row.companyId} and r.status = 'waiting'
      returning r.id, r.flow_id`)
    return res.rows.map((r) => ({ id: r.id, flowId: r.flow_id }))
  }

  /** Contagens do modal "fluxos pausados na queda" (08 §5.13). */
  private async pausedFlowCounts(row: ConnectionRow, since: Date | null) {
    const pausedHere = and(
      eq(flowRuns.companyId, row.companyId),
      eq(flowRuns.status, 'paused'),
      sql`${flowRuns.wait}->>'paused_by' = ${PAUSED_BY_CONNECTION}`,
      sql`${flowRuns.wait}->>'connection_id' = ${row.id}`,
    )
    const [paused] = await this.db.select({ n: count(), leads: countDistinct(flowRuns.contactId) }).from(flowRuns).where(pausedHere)
    const chatsHere = this.db.select({ id: chats.id }).from(chats).where(and(eq(chats.companyId, row.companyId), eq(chats.connectionId, row.id)))
    const [waiting] = await this.db
      .select({ n: count() })
      .from(flowRuns)
      .where(and(eq(flowRuns.companyId, row.companyId), eq(flowRuns.status, 'waiting'), inArray(flowRuns.chatId, chatsHere)))
    const [failed] = since
      ? await this.db
          .select({ n: count() })
          .from(flowRuns)
          .where(and(eq(flowRuns.companyId, row.companyId), eq(flowRuns.status, 'failed'), gte(flowRuns.updatedAt, since), inArray(flowRuns.chatId, chatsHere)))
      : [{ n: 0 }]
    const [received] = since
      ? await this.db
          .select({ n: count() })
          .from(messages)
          .where(and(eq(messages.companyId, row.companyId), eq(messages.direction, 'inbound'), gte(messages.createdAt, since), inArray(messages.chatId, chatsHere)))
      : [{ n: 0 }]
    return {
      paused_count: Number(paused?.n ?? 0),
      waiting_count: Number(waiting?.n ?? 0),
      failed_count: Number(failed?.n ?? 0),
      received_count: Number(received?.n ?? 0),
      total_leads: Number(paused?.leads ?? 0),
    }
  }

  // ---------------------------------------------------------------- e-mail

  private async sendDisconnectEmail(row: ConnectionRow, reason: DisconnectKind | null, at: Date): Promise<boolean> {
    if (!this.opts.mailer) return false
    try {
      const [company] = await this.db.select({ name: companies.name, settings: companies.settings }).from(companies).where(eq(companies.id, row.companyId))
      if (!company || company.settings?.connection_status_emails_enabled === false) return false
      const to = (
        await this.db
          .select({ email: users.email })
          .from(companyMembers)
          .innerJoin(users, eq(users.id, companyMembers.userId))
          .where(and(eq(companyMembers.companyId, row.companyId), inArray(companyMembers.role, ['owner', 'admin'])))
      ).map((r) => r.email)
      if (!to.length) return false
      const web = this.opts.webUrl ?? process.env.WEB_PUBLIC_URL ?? null
      const mail = disconnectEmail({
        appName: this.appName,
        companyName: company.name,
        connectionName: row.name,
        phoneNumber: row.phoneNumber,
        reason,
        disconnectedAt: at,
        connectionsUrl: web ? `${web.replace(/\/+$/, '')}/connections` : null,
      })
      await this.opts.mailer.send({ to: [...new Set(to)], ...mail })
      return true
    } catch (err) {
      this.opts.logger?.error({ err, connectionId: row.id }, 'conexões: falha ao enviar o e-mail de desconexão')
      return false
    }
  }

  // ---------------------------------------------------------------- internos

  private async connectionOf(sessionId: string): Promise<ConnectionRow | undefined> {
    const [row] = await this.db.select().from(connections).where(eq(connections.sessionId, sessionId))
    return row
  }

  private base(row: ConnectionRow) {
    return { connection_id: row.id, session_id: row.sessionId }
  }

  /** Status de UI (T40). `loggedOut` é sempre `disconnected`; `forbidden` vira `banned` pela regra do T40. */
  private async statusOf(row: ConnectionRow, sessionState?: SessionState) {
    const connectionState = (row.connectionState as 'open' | 'close' | null) ?? null
    let state: SessionState | null = sessionState ?? null
    if (sessionState === undefined) {
      const live = this.opts.gateway ? await this.opts.gateway.sessions.get(row.sessionId).catch(() => null) : undefined
      state = live === undefined ? (connectionState === 'close' ? 'DISCONNECTED' : 'STABLE') : (live?.status ?? null)
    }
    const view = deriveConnectionStatus({
      sessionState: state,
      connectionState,
      lastDisconnectReason: (row.lastDisconnectReason as DisconnectKind | null) ?? null,
      qrRequested: row.qrRequestedAt !== null,
      requiresRestart: row.requiresRestart,
      scheduledForDeletion: row.scheduledForDeletionAt !== null,
    })
    let status: ConnectionUiStatus = view.status
    if (connectionState === 'close' && row.lastDisconnectReason === 'loggedOut') status = 'disconnected'
    return { status, session_state: state, connection_state: connectionState, badges: view.badges }
  }

  private async publish(row: ConnectionRow, out: ProjectionResult, type: RealtimeEventType, data: Record<string, unknown>): Promise<void> {
    try {
      await this.opts.publisher.publish(row.companyId, type, data)
      out.published.push(type)
    } catch (err) {
      this.opts.logger?.warn({ err, connectionId: row.id, type }, 'conexões: falha ao publicar evento')
    }
  }
}
