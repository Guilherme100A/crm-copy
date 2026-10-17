// Emissores de NF (SPEC T112; 19-integracoes.md §3.2, §4.2, §5.4, §6 "Emissores de NF"). CRUD com
// settings.integrations.view|edit|delete; status da NF da venda com dashboard.sales; reemissão com sales.edit.
// O token nunca volta na resposta, em `details` de erro nem na auditoria.
import { Hono, type Context } from 'hono'
import {
  defineQueue,
  INVOICES_JOB_OPTIONS,
  INVOICES_QUEUE,
  InvoiceEmissionService,
  InvoiceIntegrationsService,
  InvoicingError,
  RealtimePublisher,
  SalesService,
  type InvoiceEnqueue,
  type InvoiceJobData,
} from '@crm/core'
import { getCompanyCtx } from '../../lib/context'
import { ApiError } from '../../lib/errors'
import type { AppEnv, ResolvedDeps } from '../../lib/types'
import { setAudit } from '../../middleware/audit'
import { requirePerm } from '../../middleware/authorize'

declare module '../../lib/types' {
  interface AppDeps {
    /** Default: `new InvoiceIntegrationsService({ db, cipher: credentialsCipher, env: invoicesEnv, fetch: invoicesFetch })`. */
    invoiceIntegrations?: InvoiceIntegrationsService
    /** `NOTASY_API_URL` (default `process.env`, lido a cada chamada). */
    invoicesEnv?: Record<string, string | undefined>
    /** `fetch` das chamadas ao emissor. Default: global. */
    invoicesFetch?: typeof globalThis.fetch
    /** Enfileira um job `invoices` (reemissão). Default: fila `invoices` do Redis do processo. */
    invoicesEnqueue?: InvoiceEnqueue
  }
}

/** Monta o serviço de emissores (reaproveitado pela reemissão). */
export function invoiceIntegrationsDefaults(deps: ResolvedDeps): InvoiceIntegrationsService {
  deps.invoiceIntegrations ??= new InvoiceIntegrationsService({
    db: deps.db,
    ...(deps.credentialsCipher ? { cipher: deps.credentialsCipher } : {}),
    ...(deps.invoicesEnv ? { env: deps.invoicesEnv } : {}),
    ...(deps.invoicesFetch ? { fetch: deps.invoicesFetch } : {}),
  })
  return deps.invoiceIntegrations
}

function toApiError(err: unknown): unknown {
  if (!(err instanceof InvoicingError)) return err
  const map = { not_found: 'NOT_FOUND', validation: 'VALIDATION_ERROR', conflict: 'CONFLICT' } as const
  return new ApiError(map[err.code], err.message, err.details)
}

async function domain<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (err) {
    throw toApiError(err)
  }
}

/** JSON do corpo; vazio vira `{}`. Nunca ecoa o corpo em erro (pode conter o token). */
async function jsonBody(c: Context<AppEnv>): Promise<unknown> {
  const raw = await c.req.text()
  if (!raw.trim()) return {}
  try {
    return JSON.parse(raw)
  } catch {
    throw new ApiError('MALFORMED_REQUEST', 'JSON inválido')
  }
}

/** Aceita o envelope do produto de referência `{ invoice_integration: {...} }`. */
const unwrap = (v: unknown) =>
  v && typeof v === 'object' && !Array.isArray(v) && 'invoice_integration' in v && Object.keys(v).length === 1
    ? (v as { invoice_integration: unknown }).invoice_integration
    : v

const TOKEN_FIELDS = new Set(['integration_token'])
const truthy = (v: string | undefined) => v === '1' || v === 'true'

