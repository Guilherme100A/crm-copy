// Rotas de autenticação, cadastro, perfil e senha (SPEC T15; feature 01 §6). Corpo em snake_case; o envelope
// `{ user: {…} }` do produto de referência também é aceito.
import { Hono, type Context } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { z } from 'zod'
import { AVATAR_MAX_BYTES, AuthError, AuthService, type AuthErrorCode } from '@crm/core'
import { createMailer, FsBlobStore, type BlobStore, type Mailer } from '@crm/node-kit'
import { emailSchema, passwordSchema } from '@crm/shared'
import { setAudit } from '../../middleware/audit'
import { clientIp, getCompanyCtx, getCtx } from '../../lib/context'
import { clearSessionCookie, setSessionCookie } from '../../lib/cookies'
import { ApiError } from '../../lib/errors'
import { RateLimiter } from '../../lib/rate-limiter'
import type { AppEnv, ResolvedDeps } from '../../lib/types'
import { validate } from '../../lib/validate'

declare module '../../lib/types' {
  interface AppDeps {
    /** E-mails transacionais (default: `createMailer()` conforme `MAIL_TRANSPORT`). */
    mailer?: Mailer
    /** Armazenamento de avatares (default: `new FsBlobStore()` em `STORAGE_DIR`). */
    blobStore?: BlobStore
    /** Nome do produto nos e-mails (default `APP_NAME` ou `CRM`). */
    appName?: string
    /** Base dos links enviados por e-mail (default `WEB_PUBLIC_URL` ou `http://localhost:5173`). */
    webPublicUrl?: string
  }
}

export const LOGIN_MAX_FAILURES = 10
export const LOGIN_WINDOW_MS = 15 * 60 * 1000
const AVATAR_KEY_RE = /^[a-f0-9]{64}$/

/** Aceita `{ user: {…} }` (produto de referência) ou o corpo direto. */
const unwrapUser = (v: unknown) =>
  v && typeof v === 'object' && !Array.isArray(v) && 'user' in v && typeof (v as { user: unknown }).user === 'object'
    ? { ...(v as { user: object }).user, ...('rewardful_referral' in v ? { rewardful_referral: (v as { rewardful_referral: unknown }).rewardful_referral } : {}) }
    : v

const confirmMatches = (d: { password?: string; password_confirmation?: string }) =>
  d.password === undefined || d.password === d.password_confirmation
const confirmIssue = { message: 'As senhas não coincidem', path: ['password_confirmation'] }

const loginSchema = z.object({ email: z.string().trim().min(1).max(254), password: z.string().min(1).max(200) })

const registerSchema = z.preprocess(
  unwrapUser,
  z
    .object({
      name: z.string().trim().min(1).max(120),
      email: emailSchema,
      password: passwordSchema,
      password_confirmation: z.string(),
      personal_whatsapp: z.string().max(40).nullish(),
      referral_code: z.unknown().optional(),
      rewardful_referral: z.unknown().optional(),
    })
    .refine(confirmMatches, confirmIssue),
)

const profileSchema = z.preprocess(
  unwrapUser,
  z
    .object({
      name: z.string().trim().min(1).max(120).optional(),
      email: emailSchema.optional(),
      // Qualquer valor: inválido é normalizado para pt-BR (AC-T15-05).
      locale: z.unknown().optional(),
      personal_whatsapp: z.string().max(40).nullish(),
      current_password: z.string().max(200).optional(),
      password: passwordSchema.optional(),
      password_confirmation: z.string().optional(),
    })
    .refine(confirmMatches, confirmIssue),
)

const resetRequestSchema = z.object({ email: z.string().trim().min(1).max(254) })
const resetCompleteSchema = z.object({ password: passwordSchema, password_confirmation: z.string() }).refine(confirmMatches, confirmIssue)
const apiTokenSchema = z.object({ name: z.string().trim().min(1).max(120), expires_at: z.iso.datetime({ offset: true }).nullish() })

function toApiError(err: unknown): unknown {
  if (!(err instanceof AuthError)) return err
  const map: Record<AuthErrorCode, () => ApiError> = {
    invalid_credentials: () => new ApiError('UNAUTHORIZED', err.message),
    email_taken: () => new ApiError('CONFLICT', err.message, { fields: [{ path: 'email', message: err.message }] }),
    current_password_invalid: () =>
      new ApiError('VALIDATION_ERROR', err.message, {
        error_code: 'current_password_invalid',
        fields: [{ path: 'current_password', message: err.message }],
      }),
    reset_token_gone: () => new ApiError('GONE', err.message),
    user_not_found: () => new ApiError('UNAUTHORIZED', 'Não autenticado'),
    unsupported_media: () => new ApiError('UNSUPPORTED_MEDIA', err.message),
    payload_too_large: () => new ApiError('PAYLOAD_TOO_LARGE', err.message),
    forbidden: () => new ApiError('FORBIDDEN', err.message),
  }
  return map[err.code]()
}

