// Jobs de exportação/importação (T27): `POST /api/jobs` (cria um export de kind registrado), `GET /api/jobs/:id`,
// `GET /api/jobs?kind=&limit=3` e `GET /api/jobs/:id/file` (stream do CSV). Acesso: criador ou permissão do kind;
// outra empresa → 404. O processamento é do worker (filas `exports`/`imports`).
import { Readable } from 'node:stream'
import { Hono } from 'hono'
import { z } from 'zod'
import {
  EXPORTS_QUEUE,
  ExportJobs,
  FsExportFileStore,
  IMPORTS_QUEUE,
  JOBS_LIST_MAX_LIMIT,
  JobsError,
  backgroundJobQueueId,
  defineQueue,
  type BackgroundJobData,
  type ExportFileStore,
  type JobActor,
} from '@crm/core'
import type { ErrorCode } from '@crm/shared'
import type { Context } from 'hono'
import { getCompanyCtx } from '../../lib/context'
import { ApiError } from '../../lib/errors'
import { validate } from '../../lib/validate'
import type { AppEnv, ResolvedDeps } from '../../lib/types'
import { setAudit } from '../../middleware/audit'

declare module '../../lib/types' {
  interface AppDeps {
    /** Arquivos dos jobs (default `FsExportFileStore` em `STORAGE_DIR/exports`); o worker usa o mesmo diretório. */
    exportFiles?: ExportFileStore
    /** Enfileira um export criado (default: fila BullMQ `exports` pelo `REDIS_URL`). */
    exportsEnqueue?: (jobId: string) => Promise<void>
    /** Enfileira um import criado (default: fila BullMQ `imports`). */
    importsEnqueue?: (jobId: string) => Promise<void>
  }
}

const CODE: Record<JobsError['code'], ErrorCode> = { not_found: 'NOT_FOUND', forbidden: 'FORBIDDEN', invalid: 'VALIDATION_ERROR', conflict: 'CONFLICT' }

export function jobsToApi(err: unknown): unknown {
  return err instanceof JobsError ? new ApiError(CODE[err.code], err.message, err.details) : err
}

async function run<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (err) {
    throw jobsToApi(err)
  }
}

const services = new WeakMap<ResolvedDeps, ExportJobs>()

/** Um ExportJobs por app (as rotas de export dos módulos usam o mesmo). */
export function exportJobsFor(deps: ResolvedDeps): ExportJobs {
  let s = services.get(deps)
  if (!s) {
    const queues: Partial<Record<'export' | 'import', ReturnType<typeof defineQueue<BackgroundJobData>>>> = {}
    const bull = async (type: 'export' | 'import', jobId: string) => {
      const q = (queues[type] ??= defineQueue<BackgroundJobData>(type === 'export' ? EXPORTS_QUEUE : IMPORTS_QUEUE, { defaultJobOptions: { attempts: 1 } }))
      await q.add(type, { jobId }, { jobId: backgroundJobQueueId(type, jobId) })
    }
    s = new ExportJobs({
      db: deps.db,
      files: deps.exportFiles ?? new FsExportFileStore(),
      enqueue: async (type, data) => {
        const custom = type === 'export' ? deps.exportsEnqueue : deps.importsEnqueue
        await (custom ? custom(data.jobId) : bull(type, data.jobId))
      },
    })
    services.set(deps, s)
  }
  return s
}

/** Empresa, usuário e permissões da requisição. */
export function jobActor(c: Context<AppEnv>): JobActor {
  const ctx = getCompanyCtx(c)
  return { companyId: ctx.companyId, userId: ctx.user?.id ?? null, perms: ctx.perms as ReadonlySet<string> }
}

const createSchema = z.object({
  kind: z.string().min(1).max(60),
  filters: z.record(z.string(), z.unknown()).optional(),
  delimiter: z.enum([',', ';']).optional(),
})

const listSchema = z.object({
  kind: z.string().min(1).max(60).optional(),
  limit: z.coerce.number().int().min(1).max(JOBS_LIST_MAX_LIMIT).optional(),
})

/** `attachment; filename="..."; filename*=UTF-8''...` (nome ASCII de reserva + UTF-8). */
function disposition(fileName: string): string {
  const ascii = fileName.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_')
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName)}`
}

export function exportsRoutes(deps: ResolvedDeps) {
  const app = new Hono<AppEnv>()

  app.post('/api/jobs', validate('json', createSchema), async (c) => {
    const body = c.req.valid('json')
    const job = await run(() => exportJobsFor(deps).create(jobActor(c), body.kind, body.filters ?? {}, { delimiter: body.delimiter }))
    setAudit(c, { action: 'job.create', targetType: 'background_job', targetId: job.id, detail: { kind: job.kind } })
    return c.json({ job }, 201)
  })

  app.get('/api/jobs', validate('query', listSchema), async (c) => {
    const q = c.req.valid('query')
    const items = await run(() => exportJobsFor(deps).list(jobActor(c), { kind: q.kind ?? null, limit: q.limit ?? null }))
    return c.json({ items })
  })

  app.get('/api/jobs/:id', async (c) => {
    const job = await run(() => exportJobsFor(deps).get(jobActor(c), c.req.param('id')))
    return c.json({ job })
  })

  app.get('/api/jobs/:id/file', async (c) => {
    const file = await run(() => exportJobsFor(deps).file(jobActor(c), c.req.param('id')))
    const headers: Record<string, string> = {
      'content-type': file.contentType,
      'content-disposition': disposition(file.fileName),
      'cache-control': 'private, no-store',
      'x-content-type-options': 'nosniff',
    }
    if (file.size !== null) headers['content-length'] = String(file.size)
    return c.body(Readable.toWeb(file.stream) as ReadableStream, 200, headers)
  })

  return app
}
