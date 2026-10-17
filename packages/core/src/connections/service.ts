// Conexões WhatsApp da empresa (T40) sobre o `WaGateway` (SPEC 3.8). Toda leitura/escrita filtra pela empresa
// (cross-tenant → not_found). O gateway é a fonte do estado da sessão; `crm.connections` guarda o vínculo, as
// preferências e o último `session.connection` (projetado pela T47 via `applyConnectionEvent`).
import { companies, connections, EPHEMERAL_DURATIONS, PROXY_PROTOCOLS, type Database, type EphemeralDuration } from '@crm/db'
import { getCredentialsCipher, serializeEncrypted, type CredentialCipher } from '@crm/node-kit'
import { isSendRejectedError, type DisconnectKind, type SessionState, type SessionView, type WaEvent, type WaGateway } from '@crm/wa-port'
import { and, asc, eq, ilike, or, sql } from 'drizzle-orm'
import { pausedFlowCountsByConnection } from '../connections-status/paused-flows'
import { ConnectionsError } from './errors'
import { CONNECTION_UI_STATUSES, deriveConnectionStatus, type ConnectionBadge, type ConnectionUiStatus } from './status'

export type ConnectionRow = typeof connections.$inferSelect

export const PAIRING_PHONE_RE = /^[1-9]\d{6,14}$/

export interface ConnectionProxyView {
  protocol: string
  host: string
  port: number
  username: string | null
  has_password: boolean
}

export interface ConnectionView {
  id: string
  name: string
  session_id: string
  phone_number: string | null
  status: ConnectionUiStatus
  session_state: SessionState | null
  badges: ConnectionBadge[]
  connection_state: 'open' | 'close' | null
  last_disconnect_reason: DisconnectKind | null
  disconnected_at: string | null
  connected_at: string | null
  notify_sent_by_me: boolean
  ephemeral_duration: EphemeralDuration
  save_contacts_enabled: boolean
  scheduled_for_deletion_at: string | null
  requires_restart: boolean
  proxy: ConnectionProxyView | null
  created_at: string
  updated_at: string
}

/** Item da lista: a conexão e quantos runs a queda dela deixou pausados (modal Retomar/Cancelar, T71). */
export interface ConnectionListItem extends ConnectionView {
  paused_flows_count: number
}

/** Limite de conexões da empresa (T95; `connections: null` = sem limite) e o uso (sem as agendadas para exclusão). */
export interface ConnectionLimits {
  connections: number | null
  used: number
}

export interface ListConnectionsQuery {
  search?: string
  status?: ConnectionUiStatus
  page?: number
  limit?: number
}

export interface ConnectionsServiceOptions {
  db: Database
  gateway: WaGateway
  /** Cifrador da senha do proxy. Default: o de `CREDENTIALS_KEY` (`@crm/node-kit`). */
  cipher?: Pick<CredentialCipher, 'encrypt'>
  now?: () => Date
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const iso = (d: Date | null) => (d ? d.toISOString() : null)
const validation = (path: string, message: string) => new ConnectionsError('validation', message, { fields: [{ path, message }] })

function gatewayError(err: unknown): unknown {
  if (err instanceof ConnectionsError) return err
  const e = err as { code?: unknown; message?: unknown }
  if (e?.code === 'INVALID_TRANSITION') return new ConnectionsError('invalid_transition', 'Ação indisponível no estado atual da conexão')
  if (e?.code === 'SESSION_NOT_FOUND') return new ConnectionsError('not_found', 'Sessão da conexão não encontrada no gateway')
  if (e?.code === 'VALIDATION_ERROR') return new ConnectionsError('validation', String(e.message ?? 'Dados inválidos'))
  if (isSendRejectedError(err)) return new ConnectionsError('upstream', err.message)
  return err
}

async function viaGateway<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (err) {
    throw gatewayError(err)
  }
}

export class ConnectionsService {
  private readonly db: Database
  private readonly gateway: WaGateway
  private readonly now: () => Date

  constructor(private readonly opts: ConnectionsServiceOptions) {
    this.db = opts.db
    this.gateway = opts.gateway
    this.now = opts.now ?? (() => new Date())
  }

