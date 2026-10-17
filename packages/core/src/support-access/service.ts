// Acesso de suporte (T32; 01 §19, 16 §3.7/§5): pedidos do usuário `support`, decisão de owner/admin, concessão de
// 12 h e revogação. Eventos `support_access.*` vão para a empresa e para o stream do usuário `support` (T16).
import { and, asc, desc, eq, gt, inArray, isNull, sql, type SQL } from 'drizzle-orm'
import { companies, companyMembers, flows, supportAccessGrants, supportAccessRequests, users, type Database, type SupportAccessRequestStatus } from '@crm/db'
import type { Logger } from '@crm/node-kit'
import type { RealtimeEventType } from '@crm/shared'
import { isUniqueViolation } from '../auth/errors'
import { isUuid } from '../platform/company-context'
import type { RealtimePublisher } from '../realtime/publisher'
import { SupportAccessError } from './errors'
import { SUPPORT_GRANT_TTL_MS } from './grants'

export interface SupportAccessServiceOptions {
  db: Database
  publisher?: RealtimePublisher
  logger?: Pick<Logger, 'warn'>
  /** Validade da concessão (default 12 h). */
  grantTtlMs?: number
  /** Relógio (testes). */
  now?: () => Date
}

/** Empresa encontrada no lookup por e-mail do owner/admin (`{ accounts }` no fio). */
export interface SupportAccessAccount {
  id: string
  name: string
}

/** Pedido no fio (16 §3.7: `id`, `status`, `support_name`, `support_email`, empresa). */
export interface SupportAccessRequestDto {
  id: string
  status: SupportAccessRequestStatus
  support_user_id: string
  support_name: string
  support_email: string
  company_id: string
  company_name: string
  decided_at: string | null
  resent_at: string | null
  created_at: string
  updated_at: string
}

/** Concessão no fio (16 §3.7: `support_user_id`, nome, e-mail, `expires_at`). */
export interface SupportAccessGrantDto {
  id: string
  support_user_id: string
  name: string
  email: string
  company_id: string
  company_name: string
  request_id: string | null
  expires_at: string
  created_at: string
}

/** Fluxo da empresa listado na área do suporte (link para `/flows/:id/edit`). */
export interface SupportAccessFlowDto {
  id: string
  name: string
  folder_id: string | null
  status: string
  updated_at: string
}

export interface CreateSupportRequestInput {
  /** E-mail do owner/admin da empresa. */
  email: string
  /** Obrigatório quando o e-mail é owner/admin de mais de uma empresa. */
  companyId?: string | null
}

const iso = (d: Date | null) => (d ? d.toISOString() : null)
const normalizeEmail = (email: string) => email.trim().toLowerCase()
const notFound = (what: string) => new SupportAccessError('not_found', `${what} não encontrado`)

const requestColumns = {
  id: supportAccessRequests.id,
  status: supportAccessRequests.status,
  supportUserId: supportAccessRequests.supportUserId,
  supportName: users.name,
  supportEmail: users.email,
  companyId: supportAccessRequests.companyId,
  companyName: companies.name,
  decidedAt: supportAccessRequests.decidedAt,
  resentAt: supportAccessRequests.resentAt,
  createdAt: supportAccessRequests.createdAt,
  updatedAt: supportAccessRequests.updatedAt,
}
interface RequestRow {
  id: string
  status: SupportAccessRequestStatus
  supportUserId: string
  supportName: string
  supportEmail: string
  companyId: string
  companyName: string
  decidedAt: Date | null
  resentAt: Date | null
  createdAt: Date
  updatedAt: Date
}

const grantColumns = {
  id: supportAccessGrants.id,
  supportUserId: supportAccessGrants.supportUserId,
  name: users.name,
  email: users.email,
  companyId: supportAccessGrants.companyId,
  companyName: companies.name,
  requestId: supportAccessGrants.requestId,
  expiresAt: supportAccessGrants.expiresAt,
  createdAt: supportAccessGrants.createdAt,
}
interface GrantRow {
  id: string
  supportUserId: string
  name: string
  email: string
  companyId: string
  companyName: string
  requestId: string | null
  expiresAt: Date
  createdAt: Date
}

const toRequestDto = (r: RequestRow): SupportAccessRequestDto => ({
  id: r.id,
  status: r.status,
  support_user_id: r.supportUserId,
  support_name: r.supportName,
  support_email: r.supportEmail,
  company_id: r.companyId,
  company_name: r.companyName,
  decided_at: iso(r.decidedAt),
  resent_at: iso(r.resentAt),
  created_at: r.createdAt.toISOString(),
  updated_at: r.updatedAt.toISOString(),
})

