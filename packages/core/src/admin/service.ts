// Admin interno da plataforma (T95; 20 §3.1, §3.2, §3.8, §3.12, §5): usuários globais, empresas (ativa, limites,
// `inbox_limits`), cota de disparos e estatísticas. Sem filtro de empresa: só `platform_admin` chega aqui (a API
// garante). Ativar/desativar replica a lógica do dono (T22) sem exigir vínculo. Estatísticas só com dados do CRM
// (sem WaGateway, sem dinheiro: 10.1 nº 7).
import {
  aiAgents,
  companies,
  companyMembers,
  connections,
  flows,
  inboundWebhooks,
  messages,
  userProfiles,
  users,
  type Database,
  type MemberRole,
  type SystemRole,
} from '@crm/db'
import { hashPassword, type Logger } from '@crm/node-kit'
import { DEFAULT_TIME_ZONE, buildPageMeta, pageOffset, type PageResponse } from '@crm/shared'
import type { WaGateway } from '@crm/wa-port'
import { and, asc, count, desc, eq, gte, ilike, inArray, isNull, lt, or, sql } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'
import { isUniqueViolation } from '../auth/errors'
import { normalizeEmail, normalizeWhatsapp } from '../auth/normalize'
import { companySessionIds, type CompanySessionsSource } from '../companies/sessions-source'
import {
  addMassDispatchBonus,
  massDispatchPerConnectionLimit,
  massDispatchQuota,
  setMassDispatchPerConnectionLimit,
  type QuotaDto,
} from '../mass-dispatch/service'
import type { SessionService } from '../platform/session-service'
import type { RealtimePublisher } from '../realtime/publisher'
import { AdminError, adminInvalid, adminNotFound } from './errors'
import {
  mergeCompanyLimits,
  readCompanyLimits,
  readInboxLimits,
  type CompanyLimitKey,
  type CompanyLimits,
  type InboxLimits,
} from './limits'
import { statsDays, resolveStatsPeriod } from './period'
import { LEGACY_ROLE_LABELS, legacyRoleOf, MEMBER_ROLE_LABELS, resolveSystemRole, type LegacyUserRole } from './roles'

export const ADMIN_PASSWORD_MIN = 6
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export interface AdminUserDto {
  id: string
  name: string
  email: string
  system_role: SystemRole
  /** Papel no enum da referência (20 §4): admin | support | client (dono de empresa) | client_employee. */
  role: LegacyUserRole
  role_label: string
  personal_whatsapp: string | null
  locale: string
  last_company_id: string | null
  companies_count: number
  created_at: string
  updated_at: string
}

export interface AdminUserCompanyDto {
  account_id: string
  account_name: string
  role: MemberRole
  role_label: string
  active: boolean
}

export interface AdminCompanyDto {
  id: string
  name: string
  slug: string
  active: boolean
  deactivated_at: string | null
  time_zone: string
  owner: { id: string; name: string; email: string } | null
  owner_email: string | null
  users_count: number
  /** `null` = ilimitado. */
  limits: CompanyLimits
  /** Gravado e exposto; nenhum módulo aplica ainda. */
  inbox_limits: InboxLimits | null
  mass_dispatch_quota: QuotaDto
  created_at: string
  updated_at: string
}

export type AdminCompanyDetailDto = AdminCompanyDto & { usage: Record<CompanyLimitKey, number> }

export interface AdminStatisticsDto {
  start_date: string
  end_date: string
  time_zone: string
  new_companies: number
  new_users: number
  totals: {
    companies: number
    active_companies: number
    users: number
    connections: number
    connected_connections: number
  }
  messages: { total: number; inbound: number; outbound: number }
  messages_per_day: Array<{ date: string; total: number; inbound: number; outbound: number }>
}

export interface CreateAdminUserInput {
  name: string
  email: string
  password: string
  personal_whatsapp?: string | null
  system_role?: SystemRole
  role?: LegacyUserRole
}

export interface UpdateAdminUserInput {
  name?: string
  personal_whatsapp?: string | null
  system_role?: SystemRole
  role?: LegacyUserRole
  password?: string
}

