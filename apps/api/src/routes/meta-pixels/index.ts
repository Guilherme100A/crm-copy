// Pixels / Conversions API (SPEC T104; 11 §3.3, §5.4; revisão 3). Tudo exige `facebook.pixel`. A listagem e o GET
// devolvem `masked_pixel_id`/`masked_access_token`; o token em claro só sai no GET individual com `include_access_token=true`.
// Revisão 3 (docs/integrations/meta-capi.md):
// - campos opcionais `page_id`, `whatsapp_business_account_id`, `test_event_code`, `default_country`, `auto_lead_on_ad`;
// - `GET /api/meta/pixels/:id/events`: diagnóstico "Eventos enviados" (status, modo, NOMES dos identificadores,
//   pontuação estimada, filtros e paginação). "Aceito pela CAPI" (`events_received`) ≠ "atribuído pela Meta".
// Doc: https://developers.facebook.com/docs/marketing-api/conversions-api/business-messaging
//      https://developers.facebook.com/docs/marketing-api/conversions-api/using-the-api
import { CapiEventLogService, PixelConfigError, PixelConfigService } from '@crm/core'
import { CAPI_EVENT_STATUSES } from '@crm/db'
import { pageQuerySchema } from '@crm/shared'
import { Hono } from 'hono'
import { z } from 'zod'
import { getCompanyCtx } from '../../lib/context'
import { ApiError } from '../../lib/errors'
import type { AppEnv, ResolvedDeps } from '../../lib/types'
import { validate } from '../../lib/validate'
import { setAudit } from '../../middleware/audit'
import { requirePerm } from '../../middleware/authorize'

/** Aceita o corpo plano ou envelopado em `pixel_config` (como o front de referência). */
const unwrap = (v: unknown) => (v && typeof v === 'object' && !Array.isArray(v) && 'pixel_config' in v ? (v as { pixel_config: unknown }).pixel_config : v)

const optionalId = z.union([z.string().max(64), z.number().int().nonnegative()]).nullable().optional()
const fields = {
  name: z.string().max(255),
  pixel_id: z.union([z.string().max(64), z.number().int().nonnegative()]),
  access_token: z.string().max(4096),
  platform: z.string().max(32),
  auto_send_sales: z.boolean(),
  page_id: optionalId,
  whatsapp_business_account_id: optionalId,
  test_event_code: z.string().max(64).nullable().optional(),
  default_country: z.string().max(8).nullable().optional(),
  auto_lead_on_ad: z.boolean().optional(),
}
const extras = {
  page_id: fields.page_id,
  whatsapp_business_account_id: fields.whatsapp_business_account_id,
  test_event_code: fields.test_event_code,
  default_country: fields.default_country,
  auto_lead_on_ad: fields.auto_lead_on_ad,
}
const createSchema = z.preprocess(
  unwrap,
  z.object({ name: fields.name, pixel_id: fields.pixel_id, access_token: fields.access_token, platform: fields.platform.optional(), auto_send_sales: fields.auto_send_sales.optional(), ...extras }),
)
const updateSchema = z.preprocess(
  unwrap,
  z.object({
    name: fields.name.optional(),
    pixel_id: fields.pixel_id.optional(),
    access_token: fields.access_token.nullable().optional(),
    platform: fields.platform.optional(),
    auto_send_sales: fields.auto_send_sales.optional(),
    ...extras,
  }),
)
const getQuery = z.object({ include_access_token: z.enum(['true', 'false', '1', '0']).optional() })
const eventsQuery = pageQuerySchema.extend({
  status: z.enum(CAPI_EVENT_STATUSES).optional(),
  mode: z.enum(['business_messaging', 'chat', 'system_generated']).optional(),
  event_name: z.string().max(64).optional(),
  source: z.enum(['flow', 'sale', 'manual', 'ad_lead']).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
})

async function domain<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (err) {
    if (!(err instanceof PixelConfigError)) throw err
    if (err.code === 'not_found') throw new ApiError('NOT_FOUND', err.message)
    throw new ApiError('VALIDATION_ERROR', err.message, err.details)
  }
}

export function metaPixelsRoutes(deps: ResolvedDeps) {
  const svc = () => new PixelConfigService({ db: deps.db, ...(deps.credentialsCipher ? { cipher: deps.credentialsCipher } : {}) })
  const app = new Hono<AppEnv>()
  const perm = requirePerm('facebook.pixel')

  app.get('/api/meta/pixels', perm, async (c) => {
    const { companyId } = getCompanyCtx(c)
    return c.json({ items: await svc().list(companyId) }, 200)
  })

  app.get('/api/meta/pixels/:id', perm, validate('query', getQuery), async (c) => {
    const { companyId } = getCompanyCtx(c)
    const q = c.req.valid('query')
    const includeAccessToken = q.include_access_token === 'true' || q.include_access_token === '1'
    return c.json({ pixel: await domain(() => svc().get(companyId, c.req.param('id'), { includeAccessToken })) }, 200)
  })

  app.get('/api/meta/pixels/:id/events', perm, validate('query', eventsQuery), async (c) => {
    const { companyId } = getCompanyCtx(c)
    const q = c.req.valid('query')
    const out = await domain(() => new CapiEventLogService({ db: deps.db }).list(companyId, c.req.param('id'), q))
    return c.json(out, 200)
  })

  app.post('/api/meta/pixels', perm, validate('json', createSchema), async (c) => {
    const { companyId } = getCompanyCtx(c)
    const pixel = await domain(() => svc().create(companyId, c.req.valid('json')))
    setAudit(c, { action: 'meta.pixel.create', targetType: 'pixel_config', targetId: pixel.id, detail: { name: pixel.name } })
    return c.json({ pixel }, 201)
  })

  app.put('/api/meta/pixels/:id', perm, validate('json', updateSchema), async (c) => {
    const { companyId } = getCompanyCtx(c)
    const id = c.req.param('id')
    const body = c.req.valid('json')
    const pixel = await domain(() => svc().update(companyId, id, body))
    setAudit(c, { action: 'meta.pixel.update', targetType: 'pixel_config', targetId: id, detail: { fields: Object.keys(body).filter((k) => k !== 'access_token' || body.access_token) } })
    return c.json({ pixel }, 200)
  })

  app.delete('/api/meta/pixels/:id', perm, async (c) => {
    const { companyId } = getCompanyCtx(c)
    const id = c.req.param('id')
    await domain(() => svc().remove(companyId, id))
    setAudit(c, { action: 'meta.pixel.delete', targetType: 'pixel_config', targetId: id })
    return c.body(null, 204)
  })

  return app
}
