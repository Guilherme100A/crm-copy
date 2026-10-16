// Contas, sessões, perfil e senha (SPEC T15; feature 01 §3, §5, §6).
import { randomBytes } from 'node:crypto'
import { and, asc, eq, gt, isNull, sql } from 'drizzle-orm'
import { apiTokens, companies, companyMembers, passwordResets, userProfiles, users, type Database, type MemberRole } from '@crm/db'
import { hashPassword, verifyPassword, type BlobStore, type Mailer } from '@crm/node-kit'
import { DEFAULT_LOCALE, type Locale, type User } from '@crm/shared'
import { apiTokenDisplayPrefix, generateApiToken, generateSessionToken, hashToken } from '../platform/tokens'
import type { SessionService } from '../platform/session-service'
import { AuthError, isUniqueViolation } from './errors'
import { AVATAR_MAX_BYTES, detectImageMime, isAvatarMime } from './image'
import { DEFAULT_COMPANY_NAME, normalizeEmail, normalizeLocale, normalizeReferralCode, normalizeWhatsapp } from './normalize'

export const PASSWORD_RESET_TTL_MS = 60 * 60 * 1000
export const AVATAR_URL_PREFIX = '/api/auth/avatars/'

/** Usuário no fio: `User` de @crm/shared + `personal_whatsapp`. */
export type UserDto = User & { personal_whatsapp: string | null }

export interface CompanySummary {
  id: string
  name: string
  slug: string
  role: MemberRole
}

export interface AuthServiceOptions {
  db: Database
  sessions: SessionService
  mailer: Mailer
  blobStore: BlobStore
  /** Nome do produto nos e-mails (`APP_NAME`). */
  appName: string
  /** Base dos links enviados por e-mail (`WEB_PUBLIC_URL`). */
  webPublicUrl: string
  resetTtlMs?: number
  now?: () => Date
}

export interface RegisterInput {
  name: string
  email: string
  password: string
  personalWhatsapp?: string | null
  referralCode?: unknown
}

export interface UpdateProfileInput {
  name?: string
  email?: string
  locale?: unknown
  personalWhatsapp?: string | null
  currentPassword?: string
  password?: string
}

export interface LoginResult {
  user: UserDto
  companies: CompanySummary[]
  token: string
  sessionId: string
  expiresAt: Date
}

export type ResetTokenStatus = { valid: true } | { valid: false; reason: 'invalid' | 'expired' | 'used' }

// Hash fixo para gastar o mesmo tempo quando o e-mail não existe (não revela existência da conta).
let dummyHash: Promise<string> | undefined
const getDummyHash = () => (dummyHash ??= hashPassword(randomBytes(16).toString('hex')))

const userColumns = {
  id: users.id,
  email: users.email,
  name: users.name,
  systemRole: users.systemRole,
  locale: users.locale,
  avatarKey: users.avatarKey,
  lastCompanyId: users.lastCompanyId,
  createdAt: users.createdAt,
  personalWhatsapp: userProfiles.personalWhatsapp,
}

type UserRow = {
  id: string
  email: string
  name: string
  systemRole: User['system_role']
  locale: string
  avatarKey: string | null
  lastCompanyId: string | null
  createdAt: Date
  personalWhatsapp: string | null
}

export function toUserDto(row: UserRow): UserDto {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    system_role: row.systemRole,
    locale: normalizeLocale(row.locale),
    avatar_url: row.avatarKey ? `${AVATAR_URL_PREFIX}${row.avatarKey}` : null,
    last_company_id: row.lastCompanyId,
    personal_whatsapp: row.personalWhatsapp,
    created_at: row.createdAt.toISOString(),
  }
}

function companySlug(): string {
  return `minha-empresa-${randomBytes(4).toString('hex')}`
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!)
}

export class AuthService {
  private readonly db: Database
  private readonly sessions: SessionService
  private readonly mailer: Mailer
  private readonly blobStore: BlobStore
  private readonly appName: string
  private readonly webPublicUrl: string
  private readonly resetTtlMs: number
  private readonly now: () => Date

