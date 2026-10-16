// Mídia de uma mensagem do chat (T75; spec 03 F25/F46): saída = o blob enviado (sha256 em `media.key`); entrada =
// baixada do WhatsApp sob demanda pelo `WaGateway.downloadMedia`, gravada no BlobStore e lembrada na mensagem
// (`media.key`/`media.sha256`), para não baixar de novo. O chamador já validou o escopo do chat (T119).
import { and, eq } from 'drizzle-orm'
import { messages, type Database } from '@crm/db'
import type { BlobStore } from '@crm/node-kit'
import type { MediaHandle, WaGateway } from '@crm/wa-port'
import { ChatSendError } from './service'

export const MEDIA_MESSAGE_TYPES = ['image', 'video', 'audio', 'document', 'sticker'] as const

export interface MessageMedia {
  data: Buffer
  mime: string
  fileName: string | null
  /** Tipo da mensagem (image, video, audio, document, sticker). */
  type: string
}

export interface MessageMediaServiceOptions {
  db: Database
  blobs: Pick<BlobStore, 'get' | 'put'>
  downloadMedia: WaGateway['downloadMedia']
}

const SHA256 = /^[0-9a-f]{64}$/

const extOf: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'video/mp4': 'mp4',
  'audio/ogg': 'ogg',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'application/pdf': 'pdf',
}

/** Nome do arquivo para o download: o original, senão `<tipo>-<id>.<ext>`. */
export function mediaDownloadName(type: string, messageId: string, mime: string, fileName: string | null): string {
  if (fileName?.trim()) return fileName.trim()
  const ext = extOf[mime.split(';')[0]!.trim().toLowerCase()] ?? 'bin'
  return `${type}-${messageId.slice(0, 8)}.${ext}`
}

export class MessageMediaService {
  constructor(private readonly opts: MessageMediaServiceOptions) {}

  async get(companyId: string, chatId: string, messageId: string): Promise<MessageMedia> {
    const [row] = await this.opts.db
      .select()
      .from(messages)
      .where(and(eq(messages.companyId, companyId), eq(messages.chatId, chatId), eq(messages.id, messageId)))
      .limit(1)
    if (!row) throw new ChatSendError('not_found', 'Mensagem não encontrada')
    const media = (row.media ?? null) as Record<string, unknown> | null
    if (row.deletedAt || !media || !(MEDIA_MESSAGE_TYPES as readonly string[]).includes(row.type)) throw new ChatSendError('not_found', 'Mensagem sem mídia')
    const mime = typeof media.mime === 'string' && media.mime ? media.mime : 'application/octet-stream'
    const fileName = typeof media.file_name === 'string' ? media.file_name : null

    // Já no BlobStore (saída, ou entrada baixada antes).
    for (const k of [media.key, media.sha256]) {
      if (typeof k !== 'string' || !SHA256.test(k)) continue
      const data = await this.opts.blobs.get(k).catch(() => null)
      if (data) return { data, mime, fileName, type: row.type }
    }

    // Entrada: baixa do WhatsApp pelo handle do gateway.
    if (row.direction !== 'inbound' || typeof media.session_id !== 'string' || typeof media.message_id !== 'string')
      throw new ChatSendError('not_found', 'Mídia indisponível')
    let bytes: Uint8Array
    try {
      const body = await this.opts.downloadMedia(media.session_id, media as unknown as MediaHandle)
      bytes = body instanceof Uint8Array ? body : new Uint8Array(await new Response(body).arrayBuffer())
    } catch {
      throw new ChatSendError('not_found', 'Mídia indisponível no WhatsApp')
    }
    const info = await this.opts.blobs.put(bytes, mime)
    await this.opts.db
      .update(messages)
      .set({ media: { ...media, key: info.key, sha256: info.key, size: bytes.byteLength, status: 'ready' } })
      .where(eq(messages.id, row.id))
    return { data: Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength), mime, fileName, type: row.type }
  }
}