export interface UpdateAdminCompanyInput {
  active?: boolean
  limits?: Partial<CompanyLimits>
  inbox_limits?: InboxLimits | null
}

export interface AdminServiceOptions {
  db: Database
  /** Pausa as sessões ao desativar; sem ele só registra no log (como a T22). */
  waGateway?: Pick<WaGateway, 'sessions'>
  sessionsSources?: readonly CompanySessionsSource[]
  publisher?: Pick<RealtimePublisher, 'publish'>
  /** Revoga as sessões do usuário quando o admin troca a senha dele. */
  sessions?: Pick<SessionService, 'revokeAllForUser'>
  logger?: Pick<Logger, 'warn'>
  now?: () => Date
}

type CompanyRow = typeof companies.$inferSelect
type ListQuery = { page: number; limit: number; search?: string; skip_total?: boolean }

const iso = (d: Date | null) => (d ? d.toISOString() : null)
const like = (s: string) => `%${s.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`

export class AdminService {
  private readonly db: Database
  private readonly now: () => Date

  constructor(private readonly opts: AdminServiceOptions) {
    this.db = opts.db
    this.now = opts.now ?? (() => new Date())
  }

  // ---------------------------------------------------------------- usuários

  async listUsers(q: ListQuery): Promise<PageResponse<AdminUserDto>> {
    const where = q.search ? or(ilike(users.name, like(q.search)), ilike(users.email, like(q.search))) : undefined
    const rows = await this.db
      .select({ u: users, personalWhatsapp: userProfiles.personalWhatsapp })
      .from(users)
      .leftJoin(userProfiles, eq(userProfiles.userId, users.id))
      .where(where)
      .orderBy(desc(users.createdAt), asc(users.id))
      .limit(q.skip_total ? q.limit + 1 : q.limit)
      .offset(pageOffset(q))
    const page = rows.slice(0, q.limit)
    const meta = q.skip_total
      ? buildPageMeta(q, { fetchedCount: rows.length })
      : buildPageMeta(q, { total: (await this.db.select({ n: count() }).from(users).where(where))[0]?.n ?? 0 })
    const stats = await this.membershipStats(page.map((r) => r.u.id))
    return { items: page.map((r) => this.userDto(r.u, r.personalWhatsapp, stats.get(r.u.id))), page: meta }
  }

  async getUser(id: string): Promise<AdminUserDto> {
    if (!UUID_RE.test(id)) throw adminNotFound('Usuário')
    const [r] = await this.db
      .select({ u: users, personalWhatsapp: userProfiles.personalWhatsapp })
      .from(users)
      .leftJoin(userProfiles, eq(userProfiles.userId, users.id))
      .where(eq(users.id, id))
      .limit(1)
    if (!r) throw adminNotFound('Usuário')
    return this.userDto(r.u, r.personalWhatsapp, (await this.membershipStats([id])).get(id))
  }

  /** Cria um usuário global (inclusive `support` e `platform_admin`), sem empresa. E-mail repetido → conflito. */
  async createUser(input: CreateAdminUserInput): Promise<AdminUserDto> {
    this.assertPassword(input.password)
    const passwordHash = await hashPassword(input.password)
    const personalWhatsapp = normalizeWhatsapp(input.personal_whatsapp)
    let id: string
    try {
      id = await this.db.transaction(async (tx) => {
        const [u] = await tx
          .insert(users)
          .values({
            name: input.name.trim(),
            email: normalizeEmail(input.email),
            passwordHash,
            systemRole: resolveSystemRole(input) ?? 'user',
          })
          .returning({ id: users.id })
        if (personalWhatsapp) await tx.insert(userProfiles).values({ userId: u!.id, personalWhatsapp })
        return u!.id
      })
    } catch (err) {
      if (isUniqueViolation(err, 'users_email_lower_uq'))
        throw new AdminError('conflict', 'E-mail já cadastrado', {
          error_code: 'email_taken',
          fields: [{ path: 'email', message: 'E-mail já cadastrado' }],
        })
      throw err
    }
    return this.getUser(id)
  }