const toGrantDto = (g: GrantRow): SupportAccessGrantDto => ({
  id: g.id,
  support_user_id: g.supportUserId,
  name: g.name,
  email: g.email,
  company_id: g.companyId,
  company_name: g.companyName,
  request_id: g.requestId,
  expires_at: g.expiresAt.toISOString(),
  created_at: g.createdAt.toISOString(),
})

export class SupportAccessService {
  private readonly db: Database
  private readonly ttlMs: number
  private readonly now: () => Date

  constructor(private readonly opts: SupportAccessServiceOptions) {
    this.db = opts.db
    this.ttlMs = opts.grantTtlMs ?? SUPPORT_GRANT_TTL_MS
    this.now = opts.now ?? (() => new Date())
  }

  // ---------- lado do suporte ----------

  /** Empresas ativas em que o e-mail é owner/admin. E-mail desconhecido → lista vazia (não revela existência). */
  async lookup(email: string): Promise<SupportAccessAccount[]> {
    const normalized = normalizeEmail(email)
    if (!normalized) return []
    return this.db
      .select({ id: companies.id, name: companies.name })
      .from(companyMembers)
      .innerJoin(users, eq(users.id, companyMembers.userId))
      .innerJoin(companies, eq(companies.id, companyMembers.companyId))
      .where(and(sql`lower(${users.email}) = ${normalized}`, inArray(companyMembers.role, ['owner', 'admin']), eq(companies.active, true)))
      .orderBy(asc(companies.name), asc(companies.id))
  }

  /**
   * Cria o pedido para a empresa do owner/admin `email` (se houver só uma, é escolhida sozinha). Já existe pedido
   * pendente → 409 `request_pending`; concessão ativa → 409 `grant_active`.
   */
  async createRequest(supportUserId: string, input: CreateSupportRequestInput): Promise<SupportAccessRequestDto> {
    const accounts = await this.lookup(input.email)
    if (accounts.length === 0) throw new SupportAccessError('validation', 'Nenhuma empresa encontrada para este e-mail', 'account_not_found')
    let companyId: string
    if (input.companyId) {
      const hit = accounts.find((a) => a.id.toLowerCase() === input.companyId!.toLowerCase())
      if (!hit) throw new SupportAccessError('validation', 'Empresa não encontrada para este e-mail', 'account_not_found')
      companyId = hit.id
    } else if (accounts.length === 1) {
      companyId = accounts[0]!.id
    } else {
      throw new SupportAccessError('validation', 'Escolha a empresa', 'account_required', { accounts })
    }

    const now = this.now()
    const [grant] = await this.db
      .select({ id: supportAccessGrants.id })
      .from(supportAccessGrants)
      .where(
        and(
          eq(supportAccessGrants.companyId, companyId),
          eq(supportAccessGrants.supportUserId, supportUserId),
          isNull(supportAccessGrants.revokedAt),
          gt(supportAccessGrants.expiresAt, now),
        ),
      )
      .limit(1)
    if (grant) throw new SupportAccessError('conflict', 'Já existe acesso ativo a esta empresa', 'grant_active')

    let id: string
    try {
      const [row] = await this.db
        .insert(supportAccessRequests)
        .values({ companyId, supportUserId, status: 'pending', createdAt: now, updatedAt: now })
        .returning({ id: supportAccessRequests.id })
      id = row!.id
    } catch (err) {
      if (isUniqueViolation(err, 'support_access_requests_pending_uq'))
        throw new SupportAccessError('conflict', 'Já existe um pedido pendente para esta empresa', 'request_pending')
      throw err
    }
    const request = await this.getRequest(eq(supportAccessRequests.id, id))
    await this.publish('support_access.requested', request.company_id, request.support_user_id, { request })
    return request
  }

  /** Pedidos do suporte, mais recentes primeiro. */
  async listMyRequests(supportUserId: string): Promise<SupportAccessRequestDto[]> {
    return this.listRequestsWhere(eq(supportAccessRequests.supportUserId, supportUserId))
  }

  /** Reenvia um pedido pendente: publica `support_access.requested` de novo. */
  async resendRequest(supportUserId: string, requestId: string): Promise<SupportAccessRequestDto> {
    const request = await this.transition(this.ownRequest(supportUserId, requestId), { resentAt: this.now() })
    await this.publish('support_access.requested', request.company_id, request.support_user_id, { request })
    return request
  }

  /** Cancela um pedido pendente do próprio suporte. */
  async cancelRequest(supportUserId: string, requestId: string): Promise<SupportAccessRequestDto> {
    const now = this.now()
    const request = await this.transition(this.ownRequest(supportUserId, requestId), { status: 'cancelled', cancelledAt: now })
    await this.publish('support_access.cancelled', request.company_id, request.support_user_id, { request })
    return request
  }