  constructor(opts: AuthServiceOptions) {
    this.db = opts.db
    this.sessions = opts.sessions
    this.mailer = opts.mailer
    this.blobStore = opts.blobStore
    this.appName = opts.appName
    this.webPublicUrl = opts.webPublicUrl.replace(/\/+$/, '')
    this.resetTtlMs = opts.resetTtlMs ?? PASSWORD_RESET_TTL_MS
    this.now = opts.now ?? (() => new Date())
  }

  // ---------- leitura ----------

  async getUser(userId: string): Promise<UserDto> {
    const [row] = await this.db
      .select(userColumns)
      .from(users)
      .leftJoin(userProfiles, eq(userProfiles.userId, users.id))
      .where(eq(users.id, userId))
      .limit(1)
    if (!row) throw new AuthError('user_not_found')
    return toUserDto(row)
  }

  async listCompanies(userId: string): Promise<CompanySummary[]> {
    return this.db
      .select({ id: companies.id, name: companies.name, slug: companies.slug, role: companyMembers.role })
      .from(companyMembers)
      .innerJoin(companies, eq(companies.id, companyMembers.companyId))
      .where(eq(companyMembers.userId, userId))
      .orderBy(asc(companyMembers.createdAt), asc(companies.name))
  }

  // ---------- login ----------

  /** Credenciais inválidas (e-mail inexistente ou senha errada) → `AuthError('invalid_credentials')`, sempre igual. */
  async login(email: string, password: string, meta: { userAgent?: string | null; ip?: string | null } = {}): Promise<LoginResult> {
    const [row] = await this.db
      .select({ id: users.id, passwordHash: users.passwordHash })
      .from(users)
      .where(sql`lower(${users.email}) = ${normalizeEmail(email)}`)
      .limit(1)
    const ok = await verifyPassword(row?.passwordHash ?? (await getDummyHash()), password)
    if (!row || !ok) throw new AuthError('invalid_credentials', 'E-mail ou senha inválidos')
    const session = await this.sessions.create(row.id, meta)
    return {
      user: await this.getUser(row.id),
      companies: await this.listCompanies(row.id),
      token: session.token,
      sessionId: session.sessionId,
      expiresAt: session.expiresAt,
    }
  }

  // ---------- cadastro ----------

  /** Cria usuário (`system_role=user`), a empresa "Minha empresa" e o vínculo `owner`. E-mail repetido → `email_taken`. */
  async register(input: RegisterInput): Promise<{ user: UserDto; companyId: string }> {
    const email = normalizeEmail(input.email)
    const passwordHash = await hashPassword(input.password)
    const [taken] = await this.db.select({ id: users.id }).from(users).where(sql`lower(${users.email}) = ${email}`).limit(1)
    if (taken) throw new AuthError('email_taken', 'E-mail já cadastrado')
    let created: { userId: string; companyId: string }
    try {
      created = await this.db.transaction(async (tx) => {
        const [user] = await tx
          .insert(users)
          .values({ email, passwordHash, name: input.name.trim(), systemRole: 'user', locale: DEFAULT_LOCALE })
          .returning({ id: users.id })
        const [company] = await tx.insert(companies).values({ name: DEFAULT_COMPANY_NAME, slug: companySlug() }).returning({ id: companies.id })
        await tx.insert(companyMembers).values({ companyId: company!.id, userId: user!.id, role: 'owner' })
        await tx.update(users).set({ lastCompanyId: company!.id }).where(eq(users.id, user!.id))
        await tx.insert(userProfiles).values({
          userId: user!.id,
          personalWhatsapp: normalizeWhatsapp(input.personalWhatsapp),
          referredByCode: normalizeReferralCode(input.referralCode),
        })
        return { userId: user!.id, companyId: company!.id }
      })
    } catch (err) {
      if (isUniqueViolation(err, 'users_email_lower_uq')) throw new AuthError('email_taken', 'E-mail já cadastrado')
      throw err
    }
    return { user: await this.getUser(created.userId), companyId: created.companyId }
  }

  // ---------- perfil ----------

