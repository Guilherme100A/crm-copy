// Empresas (T22; 01 §5 e 16 §5): listar, criar, editar, desativar/reativar, trocar e sair.
// Quem não é membro recebe "não encontrada" (404, SPEC 1.4 nº 7). Desativar pausa as sessões WhatsApp da empresa.
import { and, asc, count, eq, ilike, or, sql } from 'drizzle-orm'
import { companies, companyMembers, users, type Database, type MemberRole, type SystemRole } from '@crm/db'
import type { Logger } from '@crm/node-kit'
import { DEFAULT_TIME_ZONE, buildPageMeta, pageOffset, type PageResponse, type PermissionKey } from '@crm/shared'
import type { WaGateway } from '@crm/wa-port'
import { isUniqueViolation } from '../auth/errors'
import { findMembership, permissionsOf } from '../platform/company-context'
import type { CompanyMember } from '../platform/types'
import type { RealtimePublisher } from '../realtime/publisher'
import { TeamError, forbidden, notFound } from '../team/errors'
import { companySessionIds, type CompanySessionsSource } from './sessions-source'
import { slugCandidate, slugify } from './slug'

/** Fusos aceitos (01 §3.2); fora da lista cai no padrão. */
export const COMPANY_TIME_ZONES = [
  'America/Sao_Paulo',
  'America/Fortaleza',
  'America/Manaus',
  'America/Belem',
  'America/Noronha',
  'America/Argentina/Buenos_Aires',
  'America/Santiago',
  'America/Bogota',
  'America/Lima',
  'America/Mexico_City',
  'America/New_York',
  'UTC',
] as const

export function normalizeTimeZone(tz: string | null | undefined): string {
  if (!tz) return DEFAULT_TIME_ZONE
  // Aceita o nome curto da referência (Buenos_Aires) para o IANA canônico.
  if (tz === 'America/Buenos_Aires') return 'America/Argentina/Buenos_Aires'
  return (COMPANY_TIME_ZONES as readonly string[]).includes(tz) ? tz : DEFAULT_TIME_ZONE
}

export interface Actor {
  userId: string
  systemRole: SystemRole
}

export interface CompanyDto {
  id: string
  name: string
  slug: string
  description: string | null
  active: boolean
  time_zone: string
  connection_status_emails_enabled: boolean
  deactivated_at: string | null
  created_at: string
  updated_at: string
}

export type CompanyWithRole = CompanyDto & { role: MemberRole }

export interface CreateCompanyInput {
  name: string
  slug?: string
  description?: string | null
  timeZone?: string
}

export interface UpdateCompanyInput {
  name?: string
  slug?: string
  description?: string | null
  timeZone?: string
  connectionStatusEmailsEnabled?: boolean
  active?: boolean
}

export interface CompanyServiceOptions {
  db: Database
  waGateway?: WaGateway
  /** Fontes extras de sessões WhatsApp da empresa (além das registradas). */
  sessionsSources?: readonly CompanySessionsSource[]
  publisher?: RealtimePublisher
  logger?: Pick<Logger, 'warn'>
  now?: () => Date
}

type CompanyRow = typeof companies.$inferSelect

export function toCompanyDto(row: CompanyRow): CompanyDto {
  const settings = (row.settings ?? {}) as Record<string, unknown>
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    description: typeof settings.description === 'string' ? settings.description : null,
    active: row.active,
    time_zone: row.timeZone,
    connection_status_emails_enabled: settings.connection_status_emails_enabled !== false,
    deactivated_at: row.deactivatedAt?.toISOString() ?? null,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  }
}

export class CompanyService {
  private readonly db: Database
  private readonly opts: CompanyServiceOptions
  private readonly now: () => Date

  constructor(opts: CompanyServiceOptions) {
    this.db = opts.db
    this.opts = opts
    this.now = opts.now ?? (() => new Date())
  }

  /** Empresas do usuário (inclusive inativas), na ordem de entrada. */
  async list(userId: string, query: { page: number; limit: number; search?: string }): Promise<PageResponse<CompanyWithRole>> {
    const where = and(
      eq(companyMembers.userId, userId),
      query.search ? or(ilike(companies.name, `%${query.search}%`), ilike(companies.slug, `%${query.search}%`)) : undefined,
    )
    const [total] = await this.db.select({ n: count() }).from(companyMembers).innerJoin(companies, eq(companies.id, companyMembers.companyId)).where(where)
    const rows = await this.db
      .select({ company: companies, role: companyMembers.role })
      .from(companyMembers)
      .innerJoin(companies, eq(companies.id, companyMembers.companyId))
      .where(where)
      .orderBy(asc(companyMembers.createdAt), asc(companies.name))
      .limit(query.limit)
      .offset(pageOffset(query))
    return { items: rows.map((r) => ({ ...toCompanyDto(r.company), role: r.role })), page: buildPageMeta(query, { total: Number(total?.n ?? 0) }) }
  }

