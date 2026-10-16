// Importação de contatos (T67; 05 §3.6): `POST /api/contacts/imports` (multipart CSV → job `contacts_import`),
// `GET /api/contacts/imports/:id`, `GET /api/contacts/import-template.csv` e
// `POST /api/contacts/import-from-whatsapp { connection_id }` (síncrono). Registrado antes de `/api/contacts/:id`.
import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { z } from 'zod'
import {
  CONTACTS_IMPORT_KIND,
  CONTACTS_IMPORT_MAX_BYTES,
  ContactsImportError,
  ContactsImportService,
  FsExportFileStore,
  IMPORT_TEMPLATE_FILE_NAME,
  contactsImportTemplate,
} from '@crm/core'
import type { ErrorCode } from '@crm/shared'
import { ApiError } from '../../lib/errors'
import { validate } from '../../lib/validate'
import type { AppEnv, ResolvedDeps } from '../../lib/types'
import { setAudit } from '../../middleware/audit'
import { requirePerm } from '../../middleware/authorize'
import { exportJobsFor, jobActor, jobsToApi } from '../exports/index'

const CODE: Record<ContactsImportError['code'], ErrorCode> = { not_found: 'NOT_FOUND', invalid: 'VALIDATION_ERROR', session_not_connected: 'SESSION_NOT_CONNECTED' }

async function run<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (err) {
    if (err instanceof ContactsImportError) throw new ApiError(CODE[err.code], err.message, err.details)
    throw jobsToApi(err)
  }
}

const services = new WeakMap<ResolvedDeps, ContactsImportService>()

export function contactsImportServiceFor(deps: ResolvedDeps): ContactsImportService {
  let s = services.get(deps)
  if (!s) {
    s = new ContactsImportService({ db: deps.db, jobs: exportJobsFor(deps), files: deps.exportFiles ?? new FsExportFileStore(), waGateway: deps.waGateway })
    services.set(deps, s)
  }
  return s
}

const invalid = (path: string, message: string) => new ApiError('VALIDATION_ERROR', message, { fields: [{ path, message }] })

/** `'true'|'1'|'on'` → true, `'false'|'0'|'off'` → false; ausente → default. */
function flag(v: unknown, def: boolean, path: string): boolean {
  if (v === undefined || v === null || v === '') return def
  const s = String(v).trim().toLowerCase()
  if (['true', '1', 'on', 'yes', 'sim'].includes(s)) return true
  if (['false', '0', 'off', 'no', 'nao', 'não'].includes(s)) return false
  throw invalid(path, 'Valor booleano inválido')
}

/** `default_label_ids[]` (repetido) e/ou `default_label_ids_json` (array JSON). */
function labelIds(body: Record<string, unknown>): string[] {
  const out: string[] = []
  for (const key of ['default_label_ids[]', 'default_label_ids']) {
    const v = body[key]
    for (const item of Array.isArray(v) ? v : v === undefined ? [] : [v]) if (typeof item === 'string' && item.trim()) out.push(item.trim())
  }
  const json = body.default_label_ids_json
  if (typeof json === 'string' && json.trim()) {
    let parsed: unknown
    try {
      parsed = JSON.parse(json)
    } catch {
      throw invalid('default_label_ids_json', 'JSON inválido')
    }
    if (!Array.isArray(parsed) || parsed.some((x) => typeof x !== 'string')) throw invalid('default_label_ids_json', 'Use uma lista de ids')
    out.push(...(parsed as string[]))
  }
  return [...new Set(out)]
}

const whatsappSchema = z.object({ connection_id: z.string().min(1) })

export function contactsImportRoutes(deps: ResolvedDeps) {
  const app = new Hono<AppEnv>()
  const limitBody = bodyLimit({
    maxSize: CONTACTS_IMPORT_MAX_BYTES + 1024 * 1024,
    onError: () => {
      throw new ApiError('PAYLOAD_TOO_LARGE', 'Arquivo acima de 50 MB')
    },
  })

  app.get('/api/contacts/import-template.csv', requirePerm('contacts.view'), (c) =>
    c.body(contactsImportTemplate(), 200, {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="${IMPORT_TEMPLATE_FILE_NAME}"`,
    }),
  )

  app.post('/api/contacts/imports', requirePerm('contacts.edit'), limitBody, async (c) => {
    const body = await c.req.parseBody({ all: true })
    const file = Array.isArray(body.file) ? body.file[0] : body.file
    if (!(file instanceof File)) throw invalid('file', 'Envie o arquivo CSV no campo "file"')
    if (file.size > CONTACTS_IMPORT_MAX_BYTES) throw new ApiError('PAYLOAD_TOO_LARGE', 'Arquivo acima de 50 MB')
    const mode = typeof body.mode === 'string' ? body.mode : null
    const data = new Uint8Array(await file.arrayBuffer())
    const job = await run(() =>
      contactsImportServiceFor(deps).createCsvImport(jobActor(c), {
        data,
        mode,
        createMissingLabels: flag(body.create_missing_labels, true, 'create_missing_labels'),
        defaultLabelIds: labelIds(body as Record<string, unknown>),
      }),
    )
    setAudit(c, { action: 'contacts.import', targetType: 'background_job', targetId: job.id, detail: { file_name: file.name || null, size: file.size } })
    return c.json({ job }, 201)
  })

  app.get('/api/contacts/imports/:id', requirePerm('contacts.edit'), async (c) => {
    const job = await run(() => exportJobsFor(deps).get(jobActor(c), c.req.param('id')))
    if (job.kind !== CONTACTS_IMPORT_KIND) throw new ApiError('NOT_FOUND', 'Importação não encontrada')
    return c.json({ import: job, job })
  })

  app.post('/api/contacts/import-from-whatsapp', requirePerm('contacts.edit'), validate('json', whatsappSchema), async (c) => {
    const { connection_id } = c.req.valid('json')
    const result = await run(() => contactsImportServiceFor(deps).importFromWhatsApp(jobActor(c), connection_id))
    setAudit(c, { action: 'contacts.import_whatsapp', targetType: 'connection', targetId: connection_id, detail: { ...result, warnings: undefined } })
    return c.json(result)
  })

  return app
}
