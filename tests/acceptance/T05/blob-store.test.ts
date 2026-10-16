// AC-T05-04 — BlobStore (porta) + FsBlobStore em disco (STORAGE_DIR). Contrato: `new FsBlobStore(dir)`.
import { createHash, randomBytes } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { caught, freshKit, tempDir, toBuffer, type Kit } from './kit'

let tmp: ReturnType<typeof tempDir>
let storeDir: string

async function makeStore(): Promise<{ kit: Kit; store: Kit }> {
  vi.stubEnv('STORAGE_DIR', storeDir)
  const kit = await freshKit()
  return { kit, store: new kit.FsBlobStore(storeDir) }
}

describe('T05 — FsBlobStore', () => {
  beforeEach(() => {
    tmp = tempDir('blob')
    storeDir = join(tmp.dir, 'storage')
  })
  afterEach(() => {
    vi.unstubAllEnvs()
    tmp.cleanup()
  })

  it('AC-T05-04 put(buffer, mime) devolve { key, size, sha256, mime }', async () => {
    const { store } = await makeStore()
    const buf = randomBytes(4096)
    const res = await store.put(buf, 'image/png')
    expect(typeof res.key).toBe('string')
    expect(res.key.length).toBeGreaterThan(0)
    expect(res.size).toBe(buf.length)
    expect(res.sha256).toBe(createHash('sha256').update(buf).digest('hex'))
    expect(res.mime).toBe('image/png')
  })

  it('AC-T05-04 get(key) devolve os mesmos bytes (binário e vazio)', async () => {
    const { store } = await makeStore()
    for (const buf of [randomBytes(10_000), Buffer.from([0, 255, 0, 13, 10]), Buffer.alloc(0)]) {
      const { key } = await store.put(buf, 'application/octet-stream')
      const out = toBuffer(await store.get(key))
      expect(Buffer.compare(out, buf)).toBe(0)
    }
  })

  it('AC-T05-04 conteúdos diferentes não colidem', async () => {
    const { store } = await makeStore()
    const a = Buffer.from('conteudo-a')
    const b = Buffer.from('conteudo-b')
    const ka = (await store.put(a, 'text/plain')).key
    const kb = (await store.put(b, 'text/plain')).key
    expect(ka).not.toBe(kb)
    expect(toBuffer(await store.get(ka)).toString()).toBe('conteudo-a')
    expect(toBuffer(await store.get(kb)).toString()).toBe('conteudo-b')
  })

  it.each(['..', '../segredo.txt', '..\\segredo.txt', 'a/../../segredo.txt', 'ab/../../../segredo.txt', '../../segredo.txt'])(
    'AC-T05-04 chave com ".." é rejeitada no get (%s)',
    async (bad) => {
      writeFileSync(join(tmp.dir, 'segredo.txt'), 'FORA-DO-STORE')
      const { store } = await makeStore()
      // Sanidade: chave válida funciona (a rejeição abaixo não é vacuidade).
      const { key } = await store.put(Buffer.from('ok'), 'text/plain')
      expect(toBuffer(await store.get(key)).toString()).toBe('ok')
      let got: unknown
      const err = await caught(async () => {
        got = await store.get(bad)
      })
      expect(err, `get("${bad}") devolveu ${got === undefined ? 'undefined' : String(got)}`).toBeTruthy()
    },
  )

  it('AC-T05-04 chave com ".." não lê arquivo fora do STORAGE_DIR mesmo com caminho válido', async () => {
    const { store } = await makeStore()
    const { key } = await store.put(Buffer.from('dentro'), 'text/plain')
    expect(toBuffer(await store.get(key)).toString()).toBe('dentro')
    writeFileSync(join(tmp.dir, 'segredo.txt'), 'FORA-DO-STORE')
    const err = await caught(() => store.get(`${key}/../../segredo.txt`))
    expect(err).toBeTruthy()
  })
})
