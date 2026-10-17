// Operações do admin da plataforma (SPEC T96; 20-admin-interno.md §3.6, §3.7, §3.9, §3.14): avisos e banners (CRUD em
// `/api/admin/*`, leitura do cliente em `/api/announcements` e `/api/banners`), saúde da infra, sessões WhatsApp de
// todas as empresas, segredos de plataforma (só escrita) e uso de IA por empresa × modelo.
// `/api/admin/*` só para `platform_admin` (o guard é registrado aqui também: idempotente com o da T95). Avisos, banners
// e segredos são globais: a auditoria vai para `crm.audit_logs` com `company_id` nulo e ação `admin.*`.
import { Hono, type Context } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import {
  ADMIN_MEDIA_MAX_BYTES,
  ADMIN_MEDIA_PUBLIC_PATH,
  AdminMediaService,
  AdminOpsError,
  aiUsageByCompanyModel,
  activeAnnouncements,
  activeBanners,
  AnnouncementsService,
  infraHealth,
  isWaExtensionMode,
  listAdminWaSessions,
  PlatformSecretsService,
  waRpcProfile,
} from '@crm/core'
import { FsBlobStore } from '@crm/node-kit'
import { getCompanyCtx, getCtx, clientIp } from '../../lib/context'
import { ApiError } from '../../lib/errors'
import type { AppEnv, ResolvedDeps } from '../../lib/types'
import { setAudit } from '../../middleware/audit'
import { requirePlatformRole } from '../../middleware/authorize'

export interface AdminOpsOptions {
  /** Relógio dos avisos/banners do cliente e das datas gravadas (testes). */
  now?: () => Date
  /** Filas monitoradas pela saúde. Default `MONITORED_QUEUES`. */
  queues?: readonly string[]
  /** Prefixo das filas. Default `crmQueuePrefix()` (`CRM_QUEUE_PREFIX` ou `crm`). */
  queuePrefix?: string
  /** Stream de eventos do WhatsApp. Default `wsm:events`. */
  waEventsStream?: string
  /** Timeout de cada bloco da saúde em ms (default 2000). */
  healthTimeoutMs?: number
  /** Ambiente das chaves de plataforma (fallback do segredo salvo). Default `process.env`. */
  env?: Record<string, string | undefined>
  /** T100: chave do HMAC dos ids das imagens globais (default: derivada de `CREDENTIALS_KEY`). */
  mediaSigningKey?: Buffer
  /** T100: teto do upload de imagem em bytes (default `ADMIN_MEDIA_MAX_BYTES`, 2 MB). */
  mediaMaxBytes?: number
}

declare module '../../lib/types' {
  interface AppDeps {
    /**
     * Perfil do gateway WhatsApp (`WA_RPC_PROFILE`). Default: o do ambiente, ou `crm`. `ai-manager` = modo extensão:
     * `GET /api/admin/wa/sessions` responde 404 (as sessões ficam no painel do ai-manager).
     */
    waProfile?: string
    adminOps?: AdminOpsOptions
  }
}

function toApiError(err: unknown): unknown {
  if (!(err instanceof AdminOpsError)) return err
  const map = { not_found: 'NOT_FOUND', validation: 'VALIDATION_ERROR' } as const
  return new ApiError(map[err.code], err.message, err.details)
}

async function domain<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (err) {
    throw toApiError(err)
  }
}

/** JSON do corpo; vazio vira `{}`. Nunca ecoa o corpo em erro. */
async function jsonBody(c: Context<AppEnv>): Promise<unknown> {
  const raw = await c.req.text()
  if (!raw.trim()) return {}
  try {
    return JSON.parse(raw)
  } catch {
    throw new ApiError('MALFORMED_REQUEST', 'JSON inválido')
  }
}

const flagParam = (v: string | undefined) => (v === undefined ? undefined : v === '1' || v === 'true')