  /** Concessões ativas do suporte (área `/support/access`). */
  async listMyGrants(supportUserId: string): Promise<SupportAccessGrantDto[]> {
    return this.listGrantsWhere(eq(supportAccessGrants.supportUserId, supportUserId))
  }

  /** Fluxos da empresa concedida; sem concessão ativa → 404. */
  async listGrantFlows(supportUserId: string, companyId: string): Promise<SupportAccessFlowDto[]> {
    if (!isUuid(companyId)) throw notFound('Acesso')
    const [grant] = await this.listGrantsWhere(and(eq(supportAccessGrants.supportUserId, supportUserId), eq(supportAccessGrants.companyId, companyId))!)
    if (!grant) throw notFound('Acesso')
    const rows = await this.db
      .select({ id: flows.id, name: flows.name, folderId: flows.folderId, status: flows.status, updatedAt: flows.updatedAt })
      .from(flows)
      .where(eq(flows.companyId, companyId))
      .orderBy(asc(flows.name), asc(flows.id))
    return rows.map((f) => ({ id: f.id, name: f.name, folder_id: f.folderId, status: f.status, updated_at: f.updatedAt.toISOString() }))
  }

  // ---------- lado da empresa (owner/admin) ----------

  /** Pedidos da empresa (default: só os pendentes, mais antigos primeiro, para o modal avançar em ordem). */
  async listCompanyRequests(companyId: string, status: SupportAccessRequestStatus | 'all' = 'pending'): Promise<SupportAccessRequestDto[]> {
    const byCompany = eq(supportAccessRequests.companyId, companyId)
    if (status === 'all') return this.listRequestsWhere(byCompany)
    return this.listRequestsWhere(and(byCompany, eq(supportAccessRequests.status, status))!, status === 'pending' ? 'asc' : 'desc')
  }

  /** Aprova o pedido: concessão que expira em 12 h (substitui uma concessão ativa anterior do mesmo suporte). */
  async approve(companyId: string, requestId: string, actorUserId: string): Promise<{ request: SupportAccessRequestDto; grant: SupportAccessGrantDto }> {
    const now = this.now()
    const expiresAt = new Date(now.getTime() + this.ttlMs)
    const where = this.companyRequest(companyId, requestId)
    const grantId = await this.db.transaction(async (tx) => {
      const [req] = await tx
        .update(supportAccessRequests)
        .set({ status: 'approved', decidedByUserId: actorUserId, decidedAt: now, updatedAt: now })
        .where(and(where, eq(supportAccessRequests.status, 'pending')))
        .returning({ supportUserId: supportAccessRequests.supportUserId })
      if (!req) return null
      await tx
        .update(supportAccessGrants)
        .set({ revokedAt: now, revokedByUserId: actorUserId, updatedAt: now })
        .where(
          and(
            eq(supportAccessGrants.companyId, companyId),
            eq(supportAccessGrants.supportUserId, req.supportUserId),
            isNull(supportAccessGrants.revokedAt),
            gt(supportAccessGrants.expiresAt, now),
          ),
        )
      const [g] = await tx
        .insert(supportAccessGrants)
        .values({ companyId, supportUserId: req.supportUserId, requestId, grantedByUserId: actorUserId, expiresAt, createdAt: now, updatedAt: now })
        .returning({ id: supportAccessGrants.id })
      return g!.id
    })
    if (!grantId) await this.failTransition(where)
    const request = await this.getRequest(where)
    const [grant] = await this.grantsWhere(eq(supportAccessGrants.id, grantId!))
    await this.publish('support_access.granted', companyId, request.support_user_id, { request, grant: grant! })
    return { request, grant: grant! }
  }

  /** Recusa o pedido pendente. */
  async reject(companyId: string, requestId: string, actorUserId: string): Promise<SupportAccessRequestDto> {
    const now = this.now()
    const request = await this.transition(this.companyRequest(companyId, requestId), {
      status: 'rejected',
      decidedByUserId: actorUserId,
      decidedAt: now,
    })
    await this.publish('support_access.rejected', companyId, request.support_user_id, { request })
    return request
  }

  /** Concessões ativas da empresa (aba "Acesso de suporte"). */
  async listCompanyGrants(companyId: string): Promise<SupportAccessGrantDto[]> {
    return this.listGrantsWhere(eq(supportAccessGrants.companyId, companyId))
  }

