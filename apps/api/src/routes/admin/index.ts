// Admin interno (T95; 20 §3.1, §3.2, §3.8, §3.12, §5): usuários globais, empresas (ativa, limites, inbox_limits),
// cota de disparos e estatísticas. Só `platform_admin` (AC-T95-01): o guard cobre todo `/api/admin/*`, inclusive
// rotas inexistentes. Auditoria (`admin_audit_log`): cada mutação grava `crm.audit_logs` com ação `admin.*`,
// `company_id` = empresa ALVO (null para usuário/configuração global) e `detail.admin = true`; a automática do
// middleware (empresa ativa do admin) é desligada com `skip`.
import type { Context } from 'hono'
import { Hono } from 'hono'
import { z } from 'zod'
import {
  AdminError,
  AdminService,
  COMPANY_LIMIT_KEYS,
  INBOX_LIMIT_KEYS,
  LEGACY_USER_ROLES,
  RealtimePublisher,
} from '@crm/core'
import { auditLogs, SYSTEM_ROLES } from '@crm/db'
import { buildPageMeta, pageOffset, pageQuerySchema } from '@crm/shared'
import { and, count, desc, eq, like } from 'drizzle-orm'
import { clientIp, getCtx } from '../../lib/context'
import { ApiError } from '../../lib/errors'
import type { AppEnv, ResolvedDeps } from '../../lib/types'
import { validate } from '../../lib/validate'
import { setAudit } from '../../middleware/audit'
import { requirePlatformRole } from '../../middleware/authorize'

declare module '../../lib/types' {
  interface AppDeps {
    /** Admin interno (T95). `now`: relógio do período da cota e das estatísticas (testes). */
    admin?: { now?: () => Date }
  }
}

/** Aceita `{ user: {…} }` (fio da referência, 20 §6) ou o corpo direto. */
const unwrap = (key: string) => (v: unknown) => {
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    const inner = (v as Record<string, unknown>)[key]
    if (inner && typeof inner === 'object' && !Array.isArray(inner)) return inner
  }
  return v
}
/** Senha vazia na edição = não informada. */
const blankToUndefined = (v: unknown) => (v === '' || v === null ? undefined : v)

const PASSWORD_MESSAGE = 'A senha deve ter no mínimo 6 caracteres'
const name = z.string('Nome é obrigatório').trim().min(1, 'Nome é obrigatório').max(120)
const email = z
  .string('E-mail é obrigatório')
  .trim()
  .max(254)
  .regex(/^\S+@\S+\.\S+$/, 'E-mail inválido')
const password = z.string().min(6, PASSWORD_MESSAGE).max(200)
const roleFields = { system_role: z.enum(SYSTEM_ROLES).optional(), role: z.enum(LEGACY_USER_ROLES).optional() }
const personalWhatsapp = z.string().max(40).nullish()
const confirmMatches = (v: { password?: string; password_confirmation?: string }) =>
  v.password === undefined || v.password === v.password_confirmation
const confirmIssue = { message: 'A confirmação não confere com a senha', path: ['password_confirmation'] }

const createUserSchema = z.preprocess(
  unwrap('user'),
  z
    .object({
      name,
      email,
      password,
      password_confirmation: z.string().optional(),
      personal_whatsapp: personalWhatsapp,
      ...roleFields,
    })
    .refine(confirmMatches, confirmIssue),
)
const updateUserSchema = z.preprocess(
  unwrap('user'),
  z
    .object({
      name: name.optional(),
      /** Imutável: aceito e ignorado (AC-T95-02). */
      email: z.unknown().optional(),
      password: z.preprocess(blankToUndefined, password.optional()),
      password_confirmation: z.preprocess(blankToUndefined, z.string().optional()),
      personal_whatsapp: personalWhatsapp,
      ...roleFields,
    })
    .refine(confirmMatches, confirmIssue),
)

const limitValue = z
  .number('Use um inteiro ≥ 0 ou null')
  .int('Use um inteiro ≥ 0 ou null')
  .min(0, 'Use um inteiro ≥ 0 ou null')
  .max(1_000_000)
  .nullable()
const limitsSchema = z.strictObject(
  Object.fromEntries(COMPANY_LIMIT_KEYS.map((k) => [k, limitValue.optional()])) as Record<
    (typeof COMPANY_LIMIT_KEYS)[number],
    z.ZodOptional<typeof limitValue>
  >,
)
const inboxCount = z.number('Use um inteiro ≥ 0').int('Use um inteiro ≥ 0').min(0, 'Use um inteiro ≥ 0').max(1_000_000)
const inboxLimitsSchema = z.strictObject(
  Object.fromEntries(INBOX_LIMIT_KEYS.map((k) => [k, inboxCount])) as Record<
    (typeof INBOX_LIMIT_KEYS)[number],
    typeof inboxCount
  >,
)
const companyPatchSchema = z
  .object({
    active: z.boolean().optional(),
    limits: limitsSchema.optional(),
    inbox_limits: inboxLimitsSchema.nullable().optional(),
  })
  .refine(
    (v) => v.active !== undefined || v.limits !== undefined || v.inbox_limits !== undefined,
    'Informe active, limits ou inbox_limits',
  )

