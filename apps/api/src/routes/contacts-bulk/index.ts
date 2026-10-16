// Ações em massa de contatos (T66; 05 §3.4–3.7): exportação CSV por seleção (`POST/GET /api/contacts/exports`) e
// exclusão em massa por manifesto (`POST/GET /api/contacts/bulk-deletes`). Os jobs são os da T27 (download em
// `GET /api/jobs/:id/file`). Registrado antes de `/api/contacts/:id`.
import { Hono, type Context } from 'hono'
import { CONTACTS_BULK_DELETE_KIND, CONTACTS_EXPORT_KIND, ContactsBulkError, ContactsBulkService } from '@crm/core'
import { ApiError } from '../../lib/errors'
import type { AppEnv, ResolvedDeps } from '../../lib/types'
import { setAudit } from '../../middleware/audit'
import { requirePerm } from '../../middleware/authorize'
import { exportJobsFor, jobActor, jobsToApi } from '../exports/index'

async function run<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (err) {
    if (err instanceof ContactsBulkError) throw new ApiError('VALIDATION_ERROR', err.message, { fields: [{ path: err.path, message: err.message }] })
    throw jobsToApi(err)
  }
}

const services = new WeakMap<ResolvedDeps, ContactsBulkService>()
function serviceFor(deps: ResolvedDeps): ContactsBulkService {
  let s = services.get(deps)
  if (!s) services.set(deps, (s = new ContactsBulkService(exportJobsFor(deps))))
  return s
}

const MAX_MANIFEST_BYTES = 10 * 1024 * 1024

/** Corpo JSON (aceita o envelope `{ export: {...} }`); corpo inválido → 400. */
async function jsonBody(c: Context<AppEnv>): Promise<Record<string, unknown>> {
  let body: unknown
  try {
    body = await c.req.json()
  } catch {
    throw new ApiError('MALFORMED_REQUEST', 'JSON inválido')
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ApiError('VALIDATION_ERROR', 'Corpo deve ser um objeto')
  const o = body as Record<string, unknown>
  return o.export && typeof o.export === 'object' && Object.keys(o).length === 1 ? (o.export as Record<string, unknown>) : o
}

/** Manifesto: multipart `manifest` (arquivo ou texto) ou JSON (`{ manifest }` ou o próprio manifesto). */
async function manifestOf(c: Context<AppEnv>): Promise<unknown> {
  const type = c.req.header('content-type') ?? ''
  if (type.includes('multipart/form-data')) {
    const form = await c.req.parseBody()
    const part = form.manifest
    let text: string
    if (part instanceof File) {
      if (part.size > MAX_MANIFEST_BYTES) throw new ApiError('PAYLOAD_TOO_LARGE', 'Manifesto acima de 10 MB')
      text = await part.text()
    } else if (typeof part === 'string') text = part
    else throw new ApiError('VALIDATION_ERROR', 'Envie o manifesto no campo "manifest"', { fields: [{ path: 'manifest', message: 'obrigatório' }] })
    try {
      return JSON.parse(text)
    } catch {
      throw new ApiError('VALIDATION_ERROR', 'Manifesto não é JSON válido', { fields: [{ path: 'manifest', message: 'JSON inválido' }] })
    }
  }
  const body = await jsonBody(c)
  return body.manifest && typeof body.manifest === 'object' ? body.manifest : body
}

export function contactsBulkRoutes(deps: ResolvedDeps) {
  const app = new Hono<AppEnv>()

  app.post('/api/contacts/exports', requirePerm('contacts.view'), async (c) => {
    const body = await jsonBody(c)
    const job = await run(() => serviceFor(deps).createExport(jobActor(c), body))
    setAudit(c, { action: 'contacts.export', targetType: 'background_job', targetId: job.id, detail: { mode: body.mode ?? 'filtered' } })
    return c.json({ job, export: job }, 201)
  })

  app.get('/api/contacts/exports', requirePerm('contacts.view'), async (c) => {
    const items = await run(() => serviceFor(deps).recentExports(jobActor(c)))
    return c.json({ items, exports: items })
  })

  app.get('/api/contacts/exports/:id', requirePerm('contacts.view'), async (c) => {
    const job = await run(() => exportJobsFor(deps).get(jobActor(c), c.req.param('id')))
    if (job.kind !== CONTACTS_EXPORT_KIND) throw new ApiError('NOT_FOUND', 'Exportação não encontrada')
    return c.json({ export: job, job })
  })

  app.post('/api/contacts/bulk-deletes', requirePerm('contacts.delete'), async (c) => {
    const manifest = await manifestOf(c)
    const job = await run(() => serviceFor(deps).createBulkDelete(jobActor(c), manifest))
    setAudit(c, { action: 'contacts.bulk_delete', targetType: 'background_job', targetId: job.id, detail: { mode: (manifest as { mode?: unknown }).mode ?? 'ids' } })
    return c.json({ job, bulk_delete: job }, 201)
  })

  app.get('/api/contacts/bulk-deletes/:id', requirePerm('contacts.delete'), async (c) => {
    const job = await run(() => exportJobsFor(deps).get(jobActor(c), c.req.param('id')))
    if (job.kind !== CONTACTS_BULK_DELETE_KIND) throw new ApiError('NOT_FOUND', 'Exclusão em massa não encontrada')
    return c.json({ bulk_delete: job, job })
  })

  return app
}