  async get(actor: Actor, companyId: string): Promise<CompanyWithRole> {
    const { member } = await this.membership(actor, companyId)
    return { ...toCompanyDto(await this.row(companyId)), role: member.role }
  }

  /** Cria a empresa com o criador como `owner`. Suporte (acesso temporário) não cria empresas. */
  async create(actor: Actor, input: CreateCompanyInput): Promise<CompanyWithRole> {
    if (actor.systemRole === 'support') throw forbidden('Usuários de suporte não criam empresas')
    const name = input.name.trim()
    const settings: Record<string, unknown> = { connection_status_emails_enabled: true }
    if (input.description?.trim()) settings.description = input.description.trim()
    const timeZone = normalizeTimeZone(input.timeZone)

    const explicit = input.slug !== undefined
    const base = explicit ? input.slug! : slugify(name)
    for (let n = 1; n <= 50; n++) {
      const slug = slugCandidate(base, n)
      try {
        const row = await this.db.transaction(async (tx) => {
          const [company] = await tx.insert(companies).values({ name, slug, timeZone, settings }).returning()
          await tx.insert(companyMembers).values({ companyId: company!.id, userId: actor.userId, role: 'owner' })
          return company!
        })
        return { ...toCompanyDto(row), role: 'owner' }
      } catch (err) {
        if (!isUniqueViolation(err, 'companies_slug_uq')) throw err
        if (explicit) throw new TeamError('conflict', 'Slug já está em uso', 'slug_taken', { fields: [{ path: 'slug', message: 'Slug já está em uso' }] })
      }
    }
    throw new TeamError('conflict', 'Não foi possível gerar um slug único', 'slug_taken')
  }

  /**
   * Edita a empresa (`settings.accounts.edit`). Fuso: só owner/admin da empresa ou admin da plataforma.
   * `active` (desativar/reativar) só o owner.
   */
  async update(actor: Actor, companyId: string, input: UpdateCompanyInput): Promise<CompanyWithRole> {
    const { member, perms } = await this.membership(actor, companyId)
    if (input.active !== undefined) {
      if (member.role !== 'owner') throw forbidden('Só o proprietário ativa ou desativa a empresa')
      if (input.active === false) {
        await this.deactivate(actor, companyId)
      } else {
        await this.db.update(companies).set({ active: true, deactivatedAt: null, updatedAt: this.now() }).where(eq(companies.id, companyId))
      }
    }
    const fields = Object.keys(input).filter((k) => k !== 'active' && input[k as keyof UpdateCompanyInput] !== undefined)
    if (fields.length > 0) {
      if (!perms.has('settings.accounts.edit')) throw forbidden()
      if (input.timeZone !== undefined && member.role === 'member' && actor.systemRole !== 'platform_admin')
        throw forbidden('Só o proprietário ou um administrador altera o fuso horário')
      const current = await this.row(companyId)
      const settings = { ...((current.settings ?? {}) as Record<string, unknown>) }
      if (input.description !== undefined) {
        if (input.description?.trim()) settings.description = input.description.trim()
        else delete settings.description
      }
      if (input.connectionStatusEmailsEnabled !== undefined) settings.connection_status_emails_enabled = input.connectionStatusEmailsEnabled
      try {
        await this.db
          .update(companies)
          .set({
            ...(input.name !== undefined ? { name: input.name.trim() } : {}),
            ...(input.slug !== undefined ? { slug: input.slug } : {}),
            ...(input.timeZone !== undefined ? { timeZone: normalizeTimeZone(input.timeZone) } : {}),
            settings,
            updatedAt: this.now(),
          })
          .where(eq(companies.id, companyId))
      } catch (err) {
        if (isUniqueViolation(err, 'companies_slug_uq'))
          throw new TeamError('conflict', 'Slug já está em uso', 'slug_taken', { fields: [{ path: 'slug', message: 'Slug já está em uso' }] })
        throw err
      }
    }
    const row = await this.row(companyId)
    await this.publishUpdated(row, [...fields, ...(input.active !== undefined ? ['active'] : [])])
    return { ...toCompanyDto(row), role: member.role }
  }