const bonusSchema = z.object({
  bonus_delta: z
    .number('Use um inteiro diferente de 0')
    .int('Use um inteiro diferente de 0')
    .min(-1_000_000_000)
    .max(1_000_000_000)
    .refine((v) => v !== 0, 'Use um inteiro diferente de 0'),
})
const perConnection = z
  .number('Use um inteiro ≥ 0')
  .int('Use um inteiro ≥ 0')
  .min(0, 'Use um inteiro ≥ 0')
  .max(10_000_000)
const settingsPatchSchema = z
  .object({ per_connection_limit: perConnection.optional(), per_instance_limit: perConnection.optional() })
  .refine(
    (v) => v.per_connection_limit !== undefined || v.per_instance_limit !== undefined,
    'Informe per_connection_limit',
  )

const search = z.string().trim().max(120).optional()
const usersQuery = pageQuerySchema.extend({ search })
const companiesQuery = pageQuerySchema.extend({ search, active: z.enum(['true', 'false', '1', '0']).optional() })
const statsQuery = z.object({ start_date: z.string().max(10).optional(), end_date: z.string().max(10).optional() })
const auditQuery = pageQuerySchema.extend({
  company_id: z.uuid().optional(),
  target_type: z.string().max(64).optional(),
  target_id: z.string().max(64).optional(),
  action: z.string().max(120).optional(),
})

function toApi(err: unknown): never {
  if (err instanceof AdminError) {
    const code = ({ not_found: 'NOT_FOUND', validation: 'VALIDATION_ERROR', conflict: 'CONFLICT' } as const)[err.code]
    throw new ApiError(code, err.message, err.details)
  }
  throw err
}

