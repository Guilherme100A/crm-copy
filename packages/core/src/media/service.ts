// Mídia enviada pelo CRM (SPEC T49; 03-chats F32–F36): upload com limites por tipo, bytes no BlobStore e id opaco
// assinado por empresa (HMAC), de modo que só a empresa que fez o upload consegue ler ou usar a mídia.
// O blob é endereçado por conteúdo (sha256); o id carrega a chave e o mime e não precisa de tabela.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { CredentialsKeyError, loadCredentialsKey, type BlobStore } from '@crm/node-kit'

export type MediaKind = 'image' | 'video' | 'audio' | 'document'

/** Limites por tipo (03-chats): imagem e vídeo 20 MB, áudio 16 MB, documento 30 MB. */
export const DEFAULT_MEDIA_LIMITS: Readonly<Record<MediaKind, number>> = {
  image: 20 * 1024 * 1024,
  video: 20 * 1024 * 1024,
  audio: 16 * 1024 * 1024,
  document: 30 * 1024 * 1024,
}

/** Mimes aceitos (sem parâmetros) → tipo. Outro mime → 415. */
export const ACCEPTED_MEDIA_MIMES: Readonly<Record<string, MediaKind>> = {
  'image/jpeg': 'image',
  'image/png': 'image',
  'image/webp': 'image',
  'image/gif': 'image',
  'video/mp4': 'video',
  'video/3gpp': 'video',
  'video/quicktime': 'video',
  'audio/ogg': 'audio',
  'audio/mpeg': 'audio',
  'audio/mp4': 'audio',
  'audio/aac': 'audio',
  'audio/amr': 'audio',
  'audio/wav': 'audio',
  'audio/webm': 'audio',
  'audio/x-m4a': 'audio',
  'application/pdf': 'document',
  'application/msword': 'document',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'document',
  'application/vnd.ms-excel': 'document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'document',
  'application/vnd.ms-powerpoint': 'document',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'document',
  'application/zip': 'document',
  'text/plain': 'document',
  'text/csv': 'document',
}

export type MediaErrorCode = 'unsupported_media' | 'payload_too_large' | 'not_found'

export class MediaError extends Error {
  constructor(
    readonly code: MediaErrorCode,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message)
    this.name = 'MediaError'
  }
}

export interface MediaInfo {
  id: string
  mime: string
  size: number
  kind: MediaKind
  sha256: string
  file_name: string | null
}

export interface StoredMedia extends MediaInfo {
  data: Buffer
}

/** `audio/ogg; codecs=opus` → `audio/ogg`. */
export const baseMime = (mime: string) => mime.split(';')[0]!.trim().toLowerCase()

export function mediaKindOf(mime: string): MediaKind | null {
  return ACCEPTED_MEDIA_MIMES[baseMime(mime)] ?? null
}

/** Referência do blob para o gateway (o wa-engine lê do BlobStore compartilhado). */
export const blobUrl = (sha256: string) => `blob:${sha256}`

const b64url = (b: Buffer | string) => Buffer.from(b).toString('base64url')

let ephemeralKey: Buffer | undefined

/**
 * Chave de assinatura padrão: derivada de `CREDENTIALS_KEY`, separada por finalidade. Sem a variável (dev/testes;
 * em produção ela é obrigatória para as credenciais do WhatsApp), usa uma chave aleatória do processo: os ids
 * valem até o próximo restart.
 */
export function defaultMediaSigningKey(): Buffer {
  let base: Buffer
  try {
    base = loadCredentialsKey()
  } catch (err) {
    if (!(err instanceof CredentialsKeyError)) throw err
    base = ephemeralKey ??= randomBytes(32)
  }
  return createHmac('sha256', base).update('crm:media-id:v1').digest()
}

export interface MediaServiceOptions {
  blobStore: BlobStore
  /** Chave do HMAC dos ids. Padrão: derivada de `CREDENTIALS_KEY`. */
  signingKey?: Buffer
  limits?: Partial<Record<MediaKind, number>>
}