  /** Revoga as concessões ativas do suporte na empresa; vale na próxima requisição. Nenhuma ativa → 404. */
  async revoke(companyId: string, supportUserId: string, actorUserId: string): Promise<SupportAccessGrantDto> {
    if (!isUuid(supportUserId)) throw notFound('Acesso')
    const now = this.now()
    const [grant] = await this.listGrantsWhere(and(eq(supportAccessGrants.companyId, companyId), eq(supportAccessGrants.supportUserId, supportUserId))!)
    if (!grant) throw notFound('Acesso')
    await this.db
      .update(supportAccessGrants)
      .set({ revokedAt: now, revokedByUserId: actorUserId, updatedAt: now })
      .where(
        and(
          eq(supportAccessGrants.companyId, companyId),
          eq(supportAccessGrants.supportUserId, supportUserId),
          isNull(supportAccessGrants.revokedAt),
          gt(supportAccessGrants.expiresAt, now),
        ),
      )
    await this.publish('support_access.revoked', companyId, supportUserId, { grant })
    return grant
  }

  // ---------- internos ----------

  private ownRequest(supportUserId: string, requestId: string): SQL {
    if (!isUuid(requestId)) throw notFound('Pedido')
    return and(eq(supportAccessRequests.id, requestId), eq(supportAccessRequests.supportUserId, supportUserId))!
  }

  private companyRequest(companyId: string, requestId: string): SQL {
    if (!isUuid(requestId)) throw notFound('Pedido')
    return and(eq(supportAccessRequests.id, requestId), eq(supportAccessRequests.companyId, companyId))!
  }

  /** Atualiza um pedido `pending`; inexistente → 404; em outro estado → 409 `INVALID_TRANSITION`. */
  private async transition(where: SQL, set: Partial<typeof supportAccessRequests.$inferInsert>): Promise<SupportAccessRequestDto> {
    const [row] = await this.db
      .update(supportAccessRequests)
      .set({ ...set, updatedAt: this.now() })
      .where(and(where, eq(supportAccessRequests.status, 'pending')))
      .returning({ id: supportAccessRequests.id })
    if (!row) await this.failTransition(where)
    return this.getRequest(where)
  }

  private async failTransition(where: SQL): Promise<never> {
    const [cur] = await this.db.select({ status: supportAccessRequests.status }).from(supportAccessRequests).where(where).limit(1)
    if (!cur) throw notFound('Pedido')
    throw new SupportAccessError('invalid_transition', `Pedido já está ${cur.status}`, 'request_not_pending', { status: cur.status })
  }

  private async getRequest(where: SQL): Promise<SupportAccessRequestDto> {
    const [row] = await this.requestsQuery(where).limit(1)
    if (!row) throw notFound('Pedido')
    return toRequestDto(row)
  }

  private requestsQuery(where: SQL) {
    return this.db
      .select(requestColumns)
      .from(supportAccessRequests)
      .innerJoin(users, eq(users.id, supportAccessRequests.supportUserId))
      .innerJoin(companies, eq(companies.id, supportAccessRequests.companyId))
      .where(where)
  }

  private async listRequestsWhere(where: SQL, order: 'asc' | 'desc' = 'desc'): Promise<SupportAccessRequestDto[]> {
    const dir = order === 'asc' ? asc : desc
    const rows = await this.requestsQuery(where).orderBy(dir(supportAccessRequests.createdAt), dir(supportAccessRequests.id))
    return rows.map(toRequestDto)
  }

  private async grantsWhere(where: SQL): Promise<SupportAccessGrantDto[]> {
    const rows = await this.db
      .select(grantColumns)
      .from(supportAccessGrants)
      .innerJoin(users, eq(users.id, supportAccessGrants.supportUserId))
      .innerJoin(companies, eq(companies.id, supportAccessGrants.companyId))
      .where(where)
      .orderBy(desc(supportAccessGrants.expiresAt), desc(supportAccessGrants.id))
    return rows.map(toGrantDto)
  }

  /** Concessões ativas (não revogadas e `expires_at > now`) que casam com `where`. */
  private listGrantsWhere(where: SQL): Promise<SupportAccessGrantDto[]> {
    return this.grantsWhere(and(where, isNull(supportAccessGrants.revokedAt), gt(supportAccessGrants.expiresAt, this.now()))!)
  }

  /** Publica na empresa e no stream do usuário `support` (AC-T32-03). Falha de Redis não desfaz a ação. */
  private async publish<T extends RealtimeEventType>(type: T, companyId: string, supportUserId: string, data: unknown): Promise<void> {
    const pub = this.opts.publisher
    if (!pub) return
    const send = (opts: { userId?: string }) =>
      pub.publish(companyId, type, data as never, opts).catch((err: unknown) => this.opts.logger?.warn({ err, type }, 'realtime publish failed'))
    await send({})
    await send({ userId: supportUserId })
  }
}