export function adminRoutes(deps: ResolvedDeps) {
  const service = new AdminService({
    db: deps.db,
    ...(deps.waGateway ? { waGateway: deps.waGateway } : {}),
    sessionsSources: deps.companySessions ? [deps.companySessions] : [],
    publisher: deps.realtimePublisher ?? new RealtimePublisher({ redis: deps.redis, prefix: deps.realtime?.prefix }),
    sessions: deps.sessions,
    logger: deps.logger,
    ...(deps.admin?.now ? { now: deps.admin.now } : {}),
  })
  const run = <T>(fn: () => Promise<T>) => fn().catch(toApi)
  const app = new Hono<AppEnv>()
  app.use('/api/admin/*', requirePlatformRole('platform_admin'))

  /** Grava o `admin_audit_log` (crm.audit_logs) com a empresa alvo e desliga a auditoria automática. */
  async function audit(
    c: Context<AppEnv>,
    action: string,
    target: { type: string; id: string },
    companyId: string | null,
    detail: Record<string, unknown> = {},
  ): Promise<void> {
    setAudit(c, { skip: true })
    try {
      await deps.audit.record({
        companyId,
        actorUserId: getCtx(c).user?.id ?? null,
        action,
        targetType: target.type,
        targetId: target.id,
        detail: { admin: true, request_id: c.get('requestId'), ...detail },
        ip: clientIp(c, deps.trustProxy),
      })
    } catch (err) {
      deps.logger.error({ err, action }, 'failed to write admin audit log')
    }
  }

  // ---------------------------------------------------------------- usuários

  app.get('/api/admin/users', validate('query', usersQuery), async (c) => {
    const q = c.req.valid('query')
    return c.json(
      await run(() =>
        service.listUsers({
          page: q.page,
          limit: q.limit,
          skip_total: q.skip_total,
          ...(q.search ? { search: q.search } : {}),
        }),
      ),
      200,
    )
  })

  app.post('/api/admin/users', validate('json', createUserSchema), async (c) => {
    const body = c.req.valid('json')
    const user = await run(() =>
      service.createUser({
        name: body.name,
        email: body.email,
        password: body.password,
        personal_whatsapp: body.personal_whatsapp ?? null,
        ...(body.system_role ? { system_role: body.system_role } : {}),
        ...(body.role ? { role: body.role } : {}),
      }),
    )
    await audit(c, 'admin.user.create', { type: 'user', id: user.id }, null, {
      email: user.email,
      system_role: user.system_role,
    })
    return c.json({ user }, 201)
  })

  app.get('/api/admin/users/:id', async (c) =>
    c.json({ user: await run(() => service.getUser(c.req.param('id'))) }, 200),
  )

  app.put('/api/admin/users/:id', validate('json', updateUserSchema), async (c) => {
    const ctx = getCtx(c)
    const body = c.req.valid('json')
    const id = c.req.param('id')
    const result = await run(() =>
      service.updateUser({ userId: ctx.user!.id, sessionId: ctx.auth.sessionId ?? null }, id, {
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.personal_whatsapp !== undefined ? { personal_whatsapp: body.personal_whatsapp } : {}),
        ...(body.system_role ? { system_role: body.system_role } : {}),
        ...(body.role ? { role: body.role } : {}),
        ...(body.password !== undefined ? { password: body.password } : {}),
      }),
    )
    await audit(c, 'admin.user.update', { type: 'user', id }, null, {
      fields: result.fields,
      password_changed: result.password_changed,
      email_ignored: body.email !== undefined && body.email !== result.user.email,
    })
    return c.json({ user: result.user, password_changed: result.password_changed }, 200)
  })

  app.get('/api/admin/users/:id/companies', async (c) =>
    c.json({ items: await run(() => service.userCompanies(c.req.param('id'))) }, 200),
  )

  // ---------------------------------------------------------------- empresas

  app.get('/api/admin/companies', validate('query', companiesQuery), async (c) => {
    const q = c.req.valid('query')
    return c.json(
      await run(() =>
        service.listCompanies({
          page: q.page,
          limit: q.limit,
          skip_total: q.skip_total,
          ...(q.search ? { search: q.search } : {}),
          ...(q.active ? { active: q.active === 'true' || q.active === '1' } : {}),
        }),
      ),
      200,
    )
  })

  app.get('/api/admin/companies/:id', async (c) =>
    c.json({ company: await run(() => service.getCompany(c.req.param('id'))) }, 200),
  )

  app.patch('/api/admin/companies/:id', validate('json', companyPatchSchema), async (c) => {
    const id = c.req.param('id')
    const body = c.req.valid('json')
    const result = await run(() =>
      service.updateCompany(id, {
        ...(body.active !== undefined ? { active: body.active } : {}),
        ...(body.limits ? { limits: body.limits } : {}),
        ...(body.inbox_limits !== undefined ? { inbox_limits: body.inbox_limits } : {}),
      }),
    )
    await audit(c, 'admin.company.update', { type: 'company', id }, id, {
      fields: result.fields,
      ...(body.active !== undefined ? { active: body.active } : {}),
      ...(body.limits ? { limits: body.limits } : {}),
      ...(body.inbox_limits !== undefined ? { inbox_limits: body.inbox_limits } : {}),
      ...(result.paused_session_ids.length ? { paused_session_ids: result.paused_session_ids } : {}),
    })
    return c.json(result, 200)
  })

  // ---------------------------------------------------------------- cota de disparos

  app.get('/api/admin/mass-dispatch-settings', async (c) =>
    c.json({ settings: await run(() => service.massDispatchSettings()) }, 200),
  )

  app.patch('/api/admin/mass-dispatch-settings', validate('json', settingsPatchSchema), async (c) => {
    const body = c.req.valid('json')
    const before = await run(() => service.massDispatchSettings())
    const settings = await run(() =>
      service.setMassDispatchSettings((body.per_connection_limit ?? body.per_instance_limit)!),
    )
    await audit(c, 'admin.mass_dispatch_settings.update', { type: 'mass_dispatch_settings', id: 'global' }, null, {
      from: before.per_connection_limit,
      to: settings.per_connection_limit,
    })
    return c.json({ settings }, 200)
  })

  app.get('/api/admin/companies/:id/mass-dispatch-quota', async (c) =>
    c.json({ quota: await run(() => service.companyQuota(c.req.param('id'))) }, 200),
  )

  app.patch('/api/admin/companies/:id/mass-dispatch-quota', validate('json', bonusSchema), async (c) => {
    const id = c.req.param('id')
    const { bonus_delta } = c.req.valid('json')
    const quota = await run(() => service.addQuotaBonus(id, bonus_delta))
    await audit(c, 'admin.mass_dispatch_quota.bonus', { type: 'company', id }, id, {
      bonus_delta,
      period: quota.period,
      bonus: quota.bonus,
    })
    return c.json({ quota }, 200)
  })

  // ---------------------------------------------------------------- estatísticas e auditoria

  app.get('/api/admin/statistics', validate('query', statsQuery), async (c) => {
    const q = c.req.valid('query')
    return c.json({ statistics: await run(() => service.statistics(q)) }, 200)
  })

  /** Consulta do `admin_audit_log`: só ações `admin.*`, mais recentes primeiro. */
  app.get('/api/admin/audit-logs', validate('query', auditQuery), async (c) => {
    const q = c.req.valid('query')
    const where = and(
      like(auditLogs.action, 'admin.%'),
      q.action ? like(auditLogs.action, `${q.action.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`) : undefined,
      q.company_id ? eq(auditLogs.companyId, q.company_id) : undefined,
      q.target_type ? eq(auditLogs.targetType, q.target_type) : undefined,
      q.target_id ? eq(auditLogs.targetId, q.target_id) : undefined,
    )
    const [t] = await deps.db.select({ n: count() }).from(auditLogs).where(where)
    const rows = await deps.db
      .select()
      .from(auditLogs)
      .where(where)
      .orderBy(desc(auditLogs.createdAt), desc(auditLogs.id))
      .limit(q.limit)
      .offset(pageOffset(q))
    return c.json(
      {
        items: rows.map((r) => ({
          id: r.id,
          company_id: r.companyId,
          actor_user_id: r.actorUserId,
          action: r.action,
          target_type: r.targetType,
          target_id: r.targetId,
          detail: r.detail,
          created_at: r.createdAt.toISOString(),
        })),
        page: buildPageMeta(q, { total: t?.n ?? 0 }),
      },
      200,
    )
  })

  return app
}
