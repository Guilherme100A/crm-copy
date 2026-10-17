// Convites unificados (T22; 01 §5.15–16, 16 §3.5–3.6, §4, §5): `member` (entrar numa empresa) e `platform`
// (cadastrar-se já vinculado à empresa). O token só existe como SHA-256 no banco: obter o link ou reenviar GERA um
// token novo (o anterior deixa de valer). Reenvio: até 3 por dia (no fuso da empresa) e com intervalo mínimo.
import { and, asc, count, desc, eq, ilike, ne, sql } from 'drizzle-orm'
import {
  companies,
  companyMembers,
  invitations,
  users,
  type Database,
  type InvitationKind,
  type InvitationStoredStatus,
  type MemberRole,
} from '@crm/db'
import { hashPassword, type Logger, type Mailer } from '@crm/node-kit'
import { buildPageMeta, pageOffset, type PageMeta } from '@crm/shared'
import { companyLimit } from '../admin/limits'
import { isUniqueViolation } from '../auth/errors'
import type { AuditService } from '../platform/audit-service'
import type { SessionService } from '../platform/session-service'
import { generateSessionToken, hashToken } from '../platform/tokens'
import type { AuthUser } from '../platform/types'
import { TeamError } from '../team/errors'
import { notFound } from '../team/internal'

export const DEFAULT_INVITATION_TTL_DAYS = 7
export const DEFAULT_MAX_RESENDS_PER_DAY = 3
export const DEFAULT_RESEND_COOLDOWN_MS = 60_000

export type InvitationStatus = InvitationStoredStatus | 'expired'
export const LISTED_STATUSES = ['pending', 'accepted', 'declined', 'expired'] as const

export interface InvitationDto {
  id: string
  kind: InvitationKind
  email: string
  role: MemberRole
  status: InvitationStatus
  created_at: string
  updated_at: string
  expires_at: string
  can_resend: boolean
  resends_remaining_today: number
  invited_by: { id: string; name: string } | null
  company: { id: string; name: string; slug: string }
}

export interface PublicInvitationDto {
  kind: InvitationKind
  email: string
  role: MemberRole
  status: InvitationStatus
  expires_at: string
  company: { name: string; slug: string }
  invited_by: { name: string } | null
  /** O e-mail já tem conta (aceitar exige login) ou não (aceitar cria a conta). */
  user_exists: boolean
}

export interface InvitationServiceOptions {
  db: Database
  mailer: Mailer
  sessions: SessionService
  audit?: AuditService
  appName?: string
  webPublicUrl?: string
  ttlDays?: number
  maxResendsPerDay?: number
  resendCooldownMs?: number
  now?: () => Date
  logger?: Pick<Logger, 'warn'>
}

export interface Inviter {
  userId: string
  name: string
}

export interface AcceptResult {
  company: { id: string; name: string; slug: string }
  role: MemberRole
  user: { id: string; name: string; email: string }
  /** Só quando o aceite criou a conta: sessão nova para o cookie. */
  session?: { token: string; expiresAt: Date }
}

type Row = typeof invitations.$inferSelect & {
  companyName: string
  companySlug: string
  companyTimeZone: string
  inviterName: string | null
}

const rowColumns = {
  inv: invitations,
  companyName: companies.name,
  companySlug: companies.slug,
  companyTimeZone: companies.timeZone,
  inviterName: users.name,
}

/** `YYYY-MM-DD` de `date` no fuso dado. */
export function dayInTimeZone(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date)
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? ''
  return `${get('year')}-${get('month')}-${get('day')}`
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!)

export class InvitationService {
  private readonly db: Database
  private readonly opts: InvitationServiceOptions
  private readonly now: () => Date
  private readonly ttlMs: number
  private readonly maxResends: number
  private readonly cooldownMs: number

  constructor(opts: InvitationServiceOptions) {
    this.db = opts.db
    this.opts = opts
    this.now = opts.now ?? (() => new Date())
    this.ttlMs = (opts.ttlDays ?? DEFAULT_INVITATION_TTL_DAYS) * 86_400_000
    this.maxResends = opts.maxResendsPerDay ?? DEFAULT_MAX_RESENDS_PER_DAY
    this.cooldownMs = opts.resendCooldownMs ?? DEFAULT_RESEND_COOLDOWN_MS
  }

