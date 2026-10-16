import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FsBlobStore } from '@crm/node-kit'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MemoryIdempotencyStore } from '../chats/send/idempotency'
import { pixText, vcardOf } from '../chats/send/service'
import { blobUrl, MediaError, MediaService, mediaKindOf } from './service'

let dir: string
let svc: MediaService
const A = '11111111-1111-4111-8111-111111111111'
const B = '22222222-2222-4222-8222-222222222222'

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 't49-media-'))
  svc = new MediaService({ blobStore: new FsBlobStore(dir), signingKey: Buffer.alloc(32, 7), limits: { image: 10, document: 20 } })
})

afterAll(async () => {
  await rm(dir, { recursive: true, force: true })
})

const codeOf = (p: Promise<unknown>) => p.then(() => 'ok', (e) => (e instanceof MediaError ? e.code : 'other'))

describe('MediaService', () => {
  it('limite por tipo (413), mime não aceito (415) e tipo pelo mime', async () => {
    expect(mediaKindOf('audio/ogg; codecs=opus')).toBe('audio')
    expect(mediaKindOf('application/x-msdownload')).toBeNull()
    expect(await codeOf(svc.upload(A, new Uint8Array(11), 'image/png'))).toBe('payload_too_large')
    expect(await codeOf(svc.upload(A, new Uint8Array(11), 'application/pdf'))).toBe('ok')
    expect(await codeOf(svc.upload(A, new Uint8Array(1), 'application/x-msdownload'))).toBe('unsupported_media')
  })

  it('id vale só na empresa do upload; adulterado → not_found', async () => {
    const m = await svc.upload(A, new TextEncoder().encode('%PDF-1'), 'application/pdf', 'nota.pdf')
    expect(m).toMatchObject({ kind: 'document', mime: 'application/pdf', size: 6, file_name: 'nota.pdf' })
    const got = await svc.get(A, m.id)
    expect(got.data.toString()).toBe('%PDF-1')
    expect(await codeOf(svc.get(B, m.id))).toBe('not_found')
    expect(await codeOf(svc.get(A, `${m.id}x`))).toBe('not_found')
    const [payload] = m.id.split('.')
    expect(await codeOf(svc.get(A, `${payload}.AAAA`))).toBe('not_found')
    expect(blobUrl(m.sha256)).toBe(`blob:${m.sha256}`)
  })
})

describe('auxiliares de envio', () => {
  it('Pix em texto e vCard', () => {
    expect(pixText({ key: 'chave@x.com', name: 'Loja', amountCents: 1990, code: '000201' })).toContain('Chave Pix: chave@x.com')
    expect(pixText({ key: 'k', amountCents: 1990 })).toMatch(/R\$\s?19,90/)
    expect(vcardOf({ name: 'Ana', phone: '+55 11 99999-8888' })).toContain('waid=5511999998888')
  })

  it('idempotência em memória', async () => {
    const s = new MemoryIdempotencyStore()
    expect(await s.claim('k')).toEqual({ state: 'new' })
    expect(await s.claim('k')).toEqual({ state: 'pending' })
    await s.complete('k', 'm1')
    expect(await s.claim('k')).toEqual({ state: 'done', messageId: 'm1' })
    await s.release('k')
    expect(await s.claim('k')).toEqual({ state: 'new' })
  })
})
