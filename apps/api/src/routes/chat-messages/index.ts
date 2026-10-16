// Mensagens do chat (SPEC T49; 03-chats F23–F47): histórico, envio (idempotente por Idempotency-Key), reação,
// encaminhar, apagar para todos e marcar como lido. Permissão `chat.view` ("Acessar chat" inclui responder).
// T119: toda rota resolve o chat pelo escopo do ator (T31/T48) ANTES de qualquer efeito: fora do escopo → 404.
import { Hono, type Context, type MiddlewareHandler } from 'hono'
import { z } from 'zod'
import { toPttOgg } from '@crm/ai'
import { FsBlobStore } from '@crm/node-kit'
import {
  ChatQueryService,
  ChatSendError,
  ChatSendService,
  mediaDownloadName,
  MessageMediaService,
  ChatsError,
  crmConnectionSessionResolver,
  RealtimePublisher,
  RedisIdempotencyStore,
  SEND_MESSAGE_TYPES,
  toChatDto,
  type ChatActor,
  type ChatPublisher,
  type PttConverter,
  type Sender,
  type SessionResolver,
} from '@crm/core'
import { getCompanyCtx } from '../../lib/context'
import { ApiError } from '../../lib/errors'
import type { AppEnv, ResolvedDeps } from '../../lib/types'
import { validate } from '../../lib/validate'
import { setAudit } from '../../middleware/audit'
import { requirePerm } from '../../middleware/authorize'
import { mediaApiError, mediaServiceFor } from '../media/index'

declare module '../../lib/types' {
  interface AppDeps {
    /** Conexão do CRM → sessão do gateway (padrão: `crm.connections`, T40). */
    resolveSession?: SessionResolver
    /** Áudio → nota de voz Ogg/Opus (padrão: `toPttOgg` de @crm/ai, com ffmpeg). */
    pttConverter?: PttConverter
    /** Publicador realtime dos eventos de chat (padrão: `RealtimePublisher` sobre `redis`). */
    chatPublisher?: ChatPublisher
  }
}

const text = (max: number) => z.string().max(max).nullish()

const sendSchema = z
  .object({
    type: z.enum(SEND_MESSAGE_TYPES).default('text'),
    text: text(65_536),
    media_id: text(2048),
    caption: text(4096),
    ptt: z.boolean().optional(),
    quoted_id: z.uuid().nullish(),
    view_once: z.boolean().optional(),
    location: z.object({ latitude: z.number().min(-90).max(90), longitude: z.number().min(-180).max(180), name: text(200), address: text(500) }).nullish(),
    contact: z.object({ name: z.string().min(1).max(200), phone: z.string().min(8).max(40) }).nullish(),
    pix: z.object({ key: z.string().min(1).max(200), name: text(200), amount_cents: z.int().nonnegative().nullish(), code: text(2000) }).nullish(),
    signature: z.boolean().optional(),
    client_message_id: z.string().min(1).max(200).nullish(),
  })
  .strict()

const reactSchema = z.object({ emoji: z.string().max(32) }).strict()
const forwardSchema = z.object({ chat_id: z.uuid() }).strict()
const listQuery = z.object({ before: z.uuid().optional(), limit: z.coerce.number().int().min(1).max(100).optional() })

const services = new WeakMap<ResolvedDeps, ChatSendService>()

function serviceFor(deps: ResolvedDeps): ChatSendService {
  let svc = services.get(deps)
  if (!svc) {
    if (!deps.waGateway) throw new ApiError('INTERNAL', 'WaGateway não configurado')
    svc = new ChatSendService({
      db: deps.db,
      waGateway: deps.waGateway,
      resolveSession: deps.resolveSession ?? crmConnectionSessionResolver(deps.db),
      media: mediaServiceFor(deps),
      pttConverter: deps.pttConverter ?? ((data) => toPttOgg(data)),
      idempotency: new RedisIdempotencyStore(deps.redis),
      publisher: deps.chatPublisher ?? new RealtimePublisher({ redis: deps.redis }),
      logger: deps.logger,
    })
    services.set(deps, svc)
  }
  return svc
}