  /**
   * Desativa (soft): bloqueia o acesso dos membros e pausa as sessões WhatsApp da empresa. Dados não são excluídos.
   * Sessão que não pode pausar (já pausada/desconectada/inexistente) é ignorada.
   */
  async deactivate(actor: Actor, companyId: string): Promise<{ company: CompanyWithRole; pausedSessionIds: string[] }> {
    const { member } = await this.membership(actor, companyId)
    if (member.role !== 'owner') throw forbidden('Só o proprietário desativa a empresa')
    const now = this.now()
    await this.db
      .update(companies)
      .set({ active: false, deactivatedAt: sql`coalesce(${companies.deactivatedAt}, ${now.toISOString()}::timestamptz)`, updatedAt: now })
      .where(eq(companies.id, companyId))

    const paused: string[] = []
    const ids = await companySessionIds(companyId, this.opts.sessionsSources)
    if (ids.length && !this.opts.waGateway) this.opts.logger?.warn({ companyId }, 'company deactivated without WaGateway: sessions not paused')
    for (const id of ids) {
      if (!this.opts.waGateway) break
      try {
        await this.opts.waGateway.sessions.pause(id)
        paused.push(id)
      } catch (err) {
        this.opts.logger?.warn({ err, sessionId: id, companyId }, 'could not pause session of deactivated company')
      }
    }
    const row = await this.row(companyId)
    await this.publishUpdated(row, ['active'])
    return { company: { ...toCompanyDto(row), role: member.role }, pausedSessionIds: paused }
  }

  /** Torna a empresa a ativa do usuário. */
  async switch(actor: Actor, companyId: string): Promise<{ company: CompanyWithRole; role: MemberRole; permissions: PermissionKey[] }> {
    const { member, perms } = await this.membership(actor, companyId)
    await this.db.update(users).set({ lastCompanyId: companyId, updatedAt: this.now() }).where(eq(users.id, actor.userId))
    return { company: { ...toCompanyDto(await this.row(companyId)), role: member.role }, role: member.role, permissions: [...perms] }
  }

  /** Sai da empresa. O owner precisa transferir a propriedade antes. */
  async leave(actor: Actor, companyId: string): Promise<void> {
    const { member } = await this.membership(actor, companyId)
    if (member.role === 'owner')
      throw new TeamError('conflict', 'Transfira a propriedade antes de sair da empresa', 'owner_must_transfer')
    await this.db.transaction(async (tx) => {
      await tx.delete(companyMembers).where(eq(companyMembers.id, member.id))
      await tx
        .update(users)
        .set({ lastCompanyId: null })
        .where(and(eq(users.id, actor.userId), eq(users.lastCompanyId, companyId)))
    })
    await this.opts.publisher
      ?.publish(companyId, 'member.permissions_changed', { company_id: companyId, user_id: actor.userId, permission_keys: null }, { userId: actor.userId })
      .catch((err: unknown) => this.opts.logger?.warn({ err }, 'realtime publish failed'))
  }

  /** `true` se a empresa existe e está ativa. */
  async isActive(companyId: string): Promise<boolean> {
    const [row] = await this.db.select({ active: companies.active }).from(companies).where(eq(companies.id, companyId)).limit(1)
    return row?.active === true
  }

  private async membership(actor: Actor, companyId: string): Promise<{ member: CompanyMember; perms: ReadonlySet<PermissionKey> }> {
    const member = await findMembership(this.db, actor.userId, companyId)
    if (!member) throw notFound('Empresa')
    return { member, perms: permissionsOf(member, { systemRole: actor.systemRole }) }
  }

  private async row(companyId: string): Promise<CompanyRow> {
    const [row] = await this.db.select().from(companies).where(eq(companies.id, companyId)).limit(1)
    if (!row) throw notFound('Empresa')
    return row
  }

  private async publishUpdated(row: CompanyRow, fields: string[]) {
    if (!this.opts.publisher || fields.length === 0) return
    await this.opts.publisher
      .publish(row.id, 'company.updated', { company_id: row.id, id: row.id, name: row.name, fields })
      .catch((err: unknown) => this.opts.logger?.warn({ err }, 'realtime publish failed'))
  }
}