export class MediaService {
  private readonly blobs: BlobStore
  private readonly key: Buffer
  readonly limits: Readonly<Record<MediaKind, number>>

  constructor(opts: MediaServiceOptions) {
    this.blobs = opts.blobStore
    this.key = opts.signingKey ?? defaultMediaSigningKey()
    this.limits = { ...DEFAULT_MEDIA_LIMITS, ...opts.limits }
  }

  /** Valida mime (415) e tamanho do tipo (413), grava o blob e devolve o id da empresa. */
  async upload(companyId: string, data: Uint8Array, mime: string, fileName?: string | null): Promise<MediaInfo> {
    const kind = mediaKindOf(mime)
    if (!kind) throw new MediaError('unsupported_media', 'Tipo de arquivo não aceito', { mime })
    if (data.byteLength > this.limits[kind])
      throw new MediaError('payload_too_large', 'Arquivo acima do limite do tipo', { kind, limit: this.limits[kind], size: data.byteLength })
    return this.store(companyId, data, mime, fileName ?? null)
  }

  /** Grava sem validar limites (ex.: áudio convertido para PTT). */
  async store(companyId: string, data: Uint8Array, mime: string, fileName: string | null = null): Promise<MediaInfo> {
    const info = await this.blobs.put(Buffer.from(data.buffer, data.byteOffset, data.byteLength), mime)
    return this.describe(companyId, info.key, mime, data.byteLength, fileName)
  }

  /** Bytes da mídia, só se o id foi emitido para esta empresa; senão `not_found`. */
  async get(companyId: string, id: string): Promise<StoredMedia> {
    const parsed = this.verify(companyId, id)
    if (!parsed) throw new MediaError('not_found', 'Mídia não encontrada')
    const data = await this.blobs.get(parsed.sha256).catch(() => null)
    if (!data) throw new MediaError('not_found', 'Mídia não encontrada')
    return { ...this.describe(companyId, parsed.sha256, parsed.mime, data.byteLength, parsed.fileName), data }
  }

  /** Metadados a partir do id (sem ler os bytes). */
  async info(companyId: string, id: string): Promise<MediaInfo> {
    const parsed = this.verify(companyId, id)
    if (!parsed) throw new MediaError('not_found', 'Mídia não encontrada')
    const head = await this.blobs.head(parsed.sha256).catch(() => null)
    if (!head) throw new MediaError('not_found', 'Mídia não encontrada')
    return this.describe(companyId, parsed.sha256, parsed.mime, head.size, parsed.fileName)
  }

  private describe(companyId: string, sha256: string, mime: string, size: number, fileName: string | null): MediaInfo {
    const payload = b64url(JSON.stringify({ s: sha256, m: mime, ...(fileName ? { n: fileName } : {}) }))
    const id = `${payload}.${this.sign(companyId, payload)}`
    return { id, mime, size, kind: mediaKindOf(mime) ?? 'document', sha256, file_name: fileName }
  }

  private sign(companyId: string, payload: string): string {
    return createHmac('sha256', this.key).update(`${companyId}:${payload}`).digest('base64url')
  }

  private verify(companyId: string, id: string): { sha256: string; mime: string; fileName: string | null } | null {
    const [payload, sig, extra] = id.split('.')
    if (!payload || !sig || extra !== undefined) return null
    const expected = Buffer.from(this.sign(companyId, payload))
    const given = Buffer.from(sig)
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null
    try {
      const v = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { s?: unknown; m?: unknown; n?: unknown }
      if (typeof v.s !== 'string' || !/^[a-f0-9]{64}$/.test(v.s) || typeof v.m !== 'string') return null
      return { sha256: v.s, mime: v.m, fileName: typeof v.n === 'string' ? v.n : null }
    } catch {
      return null
    }
  }
}