  // ---------------------------------------------------------------- leitura

  async list(companyId: string, q: ListConnectionsQuery = {}) {
    const where = [eq(connections.companyId, companyId)]
    const search = q.search?.trim()
    if (search) where.push(or(ilike(connections.name, `%${search}%`), ilike(connections.phoneNumber, `%${search}%`))!)
    const rows = await this.db
      .select()
      .from(connections)
      .where(and(...where))
      .orderBy(asc(connections.createdAt))
    const states = await this.sessionStates()
    const views = rows.map((r) => this.toView(r, states.get(r.sessionId) ?? null))
    const status_counts = Object.fromEntries(CONNECTION_UI_STATUSES.map((s) => [s, 0])) as Record<ConnectionUiStatus, number>
    for (const v of views) status_counts[v.status]++
    const filtered = q.status ? views.filter((v) => v.status === q.status) : views
    const limit = Math.min(Math.max(q.limit ?? 20, 1), 100)
    const page = Math.max(q.page ?? 1, 1)
    const total = filtered.length
    const paused = await pausedFlowCountsByConnection(this.db, companyId)
    const items: ConnectionListItem[] = filtered.slice((page - 1) * limit, page * limit).map((v) => ({ ...v, paused_flows_count: paused.get(v.id) ?? 0 }))
    return {
      items,
      page: { page, limit, total_count: total, total_pages: Math.ceil(total / limit), has_more: page * limit < total },
      status_counts,
      limits: await this.limits(companyId),
    }
  }

  /** Limite definido pelo admin da plataforma (`companies.settings.limits.connections`) e o uso atual. */
  async limits(companyId: string): Promise<ConnectionLimits> {
    const [c] = await this.db.select({ settings: companies.settings }).from(companies).where(eq(companies.id, companyId))
    const raw = ((c?.settings as { limits?: { connections?: unknown } } | undefined)?.limits ?? {}).connections
    const max = raw === undefined || raw === null || !Number.isFinite(Number(raw)) ? null : Number(raw)
    const [{ n } = { n: 0 }] = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(connections)
      .where(and(eq(connections.companyId, companyId), sql`${connections.scheduledForDeletionAt} is null`))
    return { connections: max, used: n }
  }

  async get(companyId: string, id: string): Promise<ConnectionView> {
    const row = await this.require(companyId, id)
    return this.toView(row, await this.sessionState(row.sessionId))
  }

  // ---------------------------------------------------------------- escrita

  /** Cria a sessão no gateway e o vínculo. Limite opcional em `companies.settings.limits.connections`. */
  async create(companyId: string, input: { name?: unknown; phone?: unknown }, actorUserId: string | null): Promise<ConnectionView> {
    const name = this.validName(input.name)
    const phone = input.phone === undefined || input.phone === null || input.phone === '' ? undefined : this.validPhone(input.phone)
    await this.assertBelowLimit(companyId)
    const session = await viaGateway(() => this.gateway.sessions.create({ name, ...(phone ? { phone: `+${phone}` } : {}) }))
    try {
      const [row] = await this.db
        .insert(connections)
        .values({ companyId, sessionId: session.id, name, phoneNumber: phone ? `+${phone}` : session.phone, createdByUserId: actorUserId })
        .returning()
      return this.toView(row!, session.status)
    } catch (err) {
      await this.gateway.sessions.remove(session.id).catch(() => undefined)
      throw err
    }
  }

  async update(companyId: string, id: string, input: { name?: unknown; notify_sent_by_me?: unknown }): Promise<ConnectionView> {
    await this.require(companyId, id)
    const set: Partial<typeof connections.$inferInsert> = { updatedAt: this.now() }
    if (input.name !== undefined) set.name = this.validName(input.name)
    if (input.notify_sent_by_me !== undefined) set.notifySentByMe = this.bool(input.notify_sent_by_me, 'notify_sent_by_me')
    return this.patch(companyId, id, set)
  }

