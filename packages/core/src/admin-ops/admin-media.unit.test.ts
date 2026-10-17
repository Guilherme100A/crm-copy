// Imagens globais do admin (T100): tipo pelos bytes, teto, id assinado.
import { createHash, randomBytes } from 'node:crypto'
import type { BlobInfo, BlobStore } from '@crm/node-kit'
import { describe, expect, it } from 'vitest'
import { AdminMediaService, sniffImageMime } from './admin-media'
import { AdminOpsError } from './errors'

class MemoryBlobs implements BlobStore {
  readonly map = new Map<string, { data: Buffer; mime: string }>()
  async put(data: Buffer | Uint8Array, mime: string): Promise<BlobInfo> {
    const buf = Buffer.from(data)
    const key = createHash('sha256').update(buf).digest('hex')
    this.map.set(key, { data: buf, mime })
    return { key, size: buf.length, sha256: key, mime }
  }
  async get(key: string) {
    return this.map.get(key)?.data ?? null
  }
  async head(key: string) {
    const v = this.map.get(key)
    return v ? { key, size: v.data.length, sha256: key, mime: v.mime } : null
  }
  async has(key: string) {
    return this.map.has(key)
  }
  async delete(key: string) {
    this.map.delete(key)
  }
}

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), randomBytes(16)])
const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), randomBytes(16)])
const GIF = Buffer.concat([Buffer.from('GIF89a'), randomBytes(8)])
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), randomBytes(8)])

describe('sniffImageMime', () => {
  it('reconhece PNG, JPEG, GIF e WebP; recusa o resto', () => {
    expect(sniffImageMime(PNG)).toBe('image/png')
    expect(sniffImageMime(JPG)).toBe('image/jpeg')
    expect(sniffImageMime(GIF)).toBe('image/gif')
    expect(sniffImageMime(WEBP)).toBe('image/webp')
    expect(sniffImageMime(Buffer.from('<svg/>'))).toBeNull()
    expect(sniffImageMime(Buffer.from('%PDF-1.7'))).toBeNull()
    expect(sniffImageMime(new Uint8Array())).toBeNull()
  })
})

describe('AdminMediaService', () => {
  const key = randomBytes(32)

  it('upload devolve id `<sha256>.<sig>` e get devolve os bytes com o tipo real', async () => {
    const svc = new AdminMediaService({ blobStore: new MemoryBlobs(), signingKey: key })
    const info = await svc.upload(PNG, 'image/png')
    expect(info.id).toMatch(/^[a-f0-9]{64}\.[A-Za-z0-9_-]{22}$/)
    const got = await svc.get(info.id)
    expect(got?.mime).toBe('image/png')
    expect(got?.data.equals(PNG)).toBe(true)
  })

  it('tipo declarado fora da lista, bytes que não são imagem, vazio e acima do teto → validation em `file`', async () => {
    const svc = new AdminMediaService({ blobStore: new MemoryBlobs(), signingKey: key, maxBytes: 64 })
    for (const [data, mime] of [
      [PNG, 'image/svg+xml'],
      [Buffer.from('nao é imagem'), 'image/png'],
      [Buffer.alloc(0), 'image/png'],
      [Buffer.concat([PNG, Buffer.alloc(100)]), 'image/png'],
    ] as const) {
      const err = await svc.upload(data, mime).catch((e: unknown) => e)
      expect(err).toBeInstanceOf(AdminOpsError)
      expect((err as AdminOpsError).code).toBe('validation')
      expect((err as AdminOpsError).details).toMatchObject({ fields: [{ path: 'file' }] })
    }
  })

  it('id com assinatura de outra chave, sem assinatura ou malformado → null', async () => {
    const blobs = new MemoryBlobs()
    const svc = new AdminMediaService({ blobStore: blobs, signingKey: key })
    const other = new AdminMediaService({ blobStore: blobs, signingKey: randomBytes(32) })
    const info = await other.upload(JPG, 'image/jpeg')
    expect(await svc.get(info.id)).toBeNull()
    expect(await svc.get(info.id.split('.')[0]!)).toBeNull()
    expect(await svc.get('../../etc/passwd')).toBeNull()
  })
})