  /**
   * Atualiza nome, e-mail, locale, WhatsApp e senha. Trocar e-mail (comparação sem caixa) ou senha exige
   * `currentPassword` correto, senão `current_password_invalid`. Locale inválido vira `pt-BR`.
   */
  async updateProfile(userId: string, input: UpdateProfileInput): Promise<UserDto> {
    const [current] = await this.db
      .select({ email: users.email, passwordHash: users.passwordHash })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1)
    if (!current) throw new AuthError('user_not_found')

    const patch: { name?: string; email?: string; locale?: Locale; passwordHash?: string; updatedAt: Date } = { updatedAt: this.now() }
    if (input.name !== undefined) patch.name = input.name.trim()
    if (input.locale !== undefined) patch.locale = normalizeLocale(input.locale)
    const newEmail = input.email !== undefined ? normalizeEmail(input.email) : undefined
    const emailChanged = newEmail !== undefined && newEmail !== normalizeEmail(current.email)
    if (emailChanged || input.password !== undefined) {
      const ok = input.currentPassword ? await verifyPassword(current.passwordHash, input.currentPassword) : false
      if (!ok) throw new AuthError('current_password_invalid', 'A senha atual não corresponde')
    }
    if (emailChanged) patch.email = newEmail
    if (input.password !== undefined) patch.passwordHash = await hashPassword(input.password)