  async instanceSettings(companyId: string, id: string, input: { ephemeral_duration?: unknown; save_contacts_enabled?: unknown; notify_sent_by_me?: unknown }) {
    await this.require(companyId, id)
    const set: Partial<typeof connections.$inferInsert> = { updatedAt: this.now() }
    if (input.ephemeral_duration !== undefined) {
      if (!(EPHEMERAL_DURATIONS as readonly unknown[]).includes(input.ephemeral_duration)) throw validation('ephemeral_duration', 'Use off, 1d, 7d ou 90d')
      set.ephemeralDuration = input.ephemeral_duration as EphemeralDuration
    }
    if (input.save_contacts_enabled !== undefined) set.saveContactsEnabled = this.bool(input.save_contacts_enabled, 'save_contacts_enabled')
    if (input.notify_sent_by_me !== undefined) set.notifySentByMe = this.bool(input.notify_sent_by_me, 'notify_sent_by_me')
    return this.patch(companyId, id, set)
  }

  /** Conectar/reconectar: sessão pausada → resume; senão gera QR. */
  async connect(companyId: string, id: string): Promise<ConnectionView> {
    const row = await this.require(companyId, id)
    const state = await this.sessionState(row.sessionId)
    if (state === 'PAUSED') await viaGateway(() => this.gateway.sessions.resume(row.sessionId))
    else await viaGateway(() => this.gateway.sessions.startQr(row.sessionId))
    return this.patch(companyId, id, { qrRequestedAt: this.now(), updatedAt: this.now() })
  }

  /** Desconectar = desvincular o aparelho (logout). */
  async disconnect(companyId: string, id: string): Promise<ConnectionView> {
    const row = await this.require(companyId, id)
    await viaGateway(() => this.gateway.sessions.logout(row.sessionId))
    const at = this.now()
    return this.patch(companyId, id, { connectionState: 'close', lastDisconnectReason: 'loggedOut', disconnectedAt: at, updatedAt: at })
  }

  async restart(companyId: string, id: string): Promise<ConnectionView> {
    const row = await this.require(companyId, id)
    await viaGateway(() => this.gateway.sessions.restart(row.sessionId))
    return this.patch(companyId, id, { requiresRestart: false, updatedAt: this.now() })
  }

  async scheduleDeletion(companyId: string, id: string): Promise<ConnectionView> {
    await this.require(companyId, id)
    return this.patch(companyId, id, { scheduledForDeletionAt: this.now(), updatedAt: this.now() })
  }

  async qr(companyId: string, id: string): Promise<{ qr_code: string | null; generated_at: string | null }> {
    const row = await this.require(companyId, id)
    const qr = await viaGateway(() => this.gateway.sessions.getQr(row.sessionId))
    return { qr_code: qr.qr, generated_at: qr.generatedAt }
  }

  /** Código no telefone: DDI + número só com dígitos (`^[1-9]\d{6,14}$`). */
  async pairingCode(companyId: string, id: string, phone: unknown): Promise<{ code: string }> {
    const digits = this.validPhone(phone)
    const row = await this.require(companyId, id)
    const res = await viaGateway(() => this.gateway.sessions.requestPairingCode(row.sessionId, `+${digits}`))
    await this.patch(companyId, id, { qrRequestedAt: this.now(), phoneNumber: row.phoneNumber ?? `+${digits}`, updatedAt: this.now() })
    return { code: res.code }
  }

  /** Proxy personalizado: guardado no CRM (senha cifrada); vale depois de reiniciar a sessão. */
  async setProxy(companyId: string, id: string, input: Record<string, unknown>): Promise<ConnectionView> {
    await this.require(companyId, id)
    const protocol = input.protocol
    if (!(PROXY_PROTOCOLS as readonly unknown[]).includes(protocol)) throw validation('protocol', 'Use http, https ou socks5')
    const host = typeof input.host === 'string' ? input.host.trim() : ''
    if (!host || host.length > 253 || /\s/.test(host)) throw validation('host', 'Host inválido')
    const port = Number(input.port)
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw validation('port', 'Porta entre 1 e 65535')
    const username = input.username === undefined || input.username === null || input.username === '' ? null : String(input.username)
    const password = input.password === undefined || input.password === null || input.password === '' ? null : String(input.password)
    // Senha vazia/ausente mantém a salva (regra dos segredos do CRM); apagar só com `remove_password: true` (T71).
    const removePassword = input.remove_password === undefined ? false : this.bool(input.remove_password, 'remove_password')
    if (removePassword && password) throw validation('remove_password', 'Envie a nova senha ou remove_password, não os dois')
    const set: Partial<typeof connections.$inferInsert> = {
      proxyProtocol: protocol as string,
      proxyHost: host,
      proxyPort: port,
      proxyUsername: username,
      requiresRestart: true,
      updatedAt: this.now(),
    }
    if (password) set.proxyPasswordEnc = serializeEncrypted(this.cipher().encrypt(password, `connection/${id}/proxy`))
    else if (removePassword) set.proxyPasswordEnc = null
    return this.patch(companyId, id, set)
  }

