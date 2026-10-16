// MediaService (T21, AI-MANAGER-MAP §13.5 A2): baixa a mídia recebida e grava no BlobStore.
// Eager (áudio, imagem, documento até o limite): baixa antes de publicar o `message.inbound`, que já sai com
// `media.key`. Lazy (vídeo, figurinha, acima do limite): o evento sai `pending` e o download vem sob demanda
// (`fetch`, RPC `media.download` na T29). Mídia expirada (410) pede reupload UMA vez; falha definitiva vira
// `status: 'unavailable'` e o evento é publicado mesmo assim.
import { sha256Hex, type BlobStore } from '@crm/node-kit'
import type { MediaHandle } from '@crm/wa-port'
import type { IncomingMediaKind, IncomingMessage, WaTransport } from '../transport'

export const DEFAULT_EAGER_KINDS: readonly IncomingMediaKind[] = ['image', 'audio', 'document']
/** Acima disso a mídia vira lazy (vídeos e documentos grandes). */
export const DEFAULT_EAGER_MAX_BYTES = 16 * 1024 * 1024

export interface MediaLogger {
  warn(obj: object, msg?: string): void
}

export interface MediaServiceOptions {
  blobStore: BlobStore
  /** Bytes da mídia. Default: `getTransport(sessionId).downloadMedia(messageId)`. */
  download?: (sessionId: string, messageId: string) => Promise<Uint8Array>
  /** Pede ao WhatsApp para reenviar a mídia expirada (`reuploadRequest`). Default: nada (o Baileys já tenta internamente). */
  reupload?: (sessionId: string, messageId: string) => Promise<unknown>
  getTransport?: (sessionId: string) => Pick<WaTransport, 'downloadMedia'> | undefined
  eagerKinds?: readonly IncomingMediaKind[]
  eagerMaxBytes?: number
  logger?: MediaLogger
}

export interface FetchedMedia {
  handle: MediaHandle
  bytes: Uint8Array
}

export class MediaUnavailableForSessionError extends Error {
  readonly code = 'MEDIA_UNAVAILABLE'
  constructor(
    readonly sessionId: string,
    readonly messageId: string,
    message = `mídia da mensagem ${messageId} indisponível`,
  ) {
    super(message)
    this.name = 'MediaUnavailableForSessionError'
  }
}

/** Download respondido com 410 (mídia expirada no CDN do WhatsApp). */
export function isMediaExpiredError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false
  const e = err as { status?: unknown; statusCode?: unknown; output?: { statusCode?: unknown }; data?: { statusCode?: unknown }; message?: unknown }
  if (e.status === 410 || e.statusCode === 410 || e.output?.statusCode === 410 || e.data?.statusCode === 410) return true
  return typeof e.message === 'string' && /\b410\b|\bgone\b/i.test(e.message)
}

const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err))

export class MediaService {
  private readonly eagerKinds: ReadonlySet<IncomingMediaKind>
  private readonly eagerMaxBytes: number

  constructor(private readonly opts: MediaServiceOptions) {
    this.eagerKinds = new Set(opts.eagerKinds ?? DEFAULT_EAGER_KINDS)
    this.eagerMaxBytes = opts.eagerMaxBytes ?? DEFAULT_EAGER_MAX_BYTES
  }

  /** O download desta mídia é feito antes de publicar o evento? */
  isEager(media: NonNullable<IncomingMessage['media']>): boolean {
    return this.eagerKinds.has(media.kind) && (media.size === null || media.size <= this.eagerMaxBytes)
  }

  /**
   * Handle da mídia para o `message.inbound`: eager → baixa e grava (`ready`, ou `unavailable` se falhar de vez);
   * lazy → `pending`. Nunca lança: a mídia não bloqueia o evento. Mensagem sem mídia → `undefined`.
   */
  async describe(sessionId: string, msg: Pick<IncomingMessage, 'id' | 'media' | 'historical'>): Promise<MediaHandle | undefined> {
    const media = msg.media
    if (!media) return undefined
    // Histórico chega em lotes grandes: só descreve; o download fica sob demanda.
    if (msg.historical || !this.isEager(media)) return this.declared(sessionId, msg.id, media, 'pending')
    try {
      return (await this.fetch(sessionId, msg.id, media)).handle
    } catch (err) {
      this.opts.logger?.warn({ session_id: sessionId, message_id: msg.id, err: errorMessage(err) }, 'mídia indisponível')
      return this.declared(sessionId, msg.id, media, 'unavailable')
    }
  }

  /** Baixa (com um reupload em 410), grava no BlobStore e devolve o handle `ready` + bytes. */
  async fetch(sessionId: string, messageId: string, media?: Pick<NonNullable<IncomingMessage['media']>, 'mime' | 'file_name'>): Promise<FetchedMedia> {
    const bytes = await this.downloadWithReupload(sessionId, messageId)
    if (bytes.byteLength === 0) throw new MediaUnavailableForSessionError(sessionId, messageId, 'mídia vazia')
    const mime = media?.mime ?? 'application/octet-stream'
    const info = await this.opts.blobStore.put(bytes, mime)
    const handle: MediaHandle = {
      session_id: sessionId,
      message_id: messageId,
      mime,
      size: info.size,
      sha256: info.sha256 ?? sha256Hex(bytes),
      key: info.key,
      status: 'ready',
    }
    if (media?.file_name) handle.file_name = media.file_name
    return { handle, bytes }
  }

  private async downloadWithReupload(sessionId: string, messageId: string): Promise<Uint8Array> {
    try {
      return await this.download(sessionId, messageId)
    } catch (err) {
      if (!isMediaExpiredError(err) || !this.opts.reupload) throw err
      await this.opts.reupload(sessionId, messageId)
      return this.download(sessionId, messageId)
    }
  }

  private download(sessionId: string, messageId: string): Promise<Uint8Array> {
    if (this.opts.download) return this.opts.download(sessionId, messageId)
    const transport = this.opts.getTransport?.(sessionId)
    if (!transport) return Promise.reject(new MediaUnavailableForSessionError(sessionId, messageId, `sessão ${sessionId} sem transporte`))
    return transport.downloadMedia(messageId)
  }

  private declared(sessionId: string, messageId: string, media: NonNullable<IncomingMessage['media']>, status: 'pending' | 'unavailable'): MediaHandle {
    const handle: MediaHandle = { session_id: sessionId, message_id: messageId, mime: media.mime, size: media.size, sha256: media.sha256, key: null, status }
    if (media.file_name) handle.file_name = media.file_name
    return handle
  }
}