    try {
      await this.db.update(users).set(patch).where(eq(users.id, userId))
    } catch (err) {
      if (isUniqueViolation(err, 'users_email_lower_uq')) throw new AuthError('email_taken', 'E-mail já cadastrado')
      throw err
    }
    if (input.personalWhatsapp !== undefined) {
      const personalWhatsapp = normalizeWhatsapp(input.personalWhatsapp)
      await this.db
        .insert(userProfiles)
        .values({ userId, personalWhatsapp })
        .onConflictDoUpdate({ target: userProfiles.userId, set: { personalWhatsapp, updatedAt: this.now() } })
    }
    return this.getUser(userId)
  }

  // ---------- avatar ----------

  /** jpeg/png/webp (pelos magic bytes) até 5 MB; outro tipo → `unsupported_media`; maior → `payload_too_large`. */
  async setAvatar(userId: string, bytes: Uint8Array): Promise<UserDto> {
    if (bytes.byteLength > AVATAR_MAX_BYTES) throw new AuthError('payload_too_large', 'Imagem acima de 5 MB')
    const mime = detectImageMime(bytes)
    if (!isAvatarMime(mime)) throw new AuthError('unsupported_media', 'Use uma imagem JPEG, PNG ou WebP')
    const blob = await this.blobStore.put(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength), mime)
    await this.db.update(users).set({ avatarKey: blob.key, updatedAt: this.now() }).where(eq(users.id, userId))
    return this.getUser(userId)
  }

  async removeAvatar(userId: string): Promise<UserDto> {
    // O blob não é apagado: o armazenamento é por conteúdo e pode ser compartilhado.
    await this.db.update(users).set({ avatarKey: null, updatedAt: this.now() }).where(eq(users.id, userId))
    return this.getUser(userId)
  }

  /** Bytes e mime de um avatar em uso, ou `null`. */
  async readAvatar(key: string): Promise<{ bytes: Buffer; mime: string } | null> {
    const [inUse] = await this.db.select({ id: users.id }).from(users).where(eq(users.avatarKey, key)).limit(1)
    if (!inUse) return null
    const [bytes, head] = await Promise.all([this.blobStore.get(key), this.blobStore.head(key)])
    return bytes && head ? { bytes, mime: head.mime } : null
  }

  // ---------- redefinição de senha ----------

  /** Sempre resolve sem revelar se o e-mail existe; para conta existente, grava o token e envia o e-mail. */
  async requestPasswordReset(email: string, meta: { ip?: string | null } = {}): Promise<void> {
    const [user] = await this.db
      .select({ id: users.id, email: users.email, name: users.name })
      .from(users)
      .where(sql`lower(${users.email}) = ${normalizeEmail(email)}`)
      .limit(1)
    if (!user) return
    const token = generateSessionToken()
    const now = this.now()
    await this.db.insert(passwordResets).values({
      userId: user.id,
      tokenHash: hashToken(token),
      expiresAt: new Date(now.getTime() + this.resetTtlMs),
      ip: meta.ip ?? null,
    })
    const link = `${this.webPublicUrl}/reset-password?token=${encodeURIComponent(token)}`
    const app = this.appName
    await this.mailer.send({
      to: user.email,
      subject: `${app}: redefinição de senha`,
      text: `Olá, ${user.name}.\n\nPara criar uma nova senha no ${app}, acesse:\n${link}\n\nO link vale por ${Math.round(this.resetTtlMs / 60000)} minutos e pode ser usado uma vez. Se você não pediu, ignore este e-mail.`,
      html: `<p>Olá, ${escapeHtml(user.name)}.</p><p>Para criar uma nova senha no ${escapeHtml(app)}, clique no link abaixo:</p><p><a href="${escapeHtml(link)}">${escapeHtml(link)}</a></p><p>O link vale por ${Math.round(this.resetTtlMs / 60000)} minutos e pode ser usado uma vez. Se você não pediu, ignore este e-mail.</p>`,
    })
  }

  async checkPasswordReset(token: string): Promise<ResetTokenStatus> {
    const [row] = await this.db
      .select({ expiresAt: passwordResets.expiresAt, usedAt: passwordResets.usedAt })
      .from(passwordResets)
      .where(eq(passwordResets.tokenHash, hashToken(token)))
      .limit(1)
    if (!row) return { valid: false, reason: 'invalid' }
    if (row.usedAt) return { valid: false, reason: 'used' }
    if (row.expiresAt.getTime() <= this.now().getTime()) return { valid: false, reason: 'expired' }
    return { valid: true }
  }

  /** Consome o token (uma vez), troca a senha e revoga todas as sessões. Token inválido/usado/expirado → `reset_token_gone`. */
  async completePasswordReset(token: string, password: string): Promise<void> {
    const passwordHash = await hashPassword(password)
    const now = this.now()
    const userId = await this.db.transaction(async (tx) => {
      const [row] = await tx
        .update(passwordResets)
        .set({ usedAt: now })
        .where(and(eq(passwordResets.tokenHash, hashToken(token)), isNull(passwordResets.usedAt), gt(passwordResets.expiresAt, now)))
        .returning({ userId: passwordResets.userId })
      if (!row) return null
      await tx.update(users).set({ passwordHash, updatedAt: now }).where(eq(users.id, row.userId))
      return row.userId
    })
    if (!userId) throw new AuthError('reset_token_gone', 'Link de redefinição inválido ou expirado')
    await this.sessions.revokeAllForUser(userId)
  }

  // ---------- tokens de API ----------

  /** Cria um token `crm_pat_…` da empresa. Só owner/admin. O token cru só é devolvido aqui. */
  async createApiToken(input: { companyId: string; userId: string; role: MemberRole | null; name: string; expiresAt?: Date | null }) {
    if (input.role !== 'owner' && input.role !== 'admin') throw new AuthError('forbidden', 'Apenas proprietário ou administrador')
    const token = generateApiToken()
    const [row] = await this.db
      .insert(apiTokens)
      .values({
        companyId: input.companyId,
        createdByUserId: input.userId,
        name: input.name.trim(),
        tokenHash: hashToken(token),
        tokenPrefix: apiTokenDisplayPrefix(token),
        expiresAt: input.expiresAt ?? null,
      })
      .returning({ id: apiTokens.id, name: apiTokens.name, tokenPrefix: apiTokens.tokenPrefix, expiresAt: apiTokens.expiresAt, createdAt: apiTokens.createdAt })
    return {
      id: row!.id,
      name: row!.name,
      token,
      token_prefix: row!.tokenPrefix,
      expires_at: row!.expiresAt?.toISOString() ?? null,
      created_at: row!.createdAt.toISOString(),
    }
  }
}