  async removeProxy(companyId: string, id: string): Promise<ConnectionView> {
    await this.require(companyId, id)
    return this.patch(companyId, id, { proxyProtocol: null, proxyHost: null, proxyPort: null, proxyUsername: null, proxyPasswordEnc: null, requiresRestart: true, updatedAt: this.now() })
  }

  // ---------------------------------------------------------------- perfil (opcional por capacidade)

  async getProfile(companyId: string, id: string) {
    const row = await this.require(companyId, id)
    const profile = this.profileControl()
    const p = await viaGateway(() => profile.get(row.sessionId))
    return { name: p.name, status: p.status, picture_url: p.pictureUrl }
  }

  async updateProfile(companyId: string, id: string, input: { name?: unknown; status?: unknown }) {
    const row = await this.require(companyId, id)
    const profile = this.profileControl()
    if (input.name !== undefined) {
      if (typeof input.name !== 'string' || !input.name.trim() || input.name.length > 25) throw validation('name', 'Nome do perfil entre 1 e 25 caracteres')
      if (!profile.setName) throw new ConnectionsError('not_supported', 'Edição do nome do perfil não suportada')
      await viaGateway(() => profile.setName!(row.sessionId, String(input.name).trim()))
    }
    if (input.status !== undefined) {
      if (typeof input.status !== 'string' || input.status.length > 139) throw validation('status', 'Recado com até 139 caracteres')
      if (!profile.setStatus) throw new ConnectionsError('not_supported', 'Edição do recado não suportada')
      await viaGateway(() => profile.setStatus!(row.sessionId, String(input.status)))
    }
    return this.getProfile(companyId, id)
  }

  // ---------------------------------------------------------------- integrações (T22, T33, T47)

  /** Sessões das conexões da empresa (fonte do `registerCompanySessionsSource`, T22). */
  async sessionIdsOf(companyId: string): Promise<string[]> {
    const rows = await this.db.select({ sessionId: connections.sessionId }).from(connections).where(eq(connections.companyId, companyId))
    return rows.map((r) => r.sessionId)
  }

  /** Projeta `session.connection` na conexão (estado, motivo, horários). Devolve `false` se a sessão não é do CRM. */
  async applyConnectionEvent(event: WaEvent): Promise<boolean> {
    if (event.type !== 'session.connection') return false
    const at = new Date(event.at)
    const set: Partial<typeof connections.$inferInsert> = { connectionState: event.state, updatedAt: this.now() }
    if (event.state === 'open') {
      set.connectedAt = at
      set.lastDisconnectReason = null
      set.lastStatusCode = null
    } else {
      set.disconnectedAt = at
      set.lastDisconnectReason = event.reason ?? null
      set.lastStatusCode = event.status_code ?? null
    }
    const res = await this.db.update(connections).set(set).where(eq(connections.sessionId, event.session_id)).returning({ id: connections.id })
    return res.length > 0
  }

  // ---------------------------------------------------------------- internos

  private profileControl() {
    if (!this.gateway.capabilities.businessProfile || !this.gateway.profile) throw new ConnectionsError('not_found', 'Perfil do WhatsApp indisponível para esta conexão')
    return this.gateway.profile
  }

  private cipher(): Pick<CredentialCipher, 'encrypt'> {
    return this.opts.cipher ?? getCredentialsCipher()
  }

  private async assertBelowLimit(companyId: string): Promise<void> {
    const { connections: limit, used } = await this.limits(companyId)
    if (limit !== null && used >= limit) throw new ConnectionsError('limit_reached', 'Limite de conexões da empresa atingido', { limit, used })
  }

