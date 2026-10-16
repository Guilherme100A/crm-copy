// AC-T05-01 — AES-256-GCM com AAD e keyVersion (CREDENTIALS_KEY). Contrato: `encrypt(x, aad)` / `decrypt(payload, aad)`.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { caught, freshKit, type Kit, validKey } from './kit'

const AAD = 'session-1/creds/me'

async function kitWithKey(key: string | undefined): Promise<Kit> {
  vi.stubEnv('CREDENTIALS_KEY', key)
  return freshKit()
}

/** Erro "de verdade" do decrypt (não um TypeError por API ausente). */
async function decryptError(kit: Kit, payload: unknown, aad: string): Promise<unknown> {
  expect(typeof kit.decrypt, 'decrypt não exportado por @crm/node-kit').toBe('function')
  const err = await caught(() => kit.decrypt(payload, aad))
  if (err) expect(String((err as Error).message ?? err)).not.toMatch(/is not a function|Cannot read properties of undefined/)
  return err
}

/** Localiza o campo do payload pelo nome (iv / authTag|tag) e devolve uma cópia com 1 bit trocado. */
function tamper(payload: unknown, field: 'iv' | 'tag'): unknown {
  if (payload === null || typeof payload !== 'object' || Buffer.isBuffer(payload))
    throw new Error(`payload de encrypt deveria expor iv e authTag (veio ${typeof payload})`)
  const names = field === 'iv' ? ['iv', 'nonce'] : ['authTag', 'auth_tag', 'tag']
  const rec = payload as Record<string, unknown>
  const name = names.find((n) => n in rec)
  if (!name) throw new Error(`payload sem campo ${names.join('|')}: chaves ${Object.keys(rec).join(', ')}`)
  const orig = rec[name]
  let changed: unknown
  if (Buffer.isBuffer(orig) || orig instanceof Uint8Array) {
    const b = Buffer.from(orig)
    b[0] ^= 0x01
    changed = b
  } else if (typeof orig === 'string') {
    const isHex = /^[0-9a-f]+$/i.test(orig) && orig.length % 2 === 0
    const b = Buffer.from(orig, isHex ? 'hex' : 'base64')
    b[0] ^= 0x01
    changed = b.toString(isHex ? 'hex' : 'base64')
  } else throw new Error(`campo ${name} com tipo inesperado`)
  return { ...rec, [name]: changed }
}

describe('T05 — cripto AES-256-GCM', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.resetModules()
  })

  it('AC-T05-01 decrypt(encrypt(x, aad), aad) devolve a mesma string (inclui unicode)', async () => {
    const kit = await kitWithKey(validKey())
    for (const x of ['segredo', '', 'ção 🔐 ' + 'x'.repeat(5000)]) {
      const enc = await kit.encrypt(x, AAD)
      const out = await kit.decrypt(enc, AAD)
      expect(typeof out).toBe('string')
      expect(out).toBe(x)
    }
  })

  it('AC-T05-01 decrypt(encrypt(x, aad), aad) devolve o mesmo Buffer', async () => {
    const kit = await kitWithKey(validKey())
    const x = Buffer.from([0, 1, 2, 250, 255, 0, 42])
    const enc = await kit.encrypt(x, AAD)
    const out = await kit.decrypt(enc, AAD)
    expect(Buffer.isBuffer(out)).toBe(true)
    expect(Buffer.compare(out, x)).toBe(0)
  })

  it('AC-T05-01 payload não contém o texto claro e cada encrypt usa IV novo; expõe keyVersion', async () => {
    const kit = await kitWithKey(validKey())
    const secret = 'texto-claro-que-nao-pode-vazar'
    const a = await kit.encrypt(secret, AAD)
    const b = await kit.encrypt(secret, AAD)
    const dump = (p: unknown) =>
      JSON.stringify(p, (_k, v) => (v && v.type === 'Buffer' && Array.isArray(v.data) ? Buffer.from(v.data).toString('latin1') : v))
    expect(dump(a)).not.toContain(secret)
    expect(dump(a)).not.toBe(dump(b))
    expect(a).toHaveProperty('keyVersion')
    expect(typeof (a as { keyVersion: unknown }).keyVersion).toBe('number')
  })

  it('AC-T05-01 AAD diferente no decrypt → erro', async () => {
    const kit = await kitWithKey(validKey())
    const enc = await kit.encrypt('segredo', AAD)
    expect(await decryptError(kit, enc, 'session-2/creds/me')).toBeTruthy()
    expect(await decryptError(kit, enc, AAD + 'x')).toBeTruthy()
  })

  it('AC-T05-01 IV adulterado → erro', async () => {
    const kit = await kitWithKey(validKey())
    const enc = await kit.encrypt('segredo', AAD)
    expect(await decryptError(kit, tamper(enc, 'iv'), AAD)).toBeTruthy()
  })

  it('AC-T05-01 auth tag adulterada → erro', async () => {
    const kit = await kitWithKey(validKey())
    const enc = await kit.encrypt(Buffer.from('segredo'), AAD)
    expect(await decryptError(kit, tamper(enc, 'tag'), AAD)).toBeTruthy()
  })

  it('AC-T05-01 payload cifrado com outra CREDENTIALS_KEY não decifra', async () => {
    const enc = await (await kitWithKey(validKey())).encrypt('segredo', AAD)
    const other = await kitWithKey(validKey())
    expect(await decryptError(other, enc, AAD)).toBeTruthy()
  })

  it.each([
    ['ausente', undefined],
    ['vazia', ''],
    ['16 bytes', Buffer.alloc(16, 7).toString('base64')],
    ['31 bytes', Buffer.alloc(31, 7).toString('base64')],
    ['33 bytes', Buffer.alloc(33, 7).toString('base64')],
    ['64 bytes', Buffer.alloc(64, 7).toString('base64')],
  ])('AC-T05-01 CREDENTIALS_KEY %s → erro na inicialização (nada é cifrado)', async (_label, key) => {
    // Sanidade: com chave válida o mesmo caminho cifra (o erro abaixo não é vacuidade).
    const ok = await kitWithKey(validKey())
    expect(typeof ok.encrypt, 'encrypt não exportado por @crm/node-kit').toBe('function')
    expect(await ok.encrypt('segredo', AAD)).toBeTruthy()

    let result: unknown = undefined
    const err = await caught(async () => {
      const kit = await kitWithKey(key)
      // A inicialização pode ser na carga do módulo ou no primeiro uso; em nenhum caso pode cifrar.
      result = await kit.encrypt('segredo', AAD)
    })
    expect(err, `encrypt devolveu ${JSON.stringify(result)} com chave ${_label}`).toBeTruthy()
    expect(String((err as Error).message ?? err)).not.toMatch(/is not a function|Cannot read properties/)
  })
})
