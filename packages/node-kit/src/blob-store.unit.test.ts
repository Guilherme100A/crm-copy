import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FsBlobStore, InvalidBlobKeyError } from './blob-store'

describe('FsBlobStore (AC-T05-04)', () => {
  let dir: string
  let store: FsBlobStore
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'node-kit-blob-'))
    store = new FsBlobStore({ dir })
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('put devolve { key, size, sha256, mime } e get os mesmos bytes', async () => {
    const data = Buffer.from('olá mundo')
    const sha = createHash('sha256').update(data).digest('hex')
    const info = await store.put(data, 'text/plain')
    expect(info).toEqual({ key: sha, size: data.length, sha256: sha, mime: 'text/plain' })
    expect((await store.get(info.key))!.equals(data)).toBe(true)
    expect(await store.head(info.key)).toEqual(info)
    expect(await store.has(info.key)).toBe(true)
  })

  it('mesmo conteúdo → mesma chave (dedupe); aceita Uint8Array', async () => {
    const a = await store.put(new Uint8Array([1, 2, 3]), 'application/octet-stream')
    const b = await store.put(Buffer.from([1, 2, 3]), 'application/octet-stream')
    expect(a.key).toBe(b.key)
  })

  it('chave com .. ou separadores é rejeitada', async () => {
    for (const k of ['..', '../etc/passwd', `${'a'.repeat(62)}/..`, 'a\\..\\b', ''])
      await expect(store.get(k)).rejects.toBeInstanceOf(InvalidBlobKeyError)
    await expect(store.delete('../x')).rejects.toBeInstanceOf(InvalidBlobKeyError)
  })

  it('aceita o diretório como string', async () => {
    const s = new FsBlobStore(dir)
    expect(s.dir).toBe(store.dir)
    const info = await s.put(Buffer.from('y'), 'text/plain')
    expect((await store.get(info.key))!.toString()).toBe('y')
  })

  it('inexistente → null; delete remove', async () => {
    const info = await store.put(Buffer.from('x'), 'text/plain')
    await store.delete(info.key)
    expect(await store.get(info.key)).toBeNull()
    expect(await store.head(info.key)).toBeNull()
    expect(await store.has(info.key)).toBe(false)
  })
})