  /**
   * Edita nome, WhatsApp, papel e (se informada) a senha. O e-mail é imutável: o chamador o ignora. Trocar a senha
   * revoga as sessões do usuário (menos a do próprio admin, se editar a si mesmo). O admin não tira de si o
   * `platform_admin` (conflito `self_demotion`).
   */
  async updateUser(
    actor: { userId: string; sessionId?: string | null },
    id: string,
    input: UpdateAdminUserInput,
  ): Promise<{ user: AdminUserDto; password_changed: boolean; fields: string[] }> {
    const before = await this.getUser(id)
    const systemRole = resolveSystemRole(input)
    if (actor.userId === id && systemRole !== undefined && systemRole !== 'platform_admin')
      throw new AdminError('conflict', 'Você não pode remover o seu próprio acesso de administrador', {
        error_code: 'self_demotion',
      })
    if (input.password !== undefined) this.assertPassword(input.password)

    const set: Partial<typeof users.$inferInsert> = {}
    const fields: string[] = []
    if (input.name !== undefined && input.name.trim() !== before.name) {
      set.name = input.name.trim()
      fields.push('name')
    }
    if (systemRole !== undefined && systemRole !== before.system_role) {
      set.systemRole = systemRole
      fields.push('system_role')
    }
    if (input.password !== undefined) {
      set.passwordHash = await hashPassword(input.password)
      fields.push('password')
    }
    const whatsapp = input.personal_whatsapp !== undefined ? normalizeWhatsapp(input.personal_whatsapp) : undefined
    if (whatsapp !== undefined && whatsapp !== before.personal_whatsapp) fields.push('personal_whatsapp')

    await this.db.transaction(async (tx) => {
      if (Object.keys(set).length)
        await tx
          .update(users)
          .set({ ...set, updatedAt: this.now() })
          .where(eq(users.id, id))
      if (fields.includes('personal_whatsapp'))
        await tx
          .insert(userProfiles)
          .values({ userId: id, personalWhatsapp: whatsapp ?? null })
          .onConflictDoUpdate({
            target: userProfiles.userId,
            set: { personalWhatsapp: whatsapp ?? null, updatedAt: this.now() },
          })
    })
    const passwordChanged = input.password !== undefined
    if (passwordChanged)
      await this.opts.sessions?.revokeAllForUser(id, actor.userId === id ? (actor.sessionId ?? undefined) : undefined)
    return { user: await this.getUser(id), password_changed: passwordChanged, fields }
  }

  /** Empresas do usuário (20 §3.1 "Ver empresas"): vazio quando não há vínculo. */
  async userCompanies(id: string): Promise<AdminUserCompanyDto[]> {
    await this.getUser(id)
    const rows = await this.db
      .select({ id: companies.id, name: companies.name, active: companies.active, role: companyMembers.role })
      .from(companyMembers)
      .innerJoin(companies, eq(companies.id, companyMembers.companyId))
      .where(eq(companyMembers.userId, id))
      .orderBy(asc(companies.name), asc(companies.id))
    return rows.map((r) => ({
      account_id: r.id,
      account_name: r.name,
      role: r.role,
      role_label: MEMBER_ROLE_LABELS[r.role],
      active: r.active,
    }))
  }

  // ---------------------------------------------------------------- empresas

  async listCompanies(q: ListQuery & { active?: boolean }): Promise<PageResponse<AdminCompanyDto>> {
    const owner = alias(companyMembers, 'owner_member')
    const search = q.search
      ? or(
          ilike(companies.name, like(q.search)),
          ilike(companies.slug, like(q.search)),
          ilike(users.email, like(q.search)),
          ilike(users.name, like(q.search)),
        )
      : undefined
    const where = and(search, q.active === undefined ? undefined : eq(companies.active, q.active))
    const base = this.db
      .select({ c: companies, ownerId: users.id, ownerName: users.name, ownerEmail: users.email })
      .from(companies)
      .leftJoin(owner, and(eq(owner.companyId, companies.id), eq(owner.role, 'owner')))
      .leftJoin(users, eq(users.id, owner.userId))
      .where(where)
    const rows = await base
      .orderBy(desc(companies.createdAt), asc(companies.id))
      .limit(q.skip_total ? q.limit + 1 : q.limit)
      .offset(pageOffset(q))
    const page = rows.slice(0, q.limit)
    let meta
    if (q.skip_total) meta = buildPageMeta(q, { fetchedCount: rows.length })
    else {
      const [t] = await this.db
        .select({ n: count() })
        .from(companies)
        .leftJoin(owner, and(eq(owner.companyId, companies.id), eq(owner.role, 'owner')))
        .leftJoin(users, eq(users.id, owner.userId))
        .where(where)
      meta = buildPageMeta(q, { total: t?.n ?? 0 })
    }
    const counts = await this.memberCounts(page.map((r) => r.c.id))
    const items = await Promise.all(
      page.map((r) =>
        this.companyDto(
          r.c,
          r.ownerId ? { id: r.ownerId, name: r.ownerName!, email: r.ownerEmail! } : null,
          counts.get(r.c.id) ?? 0,
        ),
      ),
    )
    return { items, page: meta }
  }

