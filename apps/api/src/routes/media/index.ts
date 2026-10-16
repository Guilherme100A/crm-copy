// Mídia (SPEC T49): `POST /api/media` (multipart, campo `file`) e `GET /api/media/:id` (só da empresa).
// Limites por tipo (413) e mimes aceitos (415) no MediaService; o id é opaco e vale só na empresa do upload.
import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { DEFAULT_MEDIA_LIMITS, MediaError, MediaService, mediaKindOf, type MediaKind } from '@crm/core'
import { FsBlobStore } from '@crm/node-kit'
import { getCompanyCtx } from '../../lib/context'
import { ApiError } from '../../lib/errors'
import type { AppEnv, ResolvedDeps } from '../../lib/types'
import { setAudit } from '../../middleware/audit'
import { requirePerm } from '../../middleware/authorize'

declare module '../../lib/types' {
  interface AppDeps {
    /** Limites de upload por tipo, em bytes (padrão: imagem/vídeo 20 MB, áudio 16 MB, documento 30 MB). */
    mediaLimits?: Partial<Record<MediaKind, number>>
    /** Chave do HMAC dos ids de mídia (padrão: derivada de `CREDENTIALS_KEY`). */
    mediaSigningKey?: Buffer
  }
}

const services = new WeakMap<ResolvedDeps, MediaService>()

/** Um MediaService por app (compartilhado com as rotas de mensagens). */
export function mediaServiceFor(deps: ResolvedDeps): MediaService {
  let svc = services.get(deps)
  if (!svc) {
    svc = new MediaService({
      blobStore: deps.blobStore ?? new FsBlobStore(),
      ...(deps.mediaSigningKey ? { signingKey: deps.mediaSigningKey } : {}),
      ...(deps.mediaLimits ? { limits: deps.mediaLimits } : {}),
    })
    services.set(deps, svc)
  }
  return svc
}

export function mediaApiError(err: unknown): unknown {
  if (!(err instanceof MediaError)) return err
  if (err.code === 'unsupported_media') return new ApiError('UNSUPPORTED_MEDIA', err.message, err.details)
  if (err.code === 'payload_too_large') return new ApiError('PAYLOAD_TOO_LARGE', err.message, err.details)
  return new ApiError('NOT_FOUND', err.message)
}

export function mediaRoutes(deps: ResolvedDeps) {
  const app = new Hono<AppEnv>()
  // Teto do corpo inteiro: o maior limite de tipo + folga do multipart (o limite do tipo vem depois, por arquivo).
  // Calculado sem instanciar o serviço: o harness E2E injeta o blobStore nas deps em tempo de requisição.
  const maxBody = Math.max(...Object.values({ ...DEFAULT_MEDIA_LIMITS, ...deps.mediaLimits })) + 1024 * 1024
  const limitBody = bodyLimit({
    maxSize: maxBody,
    onError: () => {
      throw new ApiError('PAYLOAD_TOO_LARGE', 'Arquivo acima do limite')
    },
  })

  app.post('/api/media', requirePerm('chat.view'), limitBody, async (c) => {
    const { companyId } = getCompanyCtx(c)
    const body = await c.req.parseBody()
    const file = body.file
    if (!(file instanceof File)) throw new ApiError('VALIDATION_ERROR', 'Envie o arquivo no campo "file"', { fields: [{ path: 'file', message: 'Arquivo obrigatório' }] })
    const svc = mediaServiceFor(deps)
    const mime = file.type || 'application/octet-stream'
    try {
      // Limite do tipo antes de copiar os bytes.
      const kind = mediaKindOf(mime)
      if (kind && file.size > svc.limits[kind]) throw new MediaError('payload_too_large', 'Arquivo acima do limite do tipo', { kind, limit: svc.limits[kind], size: file.size })
      const media = await svc.upload(companyId, new Uint8Array(await file.arrayBuffer()), mime, file.name || null)
      setAudit(c, { action: 'media.upload', targetType: 'media', targetId: media.sha256, detail: { mime: media.mime, size: media.size } })
      return c.json({ media }, 201)
    } catch (err) {
      throw mediaApiError(err)
    }
  })

  app.get('/api/media/:id', requirePerm('chat.view'), async (c) => {
    const { companyId } = getCompanyCtx(c)
    let media
    try {
      media = await mediaServiceFor(deps).get(companyId, c.req.param('id'))
    } catch (err) {
      throw mediaApiError(err)
    }
    const headers: Record<string, string> = {
      'content-type': media.mime,
      'content-length': String(media.data.byteLength),
      'cache-control': 'private, max-age=3600',
      'x-content-type-options': 'nosniff',
    }
    if (media.file_name) headers['content-disposition'] = `inline; filename*=UTF-8''${encodeURIComponent(media.file_name)}`
    return c.body(new Uint8Array(media.data), 200, headers)
  })

  return app
}