  private validName(v: unknown): string {
    const name = typeof v === 'string' ? v.trim() : ''
    if (name.length < 2 || name.length > 100) throw validation('name', 'Nome é obrigatório (2 a 100 caracteres)')
    return name
  }

  private validPhone(v: unknown): string {
    const digits = typeof v === 'string' || typeof v === 'number' ? String(v).replace(/^\+/, '') : ''
    if (!PAIRING_PHONE_RE.test(digits)) throw validation('phone', 'Número inválido: DDI + número, só dígitos')
    return digits
  }

  private bool(v: unknown, field: string): boolean {
    if (typeof v !== 'boolean') throw validation(field, `${field} deve ser true ou false`)
    return v
  }

  private async require(companyId: string, id: string): Promise<ConnectionRow> {
    if (!UUID_RE.test(id)) throw new ConnectionsError('not_found', 'Conexão não encontrada')
    const [row] = await this.db
      .select()
      .from(connections)
      .where(and(eq(connections.id, id), eq(connections.companyId, companyId)))
    if (!row) throw new ConnectionsError('not_found', 'Conexão não encontrada')
    return row
  }

  private async patch(companyId: string, id: string, set: Partial<typeof connections.$inferInsert>): Promise<ConnectionView> {
    const [row] = await this.db
      .update(connections)
      .set(set)
      .where(and(eq(connections.id, id), eq(connections.companyId, companyId)))
      .returning()
    if (!row) throw new ConnectionsError('not_found', 'Conexão não encontrada')
    return this.toView(row, await this.sessionState(row.sessionId))
  }

  private async sessionState(sessionId: string): Promise<SessionState | null> {
    try {
      return (await this.gateway.sessions.get(sessionId)).status
    } catch {
      return null
    }
  }

  private async sessionStates(): Promise<Map<string, SessionState>> {
    try {
      const all: SessionView[] = await this.gateway.sessions.list()
      return new Map(all.map((s) => [s.id, s.status]))
    } catch {
      return new Map()
    }
  }

  private toView(r: ConnectionRow, sessionState: SessionState | null): ConnectionView {
    const { status, badges } = deriveConnectionStatus({
      sessionState,
      connectionState: (r.connectionState as 'open' | 'close' | null) ?? null,
      lastDisconnectReason: (r.lastDisconnectReason as DisconnectKind | null) ?? null,
      qrRequested: r.qrRequestedAt !== null,
      requiresRestart: r.requiresRestart,
      scheduledForDeletion: r.scheduledForDeletionAt !== null,
    })
    return {
      id: r.id,
      name: r.name,
      session_id: r.sessionId,
      phone_number: r.phoneNumber,
      status,
      session_state: sessionState,
      badges,
      connection_state: (r.connectionState as 'open' | 'close' | null) ?? null,
      last_disconnect_reason: (r.lastDisconnectReason as DisconnectKind | null) ?? null,
      disconnected_at: iso(r.disconnectedAt),
      connected_at: iso(r.connectedAt),
      notify_sent_by_me: r.notifySentByMe,
      ephemeral_duration: r.ephemeralDuration as EphemeralDuration,
      save_contacts_enabled: r.saveContactsEnabled,
      scheduled_for_deletion_at: iso(r.scheduledForDeletionAt),
      requires_restart: r.requiresRestart,
      proxy: r.proxyHost
        ? { protocol: r.proxyProtocol!, host: r.proxyHost, port: r.proxyPort!, username: r.proxyUsername, has_password: r.proxyPasswordEnc !== null }
        : null,
      created_at: r.createdAt.toISOString(),
      updated_at: r.updatedAt.toISOString(),
    }
  }
}

/** Sessão → conexão e empresa (resolver da T33/T49). `undefined` se a sessão não é do CRM. */
export async function connectionBySession(db: Database, sessionId: string): Promise<{ connectionId: string; companyId: string } | undefined> {
  const [row] = await db
    .select({ connectionId: connections.id, companyId: connections.companyId })
    .from(connections)
    .where(eq(connections.sessionId, sessionId))
    .limit(1)
  return row
}