  async getCompany(id: string): Promise<AdminCompanyDetailDto> {
    const row = await this.companyRow(id)
    const [o] = await this.db
      .select({ id: users.id, name: users.name, email: users.email })
      .from(companyMembers)
      .innerJoin(users, eq(users.id, companyMembers.userId))
      .where(and(eq(companyMembers.companyId, id), eq(companyMembers.role, 'owner')))
      .limit(1)
    const usage = await this.usage(id)
    return { ...(await this.companyDto(row, o ?? null, usage.members)), usage }
  }

  /**
   * Ativa/desativa e grava limites (`null` = remove = ilimitado) e `inbox_limits`. Baixar um limite abaixo do uso
   * atual só impede novas criações: nada existente é removido ou desconectado (AC-T95-03).
   */
  async updateCompany(
    id: string,
    input: UpdateAdminCompanyInput,
  ): Promise<{ company: AdminCompanyDetailDto; paused_session_ids: string[]; fields: string[] }> {
    await this.companyRow(id)
    const now = this.now()
    const fields: string[] = []
    let deactivated = false
    await this.db.transaction(async (tx) => {
      const [cur] = await tx.select().from(companies).where(eq(companies.id, id)).for('update')
      const set: Partial<typeof companies.$inferInsert> = {}
      if (input.limits !== undefined || input.inbox_limits !== undefined) {
        set.settings = mergeCompanyLimits(cur!.settings, {
          ...(input.limits ? { limits: input.limits } : {}),
          ...(input.inbox_limits !== undefined ? { inboxLimits: input.inbox_limits } : {}),
        })
        if (input.limits) fields.push('limits')
        if (input.inbox_limits !== undefined) fields.push('inbox_limits')
      }
      if (input.active !== undefined && input.active !== cur!.active) {
        set.active = input.active
        set.deactivatedAt = input.active ? null : now
        deactivated = !input.active
        fields.push('active')
      }
      if (Object.keys(set).length)
        await tx
          .update(companies)
          .set({ ...set, updatedAt: now })
          .where(eq(companies.id, id))
    })
    const paused = deactivated ? await this.pauseSessions(id) : []
    const company = await this.getCompany(id)
    if (fields.length)
      await this.opts.publisher
        ?.publish(id, 'company.updated', { company_id: id, id, name: company.name, fields })
        .catch((err: unknown) => this.opts.logger?.warn({ err }, 'realtime publish failed'))
    return { company, paused_session_ids: paused, fields }
  }

  // ---------------------------------------------------------------- cota de disparos (T60)

  async massDispatchSettings(): Promise<{ per_connection_limit: number; per_instance_limit: number }> {
    const v = await massDispatchPerConnectionLimit(this.db)
    return { per_connection_limit: v, per_instance_limit: v }
  }

  /** Muda o limite global por conexão: a base das cotas é recalculada a cada leitura (AC-T95-04). */
  async setMassDispatchSettings(
    perConnectionLimit: number,
  ): Promise<{ per_connection_limit: number; per_instance_limit: number }> {
    const v = await setMassDispatchPerConnectionLimit(this.db, perConnectionLimit)
    return { per_connection_limit: v, per_instance_limit: v }
  }