/** Erros de domínio → SPEC 3.5. `SendRejectedError` do gateway passa direto (mantém código e HTTP). */
async function domain<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (err) {
    if (err instanceof ChatSendError) {
      if (err.code === 'not_found') throw new ApiError('NOT_FOUND', err.message)
      if (err.code === 'validation') throw new ApiError('VALIDATION_ERROR', err.message, err.details)
      if (err.code === 'session_not_connected') throw new ApiError('SESSION_NOT_CONNECTED', err.message)
      throw new ApiError('CONFLICT', err.message, err.details)
    }
    throw mediaApiError(err)
  }
}

function senderOf(c: Context<AppEnv>): Sender & { companyId: string } {
  const ctx = getCompanyCtx(c)
  if (!ctx.user) throw new ApiError('FORBIDDEN', 'Envio exige um usuário (token sem usuário não envia)')
  return { companyId: ctx.companyId, userId: ctx.user.id, name: ctx.user.name }
}

/** Ator do escopo: sessão age como o usuário; token de API pela empresa inteira (como na T48). */
function actorOf(c: Context<AppEnv>): ChatActor {
  const ctx = getCompanyCtx(c)
  return { companyId: ctx.companyId, userId: ctx.auth.kind === 'session' ? (ctx.user?.id ?? null) : null, perms: ctx.perms }
}

/** Chat fora do escopo (ou de outra empresa) → 404, igual a inexistente (SPEC 3.3). */
async function assertChatVisible(query: ChatQueryService, c: Context<AppEnv>, chatId: string): Promise<void> {
  try {
    await query.row(actorOf(c), chatId)
  } catch (err) {
    if (err instanceof ChatsError && err.code === 'not_found') throw new ApiError('NOT_FOUND', 'Chat não encontrado')
    throw err
  }
}