export function adminOpsRoutes(deps: ResolvedDeps) {
  const opts = deps.adminOps ?? {}
  const now = () => opts.now?.() ?? new Date()
  const service = new AnnouncementsService({ db: deps.db, now })
  const secrets = () =>
    new PlatformSecretsService({
      db: deps.db,
      now,
      ...(deps.credentialsCipher ? { cipher: deps.credentialsCipher } : {}),
      ...(opts.env ? { env: opts.env } : {}),
    })
  const app = new Hono<AppEnv>()
  app.use('/api/admin/*', requirePlatformRole('platform_admin'))
  // T100: o harness E2E injeta o blobStore nas deps em tempo de requisição, então o serviço nasce sob demanda.
  let media: AdminMediaService | undefined
  const mediaService = () =>
    (media ??= new AdminMediaService({
      blobStore: deps.blobStore ?? new FsBlobStore(),
      ...(opts.mediaSigningKey ? { signingKey: opts.mediaSigningKey } : {}),
      ...(opts.mediaMaxBytes !== undefined ? { maxBytes: opts.mediaMaxBytes } : {}),
    }))
  const mediaMaxBytes = opts.mediaMaxBytes ?? ADMIN_MEDIA_MAX_BYTES
  const tooLarge = () =>
    new ApiError('VALIDATION_ERROR', 'Imagem acima de 2 MB', { fields: [{ path: 'file', message: 'Imagem acima de 2 MB' }] })

  /** Auditoria global (sem empresa): grava direto e desliga a automática, que usaria a empresa ativa do admin. */
  async function audit(
    c: Context<AppEnv>,
    action: string,
    targetType: string,
    targetId: string,
    detail: Record<string, unknown> = {},
  ) {
    setAudit(c, { skip: true })
    await deps.audit.record({
      companyId: null,
      actorUserId: getCtx(c).user?.id ?? null,
      action,
      targetType,
      targetId,
      detail: { admin: true, global: true, request_id: c.get('requestId'), ...detail },
      ip: clientIp(c, deps.trustProxy),
    })
  }
  const actorId = (c: Context<AppEnv>) => getCtx(c).user?.id ?? null

  // ---------------------------------------------------------------- cliente (qualquer membro com empresa ativa)

  app.get('/api/announcements', async (c) => {
    getCompanyCtx(c)
    return c.json({ items: await activeAnnouncements(deps.db, now()) }, 200)
  })

  app.get('/api/banners', async (c) => {
    getCompanyCtx(c)
    return c.json({ items: await activeBanners(deps.db, now()) }, 200)
  })

  // ---------------------------------------------------------------- avisos (admin)

  app.get('/api/admin/announcements', async (c) =>
    c.json(await domain(() => service.listAnnouncements(c.req.query())), 200),
  )

  app.post('/api/admin/announcements', async (c) => {
    const announcement = await domain(async () => service.createAnnouncement(await jsonBody(c), actorId(c)))
    await audit(c, 'admin.announcement.create', 'announcement', announcement.id, {
      title: announcement.title,
      announcement_type: announcement.announcement_type,
    })
    return c.json({ announcement }, 201)
  })

  app.get('/api/admin/announcements/:id', async (c) =>
    c.json({ announcement: await domain(() => service.getAnnouncement(c.req.param('id'))) }, 200),
  )

  const updateAnnouncement = async (c: Context<AppEnv>) => {
    const id = c.req.param('id')!
    const r = await domain(async () => service.updateAnnouncement(id, await jsonBody(c)))
    await audit(c, 'admin.announcement.update', 'announcement', id, { fields: r.fields })
    return c.json({ announcement: r.announcement }, 200)
  }
  app.patch('/api/admin/announcements/:id', updateAnnouncement)
  app.put('/api/admin/announcements/:id', updateAnnouncement)

  app.delete('/api/admin/announcements/:id', async (c) => {
    const id = c.req.param('id')
    const deleted = await domain(() => service.deleteAnnouncement(id))
    await audit(c, 'admin.announcement.delete', 'announcement', id, { title: deleted.title })
    return c.body(null, 204)
  })

  // ---------------------------------------------------------------- banners (admin)

  app.get('/api/admin/banners', async (c) => c.json(await domain(() => service.listBanners(c.req.query())), 200))

  app.post('/api/admin/banners', async (c) => {
    const banner = await domain(async () => service.createBanner(await jsonBody(c), actorId(c)))
    await audit(c, 'admin.banner.create', 'banner', banner.id, { title: banner.title })
    return c.json({ banner }, 201)
  })

  app.get('/api/admin/banners/:id', async (c) =>
    c.json({ banner: await domain(() => service.getBanner(c.req.param('id'))) }, 200),
  )

  const updateBanner = async (c: Context<AppEnv>) => {
    const id = c.req.param('id')!
    const r = await domain(async () => service.updateBanner(id, await jsonBody(c)))
    await audit(c, 'admin.banner.update', 'banner', id, { fields: r.fields })
    return c.json({ banner: r.banner }, 200)
  }
  app.patch('/api/admin/banners/:id', updateBanner)
  app.put('/api/admin/banners/:id', updateBanner)

  app.delete('/api/admin/banners/:id', async (c) => {
    const id = c.req.param('id')
    const deleted = await domain(() => service.deleteBanner(id))
    await audit(c, 'admin.banner.delete', 'banner', id, { title: deleted.title })
    return c.body(null, 204)
  })

  // ---------------------------------------------------------------- saúde (AC-T96-02)

  app.get('/api/admin/health', async (c) =>
    c.json(
      await infraHealth({
        db: deps.db,
        redis: deps.redis,
        now,
        ...(opts.queues ? { queues: opts.queues } : {}),
        ...(opts.queuePrefix ? { queuePrefix: opts.queuePrefix } : {}),
        ...(opts.waEventsStream ? { stream: opts.waEventsStream } : {}),
        ...(opts.healthTimeoutMs !== undefined ? { timeoutMs: opts.healthTimeoutMs } : {}),
      }),
      200,
    ),
  )

  // ---------------------------------------------------------------- sessões WhatsApp (AC-T96-03)

  app.get('/api/admin/wa/sessions', async (c) => {
    const profile = deps.waProfile ?? waRpcProfile()
    // Modo extensão: o admin mostra só dados do CRM; as sessões ficam no painel do ai-manager (SPEC 10.1 nº 7).
    if (isWaExtensionMode(profile)) throw new ApiError('NOT_FOUND', 'Rota não encontrada')
    if (!deps.waGateway) throw new ApiError('UPSTREAM_ERROR', 'Gateway WhatsApp não configurado')
    const gateway = deps.waGateway
    const orphan = flagParam(c.req.query('orphan'))
    let items
    try {
      items = await listAdminWaSessions(deps.db, gateway, {
        company_id: c.req.query('company_id'),
        state: c.req.query('state'),
        orphan,
      })
    } catch (err) {
      deps.logger.warn({ err }, 'falha ao listar sessões no gateway WhatsApp')
      throw new ApiError('UPSTREAM_ERROR', 'Falha ao consultar o gateway WhatsApp')
    }
    return c.json({ profile, items, total: items.length }, 200)
  })

  // ---------------------------------------------------------------- segredos de plataforma (AC-T96-04)

  app.get('/api/admin/platform-secrets', async (c) => c.json({ items: await secrets().list() }, 200))

  app.get('/api/admin/platform-secrets/:key', async (c) =>
    c.json({ secret: await domain(() => secrets().get(c.req.param('key'))) }, 200),
  )

  app.put('/api/admin/platform-secrets/:key', async (c) => {
    const key = c.req.param('key')
    const secret = await domain(async () => secrets().set(key, await jsonBody(c), actorId(c)))
    // Nunca o valor nem a máscara no detail.
    await audit(c, 'admin.platform_secret.update', 'platform_secret', key, { provider: key })
    return c.json({ secret }, 200)
  })

  app.delete('/api/admin/platform-secrets/:key', async (c) => {
    const key = c.req.param('key')
    const r = await domain(() => secrets().remove(key))
    if (r.removed) await audit(c, 'admin.platform_secret.delete', 'platform_secret', key, { provider: key })
    else setAudit(c, { skip: true })
    return c.json({ removed: r.removed, secret: r.secret }, 200)
  })

  // ---------------------------------------------------------------- imagens globais (T100, AC-T100-03)

  // Upload da imagem de aviso/banner: multipart, campo `file`, só imagem raster, ≤ 2 MB → 201 `{ url }` pública
  // (http/s, o formato que `image_url` aceita). Base da URL: `API_PUBLIC_URL`; sem ela, a origem da requisição.
  app.post(
    '/api/admin/uploads',
    bodyLimit({
      // folga para o envelope multipart; o tamanho do arquivo é conferido depois
      maxSize: mediaMaxBytes + 256 * 1024,
      onError: () => {
        throw tooLarge()
      },
    }),
    async (c) => {
      const body = await c.req.parseBody().catch((): Record<string, unknown> => ({}))
      const file = body.file
      if (!(file instanceof File))
        throw new ApiError('VALIDATION_ERROR', 'Envie a imagem no campo "file"', { fields: [{ path: 'file', message: 'Obrigatório' }] })
      if (file.size > mediaMaxBytes) throw tooLarge()
      const info = await domain(async () => mediaService().upload(new Uint8Array(await file.arrayBuffer()), file.type))
      const base = ((opts.env ?? process.env).API_PUBLIC_URL?.trim() || new URL(c.req.url).origin).replace(/\/+$/, '')
      await audit(c, 'admin.upload.create', 'admin_media', info.id, { mime: info.mime, size: info.size })
      return c.json({ url: `${base}${ADMIN_MEDIA_PUBLIC_PATH}/${info.id}`, id: info.id, mime: info.mime, size: info.size }, 201)
    },
  )

  // Pública (sem sessão): o cliente de qualquer empresa vê a imagem. Conteúdo endereçado por hash: cache imutável.
  app.get(`${ADMIN_MEDIA_PUBLIC_PATH}/:id`, async (c) => {
    setAudit(c, { skip: true })
    const img = await mediaService().get(c.req.param('id'))
    if (!img) throw new ApiError('NOT_FOUND', 'Imagem não encontrada')
    return c.body(new Uint8Array(img.data), 200, {
      'content-type': img.mime,
      'content-length': String(img.size),
      'cache-control': 'public, max-age=31536000, immutable',
      'x-content-type-options': 'nosniff',
      'cross-origin-resource-policy': 'cross-origin',
    })
  })

  // ---------------------------------------------------------------- uso de IA (AC-T96-04)

  app.get('/api/admin/ai/usage', async (c) =>
    c.json(await domain(() => aiUsageByCompanyModel(deps.db, c.req.query())), 200),
  )

  return app
}