export function invoiceIntegrationsRoutes(deps: ResolvedDeps) {
  const service = invoiceIntegrationsDefaults(deps)
  let queue: ReturnType<typeof defineQueue<InvoiceJobData>> | undefined
  const enqueue: InvoiceEnqueue =
    deps.invoicesEnqueue ??
    (async (data, opts) => {
      queue ??= defineQueue<InvoiceJobData>(INVOICES_QUEUE, { defaultJobOptions: INVOICES_JOB_OPTIONS })
      await queue.add(INVOICES_QUEUE, data, { jobId: opts.jobId })
    })
  const emission = new InvoiceEmissionService({
    db: deps.db,
    integrations: service,
    publisher: new RealtimePublisher({ redis: deps.redis, prefix: deps.realtime?.prefix }),
    enqueue,
    logger: deps.logger,
  })
  const sales = new SalesService({ db: deps.db })
  const app = new Hono<AppEnv>()
  const view = requirePerm('settings.integrations.view')
  const edit = requirePerm('settings.integrations.edit')
  const del = requirePerm('settings.integrations.delete')
  const salesView = requirePerm('dashboard.sales')
  const salesEdit = requirePerm('sales.edit')
  const actor = (c: Context<AppEnv>) => getCompanyCtx(c).user?.id ?? null

  app.get('/api/invoice-integrations', view, async (c) => {
    const { companyId } = getCompanyCtx(c)
    return c.json({ invoice_integrations: await domain(() => service.list(companyId)) }, 200)
  })

  app.post('/api/invoice-integrations', edit, async (c) => {
    const { companyId } = getCompanyCtx(c)
    const integration = await domain(async () => service.create(companyId, unwrap(await jsonBody(c)), actor(c)))
    setAudit(c, {
      action: 'invoice_integrations.create',
      targetType: 'invoice_integration',
      targetId: integration.id,
      detail: {
        provider: integration.provider,
        company_name: integration.company_name,
        token_configured: integration.token_configured,
      },
    })
    return c.json({ invoice_integration: integration }, 201)
  })

  app.get('/api/invoice-integrations/:id', view, async (c) => {
    const { companyId } = getCompanyCtx(c)
    return c.json({ invoice_integration: await domain(() => service.get(companyId, c.req.param('id'))) }, 200)
  })

  /** Fluxos ativos cujo bloco "Venda aprovada" emite por este emissor (aviso antes de excluir, AC-T112-04). */
  app.get('/api/invoice-integrations/:id/usage', view, async (c) => {
    const { companyId } = getCompanyCtx(c)
    const usage = await domain(() => service.usage(companyId, c.req.param('id')))
    return c.json({ ...usage, in_use: usage.flows.length > 0 }, 200)
  })

  for (const method of ['put', 'patch'] as const) {
    app[method]('/api/invoice-integrations/:id', edit, async (c) => {
      const { companyId } = getCompanyCtx(c)
      const body = unwrap(await jsonBody(c))
      const integration = await domain(() => service.update(companyId, c.req.param('id'), body))
      const o = body && typeof body === 'object' ? (body as Record<string, unknown>) : {}
      setAudit(c, {
        action: 'invoice_integrations.update',
        targetType: 'invoice_integration',
        targetId: integration.id,
        detail: {
          fields: Object.keys(o).filter((k) => !TOKEN_FIELDS.has(k)),
          token_changed: Boolean(String(o.integration_token ?? '').trim()),
        },
      })
      return c.json({ invoice_integration: integration }, 200)
    })
  }

  /** Em uso por bloco "Venda aprovada" de fluxo ativo: 409 com o aviso e os fluxos; `?force=1` confirma a exclusão. */
  app.delete('/api/invoice-integrations/:id', del, async (c) => {
    const { companyId } = getCompanyCtx(c)
    const id = c.req.param('id')
    const result = await domain(() => service.remove(companyId, id, { force: truthy(c.req.query('force')) }))
    setAudit(c, {
      action: 'invoice_integrations.delete',
      targetType: 'invoice_integration',
      targetId: id,
      detail: {
        provider: result.deleted.provider,
        company_name: result.deleted.company_name,
        flows: result.flows.length,
      },
    })
    return c.json({ ok: true, warning: result.warning, flows: result.flows }, 200)
  })

  // ---- Status da NF por venda (19 §4.2) e reemissão (§5.4). Montadas antes de `salesRoutes`. ----

  /** `?sale_ids=a,b` → status das vendas da empresa (lista de vendas da UI, T114). */
  app.get('/api/sale-invoices', salesView, async (c) => {
    const { companyId } = getCompanyCtx(c)
    const ids = (c.req.query('sale_ids') ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
    return c.json({ items: await domain(() => emission.forSales(companyId, ids)) }, 200)
  })

  app.get('/api/sales/:id/invoice', salesView, async (c) => {
    const { companyId } = getCompanyCtx(c)
    return c.json({ invoice: await domain(() => emission.forSale(companyId, c.req.param('id'))) }, 200)
  })

  app.post('/api/sales/:id/reemit-invoice', salesEdit, async (c) => {
    const { companyId } = getCompanyCtx(c)
    const id = c.req.param('id')
    const body = await jsonBody(c)
    const invoice = await domain(() => emission.reemit(companyId, id, body))
    const sale = await domain(() => sales.get(companyId, id))
    setAudit(c, {
      action: 'sales.reemit_invoice',
      targetType: 'sale',
      targetId: id,
      detail: { invoice_integration_id: invoice.invoice_integration_id },
    })
    return c.json(
      {
        sale: {
          ...sale,
          invoice_emit_status: invoice.invoice_emit_status,
          invoice_last_error: invoice.invoice_last_error,
        },
        invoice,
        message: 'Emissão reenfileirada. Aguarde alguns segundos e atualize a lista.',
      },
      202,
    )
  })

  return app
}