  async companyQuota(id: string): Promise<QuotaDto> {
    await this.companyRow(id)
    return massDispatchQuota(this.db, id, this.now())
  }

  /** Soma `delta` ao bônus do período atual (fuso da empresa), sem tocar no limite global. */
  async addQuotaBonus(id: string, delta: number): Promise<QuotaDto> {
    await this.companyRow(id)
    if (!Number.isInteger(delta) || delta === 0) throw adminInvalid('bonus_delta', 'Use um inteiro diferente de 0')
    const now = this.now()
    await addMassDispatchBonus(this.db, id, delta, now)
    return massDispatchQuota(this.db, id, now)
  }

  // ---------------------------------------------------------------- estatísticas

  async statistics(
    input: { start_date?: string; end_date?: string },
    timeZone = DEFAULT_TIME_ZONE,
  ): Promise<AdminStatisticsDto> {
    const { startDate, endDate } = resolveStatsPeriod(input, this.now(), timeZone)
    const from = sql`(${startDate}::date)::timestamp at time zone ${timeZone}`
    const to = sql`((${endDate}::date + 1))::timestamp at time zone ${timeZone}`
    const inRange = (col: typeof companies.createdAt | typeof users.createdAt | typeof messages.createdAt) =>
      and(gte(col, from), lt(col, to))

    const [[nc], [nu], [tc], [tu], [conn], perDay] = await Promise.all([
      this.db.select({ n: count() }).from(companies).where(inRange(companies.createdAt)),
      this.db.select({ n: count() }).from(users).where(inRange(users.createdAt)),
      this.db
        .select({ n: count(), active: sql<number>`count(*) filter (where ${companies.active})::int` })
        .from(companies),
      this.db.select({ n: count() }).from(users),
      this.db
        .select({ n: count(), open: sql<number>`count(*) filter (where ${connections.connectionState} = 'open')::int` })
        .from(connections)
        .where(isNull(connections.scheduledForDeletionAt)),
      this.db
        .select({
          day: sql<string>`to_char(${messages.createdAt} at time zone ${timeZone}, 'YYYY-MM-DD')`,
          inbound: sql<number>`count(*) filter (where ${messages.direction} = 'inbound')::int`,
          outbound: sql<number>`count(*) filter (where ${messages.direction} = 'outbound')::int`,
        })
        .from(messages)
        .where(inRange(messages.createdAt))
        .groupBy(sql`1`),
    ])
    const byDay = new Map(perDay.map((r) => [r.day, r]))
    const days = statsDays(startDate, endDate).map((date) => {
      const r = byDay.get(date)
      const inbound = r?.inbound ?? 0
      const outbound = r?.outbound ?? 0
      return { date, total: inbound + outbound, inbound, outbound }
    })
    const inbound = days.reduce((s, d) => s + d.inbound, 0)
    const outbound = days.reduce((s, d) => s + d.outbound, 0)
    return {
      start_date: startDate,
      end_date: endDate,
      time_zone: timeZone,
      new_companies: nc?.n ?? 0,
      new_users: nu?.n ?? 0,
      totals: {
        companies: tc?.n ?? 0,
        active_companies: tc?.active ?? 0,
        users: tu?.n ?? 0,
        connections: conn?.n ?? 0,
        connected_connections: conn?.open ?? 0,
      },
      messages: { total: inbound + outbound, inbound, outbound },
      messages_per_day: days,
    }
  }

  // ---------------------------------------------------------------- internos

  private assertPassword(password: string) {
    if (typeof password !== 'string' || password.length < ADMIN_PASSWORD_MIN)
      throw adminInvalid('password', `A senha deve ter no mínimo ${ADMIN_PASSWORD_MIN} caracteres`)
  }

  private async companyRow(id: string): Promise<CompanyRow> {
    if (!UUID_RE.test(id)) throw adminNotFound('Empresa')
    const [row] = await this.db.select().from(companies).where(eq(companies.id, id)).limit(1)
    if (!row) throw adminNotFound('Empresa')
    return row
  }

