// Imagens globais do admin (T100; 20-admin-interno.md §3.6 e §3.7): upload de imagem de aviso/banner que qualquer
// cliente, de qualquer empresa, consegue ver. Os bytes vão para o BlobStore compartilhado (chave = sha256); o id
// público é `<sha256>.<assinatura>`, um HMAC da chave, para que só blobs enviados por aqui sejam servidos pela rota
// pública (o mesmo store guarda mídias de chat e avatares, que nunca podem vazar por esta rota).
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { CredentialsKeyError, loadCredentialsKey, type BlobStore } from '@crm/node-kit'
import { invalid } from './errors'

/** Teto do arquivo (20 §3.7: imagem leve de banner/aviso). */
export const ADMIN_MEDIA_MAX_BYTES = 2 * 1024 * 1024

/** Só imagens raster (SVG fica fora: é documento ativo servido sem sessão). */
export const ADMIN_MEDIA_MIMES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const
export type AdminMediaMime = (typeof ADMIN_MEDIA_MIMES)[number]

/** Caminho público que serve a imagem (registrado em `public-routes.ts` da API). */
export const ADMIN_MEDIA_PUBLIC_PATH = '/api/public/admin-media'

export interface AdminMediaInfo {
  id: string
  mime: AdminMediaMime
  size: number
}

export interface StoredAdminMedia extends AdminMediaInfo {
  data: Buffer
}

const ID_RE = /^([a-f0-9]{64})\.([A-Za-z0-9_-]{22})$/

let ephemeralKey: Buffer | undefined

/** Chave da assinatura: derivada de `CREDENTIALS_KEY`, separada por finalidade (sem ela, aleatória do processo). */
export function defaultAdminMediaSigningKey(): Buffer {
  let base: Buffer
  try {
    base = loadCredentialsKey()
  } catch (err) {
    if (!(err instanceof CredentialsKeyError)) throw err
    base = ephemeralKey ??= randomBytes(32)
  }
  return createHmac('sha256', base).update('crm:admin-media:v1').digest()
}

/** Tipo real pelos primeiros bytes: o `Content-Type` do multipart é declarado pelo cliente. */
export function sniffImageMime(data: Uint8Array): AdminMediaMime | null {
  const b = data
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png'
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg'
  if (b.length >= 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return 'image/gif'
  if (
    b.length >= 12 &&
    b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
    b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50
  )
    return 'image/webp'
  return null
}

export interface AdminMediaServiceOptions {
  blobStore: BlobStore
  /** Chave do HMAC dos ids. Padrão: derivada de `CREDENTIALS_KEY`. */
  signingKey?: Buffer
  /** Teto em bytes (padrão `ADMIN_MEDIA_MAX_BYTES`). */
  maxBytes?: number
}

export class AdminMediaService {
  private readonly blobs: BlobStore
  private readonly key: Buffer
  readonly maxBytes: number

  constructor(opts: AdminMediaServiceOptions) {
    this.blobs = opts.blobStore
    this.key = opts.signingKey ?? defaultAdminMediaSigningKey()
    this.maxBytes = opts.maxBytes ?? ADMIN_MEDIA_MAX_BYTES
  }

  /** Valida tamanho e tipo (422 `file`), grava o blob e devolve o id público. */
  async upload(data: Uint8Array, declaredMime: string): Promise<AdminMediaInfo> {
    if (data.byteLength === 0) throw invalid('file', 'Arquivo vazio')
    if (data.byteLength > this.maxBytes) throw invalid('file', 'Imagem acima de 2 MB')
    const mime = sniffImageMime(data)
    if (!mime || (declaredMime && !(ADMIN_MEDIA_MIMES as readonly string[]).includes(declaredMime)))
      throw invalid('file', 'Envie uma imagem PNG, JPG, GIF ou WebP')
    const info = await this.blobs.put(Buffer.from(data.buffer, data.byteOffset, data.byteLength), mime)
    return { id: `${info.key}.${this.sign(info.key)}`, mime, size: data.byteLength }
  }

  /** Bytes da imagem, ou `null` se o id não foi emitido aqui ou o blob sumiu. */
  async get(id: string): Promise<StoredAdminMedia | null> {
    const m = ID_RE.exec(id)
    if (!m) return null
    const [, key, sig] = m as unknown as [string, string, string]
    const expected = Buffer.from(this.sign(key))
    const given = Buffer.from(sig)
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null
    const data = await this.blobs.get(key).catch(() => null)
    if (!data) return null
    // O mime servido sai dos bytes (nunca do que foi declarado no upload).
    const mime = sniffImageMime(data)
    if (!mime) return null
    return { id, mime, size: data.byteLength, data }
  }

  private sign(key: string): string {
    return createHmac('sha256', this.key).update(key).digest('base64url').slice(0, 22)
  }
}