  linkFor(token: string): string {
    return `${(this.opts.webPublicUrl ?? 'http://localhost:5173').replace(/\/+$/, '')}/invitations/${encodeURIComponent(token)}`
  }

  /** Cria o convite e envia o e-mail. Já membro → `already_member`; pendente igual → `invitation_pending`. */
  async create(
    inviter: Inviter,
    companyId: string,
    input: { kind: InvitationKind; email: string; role: 'admin' | 'member' },
  ): Promise<{ invitation: InvitationDto; link: string }> {
    const email = input.email.trim().toLowerCase()
    const [member] = await this.db
      .select({ id: companyMembers.id })
      .from(companyMembers)
      .innerJoin(users, eq(users.id, companyMembers.userId))
      .where(and(eq(companyMembers.companyId, companyId), sql`lower(${users.email}) = ${email}`))
      .limit(1)
    if (member) throw new TeamError('conflict', 'Este e-mail já é membro da empresa', 'already_member')
    await this.assertMemberSlot(this.db, companyId)

    await this.expirePending(companyId, input.kind, email)
    const token = generateSessionToken()
    const now = this.now()
    let id: string
    try {
      const [row] = await this.db
        .insert(invitations)
        .values({
          companyId,
          kind: input.kind,
          email,
          role: input.role,
          tokenHash: hashToken(token),
          invitedByUserId: inviter.userId,
          expiresAt: new Date(now.getTime() + this.ttlMs),
          lastSentAt: now,
          createdAt: now,
          updatedAt: now,
        })
        .returning({ id: invitations.id })
      id = row!.id
    } catch (err) {
      if (isUniqueViolation(err, 'invitations_pending_uq'))
        throw new TeamError('conflict', 'Já existe um convite pendente para este e-mail', 'invitation_pending')
      throw err
    }
    const row = await this.requireRow(companyId, id)
    await this.sendEmail(row, token)
    return { invitation: this.toDto(row), link: this.linkFor(token) }
  }

  async list(
    companyId: string,
    query: { kind: InvitationKind; status?: InvitationStatus; search?: string; page: number; limit: number },
  ): Promise<{ items: InvitationDto[]; page: PageMeta; status_counts: Record<'total' | (typeof LISTED_STATUSES)[number], number> }> {
    const now = this.now()
    const base = and(eq(invitations.companyId, companyId), eq(invitations.kind, query.kind), ne(invitations.status, 'cancelled'))
    const search = query.search ? ilike(invitations.email, `%${query.search}%`) : undefined
    const expired = and(eq(invitations.status, 'pending'), sql`${invitations.expiresAt} <= ${now.toISOString()}::timestamptz`)
    const live = and(eq(invitations.status, 'pending'), sql`${invitations.expiresAt} > ${now.toISOString()}::timestamptz`)
    const statusWhere =
      query.status === 'expired' ? expired : query.status === 'pending' ? live : query.status ? eq(invitations.status, query.status) : undefined
    const where = and(base, search, statusWhere)

    const [total] = await this.db.select({ n: count() }).from(invitations).where(where)
    const rows = await this.db
      .select(rowColumns)
      .from(invitations)
      .innerJoin(companies, eq(companies.id, invitations.companyId))
      .leftJoin(users, eq(users.id, invitations.invitedByUserId))
      .where(where)
      .orderBy(desc(invitations.createdAt), asc(invitations.email))
      .limit(query.limit)
      .offset(pageOffset(query))

    const counts = await this.db
      .select({
        total: count(),
        pending: sql<number>`count(*) filter (where ${live})`,
        accepted: sql<number>`count(*) filter (where ${invitations.status} = 'accepted')`,
        declined: sql<number>`count(*) filter (where ${invitations.status} = 'declined')`,
        expired: sql<number>`count(*) filter (where ${expired})`,
      })
      .from(invitations)
      .where(and(base, search))
    const c = counts[0]
    return {
      items: rows.map((r) => this.toDto(flat(r))),
      page: buildPageMeta(query, { total: Number(total?.n ?? 0) }),
      status_counts: {
        total: Number(c?.total ?? 0),
        pending: Number(c?.pending ?? 0),
        accepted: Number(c?.accepted ?? 0),
        declined: Number(c?.declined ?? 0),
        expired: Number(c?.expired ?? 0),
      },
    }
  }

