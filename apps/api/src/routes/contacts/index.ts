// Contatos (SPEC T26; feature 05 §6). Corpo e respostas em snake_case; recurso único embrulhado em `{ contact }`.
// Permissões: contacts.view (leitura), contacts.edit (criar, editar, fundir), contacts.delete (excluir).
import { Hono, type Context } from 'hono'
import { z } from 'zod'
import { ContactsService, type ContactInput } from '@crm/core'
import { pageQuerySchema } from '@crm/shared'
import { getCompanyCtx } from '../../lib/context'
import { ApiError } from '../../lib/errors'
import type { AppEnv, ResolvedDeps } from '../../lib/types'
import { validate } from '../../lib/validate'
import { requirePerm } from '../../middleware/authorize'
import { setAudit } from '../../middleware/audit'
import { domain } from './shared'

const text = (max: number) => z.string().max(max).nullish()

/** Corpo do contato. Aliases do produto de referência: `full_name` → `name`, `phone_number`/`phone_e164` → `phone`. */
const contactBody = z
  .object({
    name: text(200),
    full_name: text(200),
    phone: text(40),
    phone_number: text(40),
    phone_e164: text(40),
    wa_lid: text(64),
    email: text(254),
    state: text(2),
    city: text(120),
    zip: text(9),
    custom_fields: z.record(z.string(), z.unknown()).nullish(),
    label_ids: z.array(z.string()).max(200).nullish(),
    opt_out: z.boolean().optional(),
    ctwa_clid: text(500),
    source_id: text(500),
    source_url: text(2000),
    ad_media_url: text(2000),
  })
  .strict()

/** Aceita `{ customer: {…} }` / `{ contact: {…} }` (envelopes do produto de referência) ou o corpo direto. */
const unwrap = (v: unknown) => {
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    const o = v as Record<string, unknown>
    for (const k of ['contact', 'customer']) if (o[k] && typeof o[k] === 'object' && Object.keys(o).length === 1) return o[k]
  }
  return v
}
const createSchema = z.preprocess(unwrap, contactBody)
const updateSchema = createSchema

type Body = z.infer<typeof contactBody>

function toInput(b: Body): ContactInput {
  const input: ContactInput = {}
  const name = b.name !== undefined ? b.name : b.full_name
  if (name !== undefined) input.name = name
  const phone = b.phone !== undefined ? b.phone : b.phone_number !== undefined ? b.phone_number : b.phone_e164
  if (phone !== undefined) input.phone = phone
  if (b.wa_lid !== undefined) input.waLid = b.wa_lid
  if (b.email !== undefined) input.email = b.email
  if (b.state !== undefined) input.state = b.state
  if (b.city !== undefined) input.city = b.city
  if (b.zip !== undefined) input.zip = b.zip
  if (b.custom_fields !== undefined) input.customFields = b.custom_fields
  if (b.label_ids !== undefined) input.labelIds = b.label_ids
  if (b.opt_out !== undefined) input.optOut = b.opt_out
  if (b.ctwa_clid !== undefined) input.ctwaClid = b.ctwa_clid
  if (b.source_id !== undefined) input.sourceId = b.source_id
  if (b.source_url !== undefined) input.sourceUrl = b.source_url
  if (b.ad_media_url !== undefined) input.adMediaUrl = b.ad_media_url
  return input
}

/** `?label_ids=a&label_ids=b`, `?label_ids[]=a` ou `?label_ids=a,b`. */
const idList = z.preprocess(
  (v) => (v === undefined ? undefined : (Array.isArray(v) ? v : [v]).flatMap((x) => String(x).split(',')).map((x) => x.trim()).filter(Boolean)),
  z.array(z.uuid()).max(100).optional(),
)
const date = z.iso.date().optional()

const listQuery = pageQuerySchema.extend({
  search: z.string().max(200).optional(),
  label_ids: idList,
  custom_field_key: z.string().max(255).optional(),
  custom_field_value: z.string().max(500).optional(),
  created_at_from: date,
  created_at_to: date,
  skip_total_count: z.enum(['1', '0', 'true', 'false']).optional(),
})

const duplicatesQuery = z.object({ name: z.string().max(200).optional(), phone: z.string().max(40).optional(), email: z.string().max(254).optional() })
const mergeSchema = z.object({ lid: z.string().min(1).max(64), pn: z.string().min(1).max(64) }).strict()