async function run<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (err) {
    throw toApiError(err)
  }
}

function sessionUserId(c: Context<AppEnv>): string {
  const ctx = getCtx(c)
  if (ctx.auth.kind !== 'session' || !ctx.user) throw new ApiError('FORBIDDEN', 'Disponível apenas para sessões de usuário')
  return ctx.user.id
}

export function authRoutes(deps: ResolvedDeps) {
  const cookieSecure = deps.cookieSecure ?? process.env.NODE_ENV === 'production'
  const service = new AuthService({
    db: deps.db,
    sessions: deps.sessions,
    mailer: deps.mailer ?? createMailer(),
    blobStore: deps.blobStore ?? new FsBlobStore(),
    appName: deps.appName ?? (process.env.APP_NAME || 'CRM'),
    webPublicUrl: deps.webPublicUrl ?? (process.env.WEB_PUBLIC_URL || 'http://localhost:5173'),
  })
  const loginLimiter = new RateLimiter({ redis: deps.redis, limit: LOGIN_MAX_FAILURES, windowMs: LOGIN_WINDOW_MS, prefix: 'crm:rl:login' })
  const ip = (c: Context<AppEnv>) => clientIp(c, deps.trustProxy)

  const app = new Hono<AppEnv>()

  // ---------- login / logout ----------

  app.post('/api/auth/login', validate('json', loginSchema), async (c) => {
    const { email, password } = c.req.valid('json')
    const key = `${ip(c) ?? 'unknown'}:${email.toLowerCase()}`
    const state = await loginLimiter.peek(key)
    if (state.count >= LOGIN_MAX_FAILURES) {
      c.header('Retry-After', String(Math.max(1, Math.ceil(state.resetMs / 1000))))
      throw new ApiError('RATE_LIMIT', 'Muitas tentativas de login; tente novamente mais tarde')
    }
    let result
    try {
      result = await service.login(email, password, { userAgent: c.req.header('user-agent') ?? null, ip: ip(c) })
    } catch (err) {
      if (err instanceof AuthError && err.code === 'invalid_credentials') await loginLimiter.hit(key)
      throw toApiError(err)
    }
    await loginLimiter.reset(key)
    setSessionCookie(c, result.token, result.expiresAt, { secure: cookieSecure })
    await deps.audit
      .record({ companyId: null, actorUserId: result.user.id, action: 'auth.login', targetType: 'user', targetId: result.user.id, ip: ip(c) })
      .catch((err: unknown) => c.get('logger')?.error({ err }, 'failed to write audit log'))
    return c.json({ user: result.user, companies: result.companies }, 200)
  })

  const logout = async (c: Context<AppEnv>) => {
    const ctx = getCtx(c)
    if (ctx.auth.kind === 'session' && ctx.auth.sessionId) await deps.sessions.revoke(ctx.auth.sessionId)
    clearSessionCookie(c, { secure: cookieSecure })
    setAudit(c, { action: 'auth.logout', targetType: 'user', targetId: ctx.user?.id })
    return c.json({ ok: true }, 200)
  }
  app.post('/api/auth/logout', logout)
  app.delete('/api/auth/logout', logout)

  // ---------- cadastro ----------

  app.post('/api/auth/register', validate('json', registerSchema), async (c) => {
    const body = c.req.valid('json')
    const { user, companyId } = await run(() =>
      service.register({
        name: body.name,
        email: body.email,
        password: body.password,
        personalWhatsapp: body.personal_whatsapp ?? null,
        referralCode: body.referral_code ?? body.rewardful_referral,
      }),
    )
    await deps.audit
      .record({ companyId, actorUserId: user.id, action: 'auth.register', targetType: 'user', targetId: user.id, ip: ip(c) })
      .catch((err: unknown) => c.get('logger')?.error({ err }, 'failed to write audit log'))
    return c.json({ user, message: 'Conta criada com sucesso! Faça login para continuar.' }, 201)
  })

  // ---------- perfil ----------

  app.get('/api/auth/profile', async (c) => {
    const userId = sessionUserId(c)
    const [user, companies] = await run(() => Promise.all([service.getUser(userId), service.listCompanies(userId)]))
    return c.json({ user, companies }, 200)
  })

  app.put('/api/auth/profile', validate('json', profileSchema), async (c) => {
    const userId = sessionUserId(c)
    const body = c.req.valid('json')
    const user = await run(() =>
      service.updateProfile(userId, {
        name: body.name,
        email: body.email,
        locale: body.locale,
        personalWhatsapp: body.personal_whatsapp,
        currentPassword: body.current_password,
        password: body.password,
      }),
    )
    setAudit(c, {
      action: 'auth.profile.update',
      targetType: 'user',
      targetId: userId,
      detail: { fields: Object.keys(body).filter((k) => !k.includes('password')) },
    })
    return c.json({ user }, 200)
  })

  app.post(
    '/api/auth/profile/avatar',
    bodyLimit({
      // folga para o envelope multipart; o tamanho do arquivo é conferido depois
      maxSize: AVATAR_MAX_BYTES + 256 * 1024,
      onError: () => {
        throw new ApiError('PAYLOAD_TOO_LARGE', 'Imagem acima de 5 MB')
      },
    }),
    async (c) => {
      const userId = sessionUserId(c)
      const body = await c.req.parseBody()
      const file = body['avatar']
      if (!(file instanceof File))
        throw new ApiError('VALIDATION_ERROR', 'Envie a imagem no campo "avatar"', { fields: [{ path: 'avatar', message: 'Obrigatório' }] })
      if (file.size > AVATAR_MAX_BYTES) throw new ApiError('PAYLOAD_TOO_LARGE', 'Imagem acima de 5 MB')
      const user = await run(async () => service.setAvatar(userId, new Uint8Array(await file.arrayBuffer())))
      setAudit(c, { action: 'auth.avatar.update', targetType: 'user', targetId: userId })
      return c.json({ user }, 200)
    },
  )

  app.delete('/api/auth/profile/avatar', async (c) => {
    const userId = sessionUserId(c)
    const user = await run(() => service.removeAvatar(userId))
    setAudit(c, { action: 'auth.avatar.delete', targetType: 'user', targetId: userId })
    return c.json({ user }, 200)
  })

  app.get('/api/auth/avatars/:key', async (c) => {
    getCtx(c)
    const key = c.req.param('key')
    const avatar = AVATAR_KEY_RE.test(key) ? await service.readAvatar(key) : null
    if (!avatar) throw new ApiError('NOT_FOUND', 'Avatar não encontrado')
    return c.body(new Uint8Array(avatar.bytes), 200, {
      'Content-Type': avatar.mime,
      'Cache-Control': 'private, max-age=86400, immutable',
      'X-Content-Type-Options': 'nosniff',
    })
  })

  // ---------- redefinição de senha (públicas) ----------

  app.post('/api/auth/password-resets', validate('json', resetRequestSchema), async (c) => {
    const { email } = c.req.valid('json')
    try {
      await service.requestPasswordReset(email, { ip: ip(c) })
    } catch (err) {
      // Resposta neutra mesmo se o envio falhar: nunca revela se a conta existe.
      c.get('logger')?.error({ err }, 'password reset request failed')
    }
    return c.json({ ok: true, message: 'Se o e-mail existir, você receberá instruções para redefinir a senha.' }, 200)
  })

  app.get('/api/auth/password-resets/:token', async (c) => {
    return c.json(await service.checkPasswordReset(c.req.param('token')), 200)
  })

  app.patch('/api/auth/password-resets/:token', validate('json', resetCompleteSchema), async (c) => {
    const { password } = c.req.valid('json')
    await run(() => service.completePasswordReset(c.req.param('token'), password))
    return c.json({ ok: true }, 200)
  })

  // ---------- tokens de API (owner/admin) ----------

  app.post('/api/auth/api-tokens', validate('json', apiTokenSchema), async (c) => {
    const ctx = getCompanyCtx(c)
    if (ctx.auth.kind !== 'session' || !ctx.user) throw new ApiError('FORBIDDEN', 'Disponível apenas para sessões de usuário')
    const body = c.req.valid('json')
    const created = await run(() =>
      service.createApiToken({
        companyId: ctx.companyId,
        userId: ctx.user!.id,
        role: ctx.member?.role ?? null,
        name: body.name,
        expiresAt: body.expires_at ? new Date(body.expires_at) : null,
      }),
    )
    setAudit(c, { action: 'api_token.create', targetType: 'api_token', targetId: created.id, detail: { name: created.name } })
    return c.json(created, 201)
  })

  return app
}