  async get(companyId: string, id: string): Promise<InvitationDto> {
    return this.toDto(await this.requireRow(companyId, id))
  }

  /** Reenvia (token novo + e-mail). Limite diário → `resend_limit`; intervalo mínimo → `resend_cooldown`. */
  async resend(companyId: string, id: string): Promise<{ invitation: InvitationDto; link: string }> {
    const row = await this.requirePending(companyId, id)
    const now = this.now()
    const today = dayInTimeZone(now, row.companyTimeZone)
    const used = row.resendsDay === today ? row.resendsToday : 0
    if (used >= this.maxResends)
      throw new TeamError('rate_limit', `Limite de ${this.maxResends} reenvios por dia atingido`, 'resend_limit', { resends_remaining_today: 0 })
    const wait = row.lastSentAt.getTime() + this.cooldownMs - now.getTime()
    if (wait > 0)
      throw new TeamError('rate_limit', 'Aguarde alguns minutos antes de reenviar', 'resend_cooldown', {
        resends_remaining_today: this.maxResends - used,
        retry_after_seconds: Math.ceil(wait / 1000),
      })
    const token = generateSessionToken()
    await this.db
      .update(invitations)
      .set({
        tokenHash: hashToken(token),
        resendsDay: today,
        resendsToday: used + 1,
        lastSentAt: now,
        expiresAt: new Date(now.getTime() + this.ttlMs),
        updatedAt: now,
      })
      .where(eq(invitations.id, id))
    const updated = await this.requireRow(companyId, id)
    await this.sendEmail(updated, token)
    return { invitation: this.toDto(updated), link: this.linkFor(token) }
  }

  /** Link para copiar: gera token novo (o do e-mail anterior deixa de valer). */
  async link(companyId: string, id: string): Promise<string> {
    await this.requirePending(companyId, id)
    const token = generateSessionToken()
    await this.db.update(invitations).set({ tokenHash: hashToken(token), updatedAt: this.now() }).where(eq(invitations.id, id))
    return this.linkFor(token)
  }

  async cancel(companyId: string, id: string): Promise<InvitationDto> {
    await this.requirePending(companyId, id)
    const now = this.now()
    await this.db.update(invitations).set({ status: 'cancelled', respondedAt: now, updatedAt: now }).where(eq(invitations.id, id))
    return this.toDto(await this.requireRow(companyId, id))
  }

  /** Dados públicos do convite pelo token (tela de aceite). Token desconhecido ou cancelado → 404. */
  async getByToken(token: string): Promise<PublicInvitationDto> {
    const row = await this.byToken(token)
    const dto = this.toDto(row)
    const [user] = await this.db.select({ id: users.id }).from(users).where(sql`lower(${users.email}) = ${row.email}`).limit(1)
    return {
      kind: row.kind,
      email: row.email,
      role: row.role,
      status: dto.status,
      expires_at: dto.expires_at,
      company: { name: row.companyName, slug: row.companySlug },
      invited_by: row.inviterName ? { name: row.inviterName } : null,
      user_exists: !!user,
    }
  }