/** Query com chaves repetidas (`label_ids`) e o formato `label_ids[]`. */
function rawQuery(c: Context<AppEnv>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, values] of Object.entries(c.req.queries())) {
    const key = k.endsWith('[]') ? k.slice(0, -2) : k
    out[key] = key === 'label_ids' ? [...((out[key] as string[] | undefined) ?? []), ...values] : values.at(-1)
  }
  return out
}

const nextDay = (d: string) => new Date(new Date(`${d}T00:00:00Z`).getTime() + 86_400_000)

export function contactsRoutes(deps: ResolvedDeps) {
  const service = new ContactsService({ db: deps.db, ...(deps.waGateway ? { waGateway: deps.waGateway } : {}) })
  const app = new Hono<AppEnv>()

  app.get('/api/contacts', requirePerm('contacts.view'), async (c) => {
    const { companyId } = getCompanyCtx(c)
    const q = await listQuery.parseAsync(rawQuery(c))
    const result = await domain(() =>
      service.list(companyId, {
        page: q.page,
        limit: q.limit,
        skipTotal: q.skip_total || q.skip_total_count === '1' || q.skip_total_count === 'true',
        ...(q.search ? { search: q.search } : {}),
        ...(q.label_ids?.length ? { labelIds: q.label_ids } : {}),
        ...(q.custom_field_key ? { customFieldKey: q.custom_field_key } : {}),
        ...(q.custom_field_value ? { customFieldValue: q.custom_field_value } : {}),
        ...(q.created_at_from ? { createdAtFrom: new Date(`${q.created_at_from}T00:00:00Z`) } : {}),
        ...(q.created_at_to ? { createdAtTo: nextDay(q.created_at_to) } : {}),
      }),
    )
    return c.json(result, 200)
  })

  app.get('/api/contacts/duplicates', requirePerm('contacts.view'), validate('query', duplicatesQuery), async (c) => {
    const { companyId } = getCompanyCtx(c)
    return c.json({ items: await domain(() => service.findDuplicates(companyId, c.req.valid('query'))) }, 200)
  })

  app.post('/api/contacts', requirePerm('contacts.edit'), validate('json', createSchema), async (c) => {
    const ctx = getCompanyCtx(c)
    const contact = await domain(() => service.create(ctx.companyId, toInput(c.req.valid('json')), { userId: ctx.user?.id ?? null }, ctx.auth.tokenId ? 'api' : 'manual'))
    setAudit(c, { action: 'contacts.create', targetType: 'contact', targetId: contact.id })
    return c.json({ contact }, 201)
  })

  app.post('/api/contacts/merge-identity', requirePerm('contacts.edit'), validate('json', mergeSchema), async (c) => {
    const { companyId } = getCompanyCtx(c)
    const { lid, pn } = c.req.valid('json')
    const contact = await domain(() => service.mergeIdentity(companyId, lid, pn))
    if (!contact) throw new ApiError('NOT_FOUND', 'Nenhum contato com esse LID ou telefone')
    setAudit(c, { action: 'contacts.merge_identity', targetType: 'contact', targetId: contact.id })
    return c.json({ contact }, 200)
  })

  app.get('/api/contacts/:id', requirePerm('contacts.view'), async (c) => {
    const { companyId } = getCompanyCtx(c)
    return c.json({ contact: await domain(() => service.get(companyId, c.req.param('id'))) }, 200)
  })

  for (const method of ['patch', 'put'] as const) {
    app[method]('/api/contacts/:id', requirePerm('contacts.edit'), validate('json', updateSchema), async (c) => {
      const ctx = getCompanyCtx(c)
      const body = c.req.valid('json')
      const contact = await domain(() => service.update(ctx.companyId, c.req.param('id'), toInput(body), { userId: ctx.user?.id ?? null }))
      setAudit(c, {
        action: body.opt_out === true ? 'contacts.opt_out' : body.opt_out === false ? 'contacts.opt_in' : 'contacts.update',
        targetType: 'contact',
        targetId: contact.id,
      })
      return c.json({ contact }, 200)
    })
  }

  app.delete('/api/contacts/:id', requirePerm('contacts.delete'), async (c) => {
    const { companyId } = getCompanyCtx(c)
    const id = c.req.param('id')
    await domain(() => service.delete(companyId, id))
    setAudit(c, { action: 'contacts.delete', targetType: 'contact', targetId: id })
    return c.body(null, 204)
  })

  return app
}
