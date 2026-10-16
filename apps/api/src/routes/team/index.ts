// Equipe (T22) na empresa ativa: `GET /api/team`, `PATCH|DELETE /api/team/:userId`,
// `POST /api/team/:userId/transfer-ownership`, `GET /api/permissions/definitions` e a gestão de convites em
// `/api/team/invitations` (o prefixo `/api/invitations/*` é público: aceite/recusa por token).
import { Hono, type Context } from 'hono'
import { z } from 'zod'
import { permissionDefinitions } from '@crm/core'
import { COMPANY_ROLES, emailSchema, pageQuerySchema, type PermissionKey } from '@crm/shared'
import { getCompanyCtx } from '../../lib/context'
import { ApiError } from '../../lib/errors'
import { validate } from '../../lib/validate'
import type { AppEnv, ResolvedDeps } from '../../lib/types'
import { requirePerm } from '../../middleware/authorize'
import { setAudit } from '../../middleware/audit'
import { actorOf, run, teamServices } from './support'

const unwrapMember = (v: unknown) =>
  v && typeof v === 'object' && !Array.isArray(v) && 'member' in v && typeof (v as { member: unknown }).member === 'object'
    ? (v as { member: unknown }).member
    : v

const updateSchema = z.preprocess(
  unwrapMember,
  z
    .object({
      role: z.enum(COMPANY_ROLES).optional(),
      permission_keys: z.array(z.string().max(120)).max(500).nullable().optional(),
    })
    .refine((b) => b.role !== undefined || b.permission_keys !== undefined, { message: 'Informe role ou permission_keys' }),
)

const kindSchema = z.enum(['member', 'platform'])
const unwrapInvitation = (v: unknown) =>
  v && typeof v === 'object' && !Array.isArray(v) && 'invitation' in v && typeof (v as { invitation: unknown }).invitation === 'object'
    ? (v as { invitation: unknown }).invitation
    : v
const createInvitationSchema = z.preprocess(
  unwrapInvitation,
  z.object({ kind: kindSchema.default('member'), email: emailSchema, role: z.enum(['admin', 'member']).default('member') }),
)
const listInvitationsQuery = pageQuerySchema.extend({
  kind: kindSchema.default('member'),
  status: z.enum(['pending', 'accepted', 'declined', 'expired']).optional(),
  search: z.string().trim().max(254).optional(),
})
const definitionsQuery = z.object({ role: z.enum(COMPANY_ROLES).optional() })

/** Permissão para gerir convites do tipo. */
const invitationPerm = (kind: 'member' | 'platform', action: 'view' | 'edit'): PermissionKey =>
  kind === 'member' ? (action === 'view' ? 'team.view' : 'team.edit') : `settings.platform_invitations.${action}`

function assertPerm(c: Context<AppEnv>, key: PermissionKey) {
  const ctx = getCompanyCtx(c)
  if (!ctx.perms.has(key)) throw new ApiError('FORBIDDEN', 'Permissão insuficiente', { permission: key })
}

export function teamRoutes(deps: ResolvedDeps) {
  const app = new Hono<AppEnv>()
  const svc = () => teamServices(deps)

  app.get('/api/permissions/definitions', validate('query', definitionsQuery), async (c) => {
    getCompanyCtx(c)
    return c.json(permissionDefinitions(c.req.valid('query').role))
  })

  app.get('/api/team', requirePerm('team.view'), async (c) => {
    const ctx = getCompanyCtx(c)
    return c.json({ items: await run(() => svc().team.list(ctx.companyId)) })
  })

  // ---------- convites (gestão) ----------

  app.get('/api/team/invitations', validate('query', listInvitationsQuery), async (c) => {
    const ctx = getCompanyCtx(c)
    const q = c.req.valid('query')
    assertPerm(c, invitationPerm(q.kind, 'view'))
    return c.json(
      await run(() => svc().invitations.list(ctx.companyId, { kind: q.kind, status: q.status, search: q.search || undefined, page: q.page, limit: q.limit })),
    )
  })

  app.post('/api/team/invitations', validate('json', createInvitationSchema), async (c) => {
    const ctx = getCompanyCtx(c)
    const actor = actorOf(c)
    const body = c.req.valid('json')
    assertPerm(c, invitationPerm(body.kind, 'edit'))
    const r = await run(() => svc().invitations.create({ userId: actor.userId, name: actor.name }, ctx.companyId, body))
    setAudit(c, { action: 'invitation.create', targetType: 'invitation', targetId: r.invitation.id, detail: { kind: body.kind, role: body.role } })
    return c.json({ invitation: r.invitation, invitation_link: r.link }, 201)
  })

  const forInvitation = async (c: Context<AppEnv>) => {
    const ctx = getCompanyCtx(c)
    const inv = await run(() => svc().invitations.get(ctx.companyId, c.req.param('id')!))
    assertPerm(c, invitationPerm(inv.kind, 'edit'))
    return { companyId: ctx.companyId, inv }
  }

  app.post('/api/team/invitations/:id/resend', async (c) => {
    const { companyId, inv } = await forInvitation(c)
    const r = await run(() => svc().invitations.resend(companyId, inv.id))
    setAudit(c, { action: 'invitation.resend', targetType: 'invitation', targetId: inv.id })
    return c.json({ invitation: r.invitation, invitation_link: r.link })
  })

  app.post('/api/team/invitations/:id/cancel', async (c) => {
    const { companyId, inv } = await forInvitation(c)
    const invitation = await run(() => svc().invitations.cancel(companyId, inv.id))
    setAudit(c, { action: 'invitation.cancel', targetType: 'invitation', targetId: inv.id })
    return c.json({ invitation })
  })

  // Gera um token novo (o banco só guarda o hash): o link anterior deixa de valer.
  app.post('/api/team/invitations/:id/link', async (c) => {
    const { companyId, inv } = await forInvitation(c)
    const link = await run(() => svc().invitations.link(companyId, inv.id))
    setAudit(c, { action: 'invitation.link', targetType: 'invitation', targetId: inv.id })
    return c.json({ invitation_link: link })
  })

  // ---------- membros ----------

  app.patch('/api/team/:userId', requirePerm('team.edit'), validate('json', updateSchema), async (c) => {
    const ctx = getCompanyCtx(c)
    const actor = actorOf(c)
    const b = c.req.valid('json')
    const member = await run(() =>
      svc().team.update({ ...actor, role: ctx.member?.role ?? null }, ctx.companyId, c.req.param('userId'), {
        role: b.role,
        permissionKeys: b.permission_keys,
      }),
    )
    setAudit(c, {
      action: b.permission_keys !== undefined ? 'team.permissions_update' : 'team.role_update',
      targetType: 'member',
      targetId: member.user_id,
      detail: { role: member.role },
    })
    return c.json({ member })
  })

  app.delete('/api/team/:userId', requirePerm('team.delete'), async (c) => {
    const ctx = getCompanyCtx(c)
    const userId = c.req.param('userId')
    await run(() => svc().team.remove(ctx.companyId, userId))
    setAudit(c, { action: 'team.remove', targetType: 'member', targetId: userId })
    return c.json({ removed: true })
  })

  app.post('/api/team/:userId/transfer-ownership', async (c) => {
    const ctx = getCompanyCtx(c)
    const actor = actorOf(c)
    const userId = c.req.param('userId')
    const r = await run(() => svc().team.transferOwnership(actor, ctx.companyId, userId))
    setAudit(c, { action: 'team.transfer_ownership', targetType: 'member', targetId: userId })
    return c.json(r)
  })

  return app
}