  private async companyDto(
    row: CompanyRow,
    owner: AdminCompanyDto['owner'],
    usersCount: number,
  ): Promise<AdminCompanyDto> {
    return {
      id: row.id,
      name: row.name,
      slug: row.slug,
      active: row.active,
      deactivated_at: iso(row.deactivatedAt),
      time_zone: row.timeZone,
      owner,
      owner_email: owner?.email ?? null,
      users_count: usersCount,
      limits: readCompanyLimits(row.settings),
      inbox_limits: readInboxLimits(row.settings),
      mass_dispatch_quota: await massDispatchQuota(this.db, row.id, this.now()),
      created_at: row.createdAt.toISOString(),
      updated_at: row.updatedAt.toISOString(),
    }
  }

  /** Uso atual de cada limite, contado como os módulos que o aplicam contam. */
  private async usage(companyId: string): Promise<Record<CompanyLimitKey, number>> {
    const n = (rows: Array<{ n: number }>) => rows[0]?.n ?? 0
    const [conns, agents, members, flowCount, hooks] = await Promise.all([
      this.db
        .select({ n: count() })
        .from(connections)
        .where(and(eq(connections.companyId, companyId), isNull(connections.scheduledForDeletionAt))),
      this.db.select({ n: count() }).from(aiAgents).where(eq(aiAgents.companyId, companyId)),
      this.db.select({ n: count() }).from(companyMembers).where(eq(companyMembers.companyId, companyId)),
      this.db.select({ n: count() }).from(flows).where(eq(flows.companyId, companyId)),
      this.db.select({ n: count() }).from(inboundWebhooks).where(eq(inboundWebhooks.companyId, companyId)),
    ])
    return { connections: n(conns), ai_agents: n(agents), members: n(members), flows: n(flowCount), webhooks: n(hooks) }
  }

  private async memberCounts(companyIds: string[]): Promise<Map<string, number>> {
    if (!companyIds.length) return new Map()
    const rows = await this.db
      .select({ id: companyMembers.companyId, n: count() })
      .from(companyMembers)
      .where(inArray(companyMembers.companyId, companyIds))
      .groupBy(companyMembers.companyId)
    return new Map(rows.map((r) => [r.id, r.n]))
  }

  private async membershipStats(userIds: string[]): Promise<Map<string, { companies: number; owns: boolean }>> {
    if (!userIds.length) return new Map()
    const rows = await this.db
      .select({ id: companyMembers.userId, n: count(), owns: sql<boolean>`bool_or(${companyMembers.role} = 'owner')` })
      .from(companyMembers)
      .where(inArray(companyMembers.userId, userIds))
      .groupBy(companyMembers.userId)
    return new Map(rows.map((r) => [r.id, { companies: r.n, owns: Boolean(r.owns) }]))
  }

  private userDto(
    u: typeof users.$inferSelect,
    personalWhatsapp: string | null,
    stats?: { companies: number; owns: boolean },
  ): AdminUserDto {
    const role = legacyRoleOf(u.systemRole, stats?.owns ?? false)
    return {
      id: u.id,
      name: u.name,
      email: u.email,
      system_role: u.systemRole,
      role,
      role_label: LEGACY_ROLE_LABELS[role],
      personal_whatsapp: personalWhatsapp,
      locale: u.locale,
      last_company_id: u.lastCompanyId,
      companies_count: stats?.companies ?? 0,
      created_at: u.createdAt.toISOString(),
      updated_at: u.updatedAt.toISOString(),
    }
  }

  /** Pausa as sessões WhatsApp da empresa desativada (como `CompanyService.deactivate`); falha numa sessão é ignorada. */
  private async pauseSessions(companyId: string): Promise<string[]> {
    const ids = await companySessionIds(companyId, this.opts.sessionsSources)
    if (ids.length && !this.opts.waGateway)
      this.opts.logger?.warn({ companyId }, 'company deactivated by admin without WaGateway: sessions not paused')
    const paused: string[] = []
    for (const id of ids) {
      if (!this.opts.waGateway) break
      try {
        await this.opts.waGateway.sessions.pause(id)
        paused.push(id)
      } catch (err) {
        this.opts.logger?.warn({ err, sessionId: id, companyId }, 'could not pause session of deactivated company')
      }
    }
    return paused
  }
}