  /**
   * Aceita: com usuário logado (o e-mail precisa ser o do convite) ou criando a conta (`signup`) quando o e-mail
   * ainda não existe. Cria a membership com o papel do convite e torna a empresa a ativa do usuário.
   */
  async accept(
    token: string,
    who: { user: Pick<AuthUser, 'id' | 'email' | 'name'> } | { signup: { name: string; password: string } } | null,
    meta: { userAgent?: string | null; ip?: string | null } = {},
  ): Promise<AcceptResult> {
    const row = await this.byToken(token)
    this.assertOpen(row)
    let userId: string
    let created = false
    if (who && 'user' in who) {
      if (who.user.email.trim().toLowerCase() !== row.email)
        throw new TeamError('forbidden', 'Este convite foi enviado para outro e-mail', 'invitation_email_mismatch')
      userId = who.user.id
    } else {
      const [existing] = await this.db.select({ id: users.id }).from(users).where(sql`lower(${users.email}) = ${row.email}`).limit(1)
      if (existing || !who) throw new TeamError('unauthorized', 'Entre na sua conta para aceitar o convite', 'login_required')
      await this.assertMemberSlot(this.db, row.companyId)
      const passwordHash = await hashPassword(who.signup.password)
      try {
        const [u] = await this.db.insert(users).values({ email: row.email, name: who.signup.name.trim(), passwordHash }).returning({ id: users.id })
        userId = u!.id
        created = true
      } catch (err) {
        if (isUniqueViolation(err)) throw new TeamError('unauthorized', 'Entre na sua conta para aceitar o convite', 'login_required')
        throw err
      }
    }

    const now = this.now()
    const role = await this.db.transaction(async (tx) => {
      // Trava o convite: dois aceites simultâneos não criam duas memberships.
      const [locked] = await tx.select({ status: invitations.status }).from(invitations).where(eq(invitations.id, row.id)).for('update')
      if (locked?.status !== 'pending') throw new TeamError('gone', 'Convite já respondido', 'invitation_gone')
      const [member] = await tx
        .select({ role: companyMembers.role })
        .from(companyMembers)
        .where(and(eq(companyMembers.companyId, row.companyId), eq(companyMembers.userId, userId)))
        .limit(1)
      if (!member) await this.assertMemberSlot(tx, row.companyId, true)
      if (!member) await tx.insert(companyMembers).values({ companyId: row.companyId, userId, role: row.role })
      await tx
        .update(invitations)
        .set({ status: 'accepted', respondedAt: now, acceptedByUserId: userId, updatedAt: now })
        .where(eq(invitations.id, row.id))
      await tx.update(users).set({ lastCompanyId: row.companyId, updatedAt: now }).where(eq(users.id, userId))
      return member?.role ?? row.role
    })
    await this.auditPublic(row, 'invitation.accept', userId)

    const [user] = await this.db.select({ id: users.id, name: users.name, email: users.email }).from(users).where(eq(users.id, userId)).limit(1)
    const result: AcceptResult = { company: { id: row.companyId, name: row.companyName, slug: row.companySlug }, role, user: user! }
    if (created) {
      const s = await this.opts.sessions.create(userId, meta)
      result.session = { token: s.token, expiresAt: s.expiresAt }
    }
    return result
  }

  async decline(token: string): Promise<PublicInvitationDto> {
    const row = await this.byToken(token)
    this.assertOpen(row)
    const now = this.now()
    await this.db
      .update(invitations)
      .set({ status: 'declined', respondedAt: now, updatedAt: now })
      .where(and(eq(invitations.id, row.id), eq(invitations.status, 'pending')))
    await this.auditPublic(row, 'invitation.decline', null)
    return this.getByToken(token)
  }

  toDto(row: Row): InvitationDto {
    const now = this.now()
    const status: InvitationStatus = row.status === 'pending' && row.expiresAt <= now ? 'expired' : row.status
    const used = row.resendsDay === dayInTimeZone(now, row.companyTimeZone) ? row.resendsToday : 0
    const remaining = status === 'pending' ? Math.max(0, this.maxResends - used) : 0
    const cooled = row.lastSentAt.getTime() + this.cooldownMs <= now.getTime()
    return {
      id: row.id,
      kind: row.kind,
      email: row.email,
      role: row.role,
      status,
      created_at: row.createdAt.toISOString(),
      updated_at: row.updatedAt.toISOString(),
      expires_at: row.expiresAt.toISOString(),
      can_resend: status === 'pending' && remaining > 0 && cooled,
      resends_remaining_today: remaining,
      invited_by: row.invitedByUserId && row.inviterName ? { id: row.invitedByUserId, name: row.inviterName } : null,
      company: { id: row.companyId, name: row.companyName, slug: row.companySlug },
    }
  }

  /** Convite pendente vencido não bloqueia um novo para o mesmo e-mail. */
  private async expirePending(companyId: string, kind: InvitationKind, email: string) {
    const now = this.now()
    await this.db
      .update(invitations)
      .set({ status: 'cancelled', respondedAt: now, updatedAt: now })
      .where(
        and(
          eq(invitations.companyId, companyId),
          eq(invitations.kind, kind),
          eq(invitations.email, email),
          eq(invitations.status, 'pending'),
          sql`${invitations.expiresAt} <= ${now.toISOString()}::timestamptz`,
        ),
      )
  }

