import { describe, expect, it, vi } from 'vitest'
import { BlobRefNotFoundError, resolveBlobRefs, withBlobRefs } from './blob-refs'
import { loadWaWorkerConfig, WaWorkerConfigError } from './config'

const base = { DATABASE_URL: 'postgres://x', REDIS_URL: 'redis://x', CREDENTIALS_KEY: 'k', INTERNAL_TOKEN: 't' }

describe('loadWaWorkerConfig', () => {
  it('defaults e validações', () => {
    expect(loadWaWorkerConfig(base)).toMatchObject({
      transport: 'baileys',
      rpcPort: 3100,
      rpcHost: '127.0.0.1',
      queuePrefix: 'wsm',
      eventsStream: 'wsm:events',
      antibanMode: 'real',
    })
    expect(loadWaWorkerConfig({ ...base, WA_TRANSPORT: 'FAKE', WA_RPC_PORT: '0', WA_QUEUE_PREFIX: 'x', ANTIBAN_MODE: 'passthrough' })).toMatchObject({
      transport: 'fake',
      rpcPort: 0,
      queuePrefix: 'x',
      antibanMode: 'passthrough',
    })
    expect(() => loadWaWorkerConfig({})).toThrow(WaWorkerConfigError)
    expect(() => loadWaWorkerConfig({ ...base, WA_TRANSPORT: 'cloud' })).toThrow(WaWorkerConfigError)
    expect(() => loadWaWorkerConfig({ ...base, WA_RPC_PORT: '70000' })).toThrow(WaWorkerConfigError)
  })
})

describe('blob refs', () => {
  const store = { get: vi.fn(async (key: string) => (key === 'a'.repeat(64) ? Buffer.from([1, 2]) : null)) }

  it('troca blob:<sha256> pelos bytes; demais conteúdos passam intactos', async () => {
    expect(await resolveBlobRefs({ image: { url: `blob:${'a'.repeat(64)}` }, caption: 'oi' }, store)).toEqual({
      image: { data: new Uint8Array([1, 2]) },
      caption: 'oi',
    })
    const text = { text: 'oi' }
    expect(await resolveBlobRefs(text, store)).toBe(text)
    const url = { document: { url: 'https://x/y.pdf' }, mimetype: 'application/pdf' }
    expect(await resolveBlobRefs(url, store)).toBe(url)
    await expect(resolveBlobRefs({ audio: { url: 'blob:nao-existe' } }, store)).rejects.toBeInstanceOf(BlobRefNotFoundError)
  })

  it('withBlobRefs entrega o conteúdo resolvido ao deliver', async () => {
    const deliver = vi.fn(async () => ({ messageId: 'w1' }))
    const wrapped = withBlobRefs(deliver, store)
    await wrapped({} as never, '55@s.whatsapp.net', { sticker: { url: `blob:${'a'.repeat(64)}` } })
    expect(deliver).toHaveBeenCalledWith({}, '55@s.whatsapp.net', { sticker: { data: new Uint8Array([1, 2]) } })
  })
})