export function chatMessagesRoutes(deps: ResolvedDeps) {
  const app = new Hono<AppEnv>()
  const perm = requirePerm('chat.view')
  const query = new ChatQueryService(deps.db)
  /** Middleware: `:id` precisa estar no escopo antes de validar o corpo ou tocar no gateway. */
  const scoped: MiddlewareHandler<AppEnv> = async (c, next) => {
    await assertChatVisible(query, c, c.req.param('id') ?? '')
    await next()
  }

  app.get('/api/chats/:id/messages', perm, scoped, validate('query', listQuery), async (c) => {
    const { companyId } = getCompanyCtx(c)
    return c.json(await domain(() => serviceFor(deps).list(companyId, c.req.param('id'), c.req.valid('query'))), 200)
  })

  app.post('/api/chats/:id/messages', perm, scoped, validate('json', sendSchema), async (c) => {
    const s = senderOf(c)
    const b = c.req.valid('json')
    const key = c.req.header('idempotency-key')?.trim() || b.client_message_id || null
    const { message, replay } = await domain(() =>
      serviceFor(deps).send(
        s.companyId,
        c.req.param('id'),
        s,
        {
          type: b.type,
          text: b.text ?? null,
          mediaId: b.media_id ?? null,
          caption: b.caption ?? null,
          ...(b.ptt !== undefined ? { ptt: b.ptt } : {}),
          quotedId: b.quoted_id ?? null,
          ...(b.view_once !== undefined ? { viewOnce: b.view_once } : {}),
          location: b.location ?? null,
          contact: b.contact ?? null,
          pix: b.pix ? { key: b.pix.key, name: b.pix.name ?? null, amountCents: b.pix.amount_cents ?? null, code: b.pix.code ?? null } : null,
          ...(b.signature !== undefined ? { signature: b.signature } : {}),
        },
        key,
      ),
    )
    if (replay) setAudit(c, { skip: true })
    else setAudit(c, { action: 'chat_messages.send', targetType: 'message', targetId: message.id, detail: { chat_id: message.chat_id, type: message.type } })
    return c.json({ message: { ...message, client_message_id: key } }, replay ? 200 : 201)
  })

  app.post('/api/chats/:id/messages/:mid/react', perm, scoped, validate('json', reactSchema), async (c) => {
    const s = senderOf(c)
    const message = await domain(() => serviceFor(deps).react(s.companyId, c.req.param('id'), c.req.param('mid'), c.req.valid('json').emoji, s))
    setAudit(c, { action: 'chat_messages.react', targetType: 'message', targetId: message.id })
    return c.json({ message }, 200)
  })

  app.post('/api/chats/:id/messages/:mid/forward', perm, scoped, validate('json', forwardSchema), async (c) => {
    const s = senderOf(c)
    // O destino também precisa estar no escopo (T119).
    await assertChatVisible(query, c, c.req.valid('json').chat_id)
    const message = await domain(() => serviceFor(deps).forward(s.companyId, c.req.param('id'), c.req.param('mid'), c.req.valid('json').chat_id, s))
    setAudit(c, { action: 'chat_messages.forward', targetType: 'message', targetId: message.id })
    return c.json({ message }, 201)
  })

  app.post('/api/chats/:id/messages/:mid/delete', perm, scoped, async (c) => {
    const s = senderOf(c)
    const message = await domain(() => serviceFor(deps).deleteForEveryone(s.companyId, c.req.param('id'), c.req.param('mid'), s))
    setAudit(c, { action: 'chat_messages.delete', targetType: 'message', targetId: message.id })
    return c.json({ message }, 200)
  })

  app.post('/api/chats/:id/read', perm, scoped, async (c) => {
    const { companyId } = getCompanyCtx(c)
    const chat = await domain(() => serviceFor(deps).markRead(companyId, c.req.param('id')))
    setAudit(c, { skip: true })
    return c.json({ chat: toChatDto(chat) }, 200)
  })

  // T75: mídia da mensagem (saída: o blob enviado; entrada: baixada do WhatsApp na 1ª vez). `?download=1` = anexo.
  app.get('/api/chats/:id/messages/:mid/media', perm, scoped, async (c) => {
    const { companyId } = getCompanyCtx(c)
    if (!deps.waGateway) throw new ApiError('INTERNAL', 'WaGateway não configurado')
    const gateway = deps.waGateway
    // Lido na requisição: o harness E2E injeta o blobStore nas deps depois de montar as rotas.
    const svc = new MessageMediaService({ db: deps.db, blobs: deps.blobStore ?? new FsBlobStore(), downloadMedia: (s, ref) => gateway.downloadMedia(s, ref) })
    const mid = c.req.param('mid')
    const media = await domain(() => svc.get(companyId, c.req.param('id'), mid))
    const name = mediaDownloadName(media.type, mid, media.mime, media.fileName)
    const disposition = c.req.query('download') === '1' ? 'attachment' : 'inline'
    setAudit(c, { skip: true })
    return c.body(new Uint8Array(media.data), 200, {
      'content-type': media.mime,
      'content-length': String(media.data.byteLength),
      'content-disposition': `${disposition}; filename*=UTF-8''${encodeURIComponent(name)}`,
      'cache-control': 'private, max-age=3600',
      'x-content-type-options': 'nosniff',
    })
  })

  // T75: reenvio de mensagem com falha (mesmo conteúdo, pelo pipeline).
  app.post('/api/chats/:id/messages/:mid/retry', perm, scoped, async (c) => {
    const s = senderOf(c)
    const message = await domain(() => serviceFor(deps).retry(s.companyId, c.req.param('id'), c.req.param('mid'), s))
    setAudit(c, { action: 'chat_messages.retry', targetType: 'message', targetId: message.id })
    return c.json({ message }, 200)
  })

  return app
}