  /**
   * Limite de membros da empresa (`settings.limits.members`, T95); sem limite não faz nada. `lock` serializa
   * aceites simultâneos da mesma empresa (dentro da transação do aceite).
   */
  private async assertMemberSlot(exec: Pick<Database, 'select' | 'execute'>, companyId: string, lock = false) {
    const limit = await companyLimit(exec, companyId, 'members')
    if (limit === null) return
    if (lock) await exec.execute(sql`select pg_advisory_xact_lock(hashtext(${`company_members:${companyId}`}))`)
    const [c] = await exec.select({ n: count() }).from(companyMembers).where(eq(companyMembers.companyId, companyId))
    const used = c?.n ?? 0
    if (used >= limit) throw new TeamError('limit_reached', 'Limite de membros da empresa atingido', undefined, { limit, used })
  }

  private assertOpen(row: Row) {
    if (row.status !== 'pending') throw new TeamError('gone', 'Convite já respondido', 'invitation_gone')
    if (row.expiresAt <= this.now()) throw new TeamError('gone', 'Convite expirado', 'invitation_expired')
  }

  private async byToken(token: string): Promise<Row> {
    if (!token || token.length > 200) throw notFound('Convite')
    const [r] = await this.db
      .select(rowColumns)
      .from(invitations)
      .innerJoin(companies, eq(companies.id, invitations.companyId))
      .leftJoin(users, eq(users.id, invitations.invitedByUserId))
      .where(eq(invitations.tokenHash, hashToken(token)))
      .limit(1)
    if (!r || r.inv.status === 'cancelled') throw notFound('Convite')
    return flat(r)
  }

  private async requireRow(companyId: string, id: string): Promise<Row> {
    const [r] = await this.db
      .select(rowColumns)
      .from(invitations)
      .innerJoin(companies, eq(companies.id, invitations.companyId))
      .leftJoin(users, eq(users.id, invitations.invitedByUserId))
      .where(and(eq(invitations.companyId, companyId), sql`${invitations.id}::text = ${id}`))
      .limit(1)
    if (!r) throw notFound('Convite')
    return flat(r)
  }

  private async requirePending(companyId: string, id: string): Promise<Row> {
    const row = await this.requireRow(companyId, id)
    if (row.status === 'cancelled') throw notFound('Convite')
    this.assertOpen(row)
    return row
  }

  private async sendEmail(row: Row, token: string) {
    const app = this.opts.appName ?? 'CRM'
    const link = this.linkFor(token)
    const who = row.inviterName ?? 'Alguém'
    const target = row.kind === 'member' ? `a equipe da empresa ${row.companyName}` : `o ${app} (empresa ${row.companyName})`
    try {
      await this.opts.mailer.send({
        to: row.email,
        subject: `${app}: convite de ${who}`,
        text: `${who} convidou você para ${target}.\n\nPara aceitar, acesse:\n${link}\n\nO convite vale até ${row.expiresAt.toISOString().slice(0, 10)}.`,
        html: `<p>${escapeHtml(who)} convidou você para ${escapeHtml(target)}.</p><p><a href="${escapeHtml(link)}">Aceitar convite</a></p><p>O convite vale até ${row.expiresAt.toISOString().slice(0, 10)}.</p>`,
      })
    } catch (err) {
      // O convite continua válido; o link pode ser copiado ou reenviado.
      this.opts.logger?.warn({ err, invitationId: row.id }, 'invitation email failed')
    }
  }

  /** Rotas públicas não passam pelo auditMiddleware; grava com o id do convite (nunca o token). */
  private async auditPublic(row: Row, action: string, actorUserId: string | null) {
    try {
      await this.opts.audit?.record({ companyId: row.companyId, actorUserId, action, targetType: 'invitation', targetId: row.id, detail: { kind: row.kind } })
    } catch (err) {
      this.opts.logger?.warn({ err, action }, 'failed to write audit log')
    }
  }
}

function flat(r: { inv: typeof invitations.$inferSelect; companyName: string; companySlug: string; companyTimeZone: string; inviterName: string | null }): Row {
  return { ...r.inv, companyName: r.companyName, companySlug: r.companySlug, companyTimeZone: r.companyTimeZone, inviterName: r.inviterName }
}
