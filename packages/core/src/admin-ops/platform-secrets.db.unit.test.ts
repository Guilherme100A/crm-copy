// Segredos de plataforma (T96, AC-T96-04) com Postgres real: só escrita (leitura = configured + origem + máscara),
// cifrados com AAD por chave, e a precedência no runtime: chave da empresa → segredo salvo → env.
import { randomBytes } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { aiProviderKeys, companies, createDb, platformSecrets, type Database } from '@crm/db'
import { createTempDatabase, type TempDatabase } from '@crm/db/testing'
import { createCipher, generateCredentialsKey } from '@crm/node-kit'
import { envProviderKeys } from '../ai-agents/provider-keys'
import { ProviderNotConfiguredError } from '../ai-keys/errors'
import { AiKeysService } from '../ai-keys/service'
import { AdminOpsError } from './errors'
import { PLATFORM_SECRET_KEYS, PlatformSecretsService } from './platform-secrets'
import { hasPlatformSecret, readPlatformSecret, sealPlatformSecret } from './secret-store'

let temp: TempDatabase
let db: Database
const cipher = createCipher({ key: generateCredentialsKey() })
const SECRET = 'sk-ant-PLATFORMSECRET-wxyz'
const ENV_SECRET = 'sk-env-ENVSECRET-1234'
const caught = async (p: Promise<unknown>) =>
  p.then(
    () => null,
    (e: unknown) => e,
  )

beforeAll(async () => {
  temp = await createTempDatabase({ migrate: true })
  db = createDb(temp.url, { max: 4 })
}, 60_000)

afterAll(async () => {
  await db?.$client.end()
  await temp?.drop()
})

beforeEach(async () => {
  await db.delete(platformSecrets)
})

async function company() {
  const [co] = await db
    .insert(companies)
    .values({ name: 'C', slug: `c-${randomBytes(4).toString('hex')}` })
    .returning({ id: companies.id })
  return co!.id
}

describe('leitura só com configured/origem/máscara', () => {
  it('lista todas as chaves; env vira source=env com máscara; salvo vira source=db; o valor nunca aparece', async () => {
    const s = new PlatformSecretsService({
      db,
      cipher,
      env: { GROQ_API_KEY: ENV_SECRET },
      now: () => new Date('2026-05-01T00:00:00Z'),
    })
    const before = await s.list()
    expect(before.map((x) => x.key)).toEqual([...PLATFORM_SECRET_KEYS])
    expect(before.find((x) => x.key === 'groq')).toMatchObject({
      configured: true,
      source: 'env',
      hint: '…1234',
      env_var: 'GROQ_API_KEY',
      updated_at: null,
    })
    expect(before.find((x) => x.key === 'anthropic')).toMatchObject({ configured: false, source: null, hint: null })

    const saved = await s.set('anthropic', { value: `  ${SECRET} ` }, null)
    expect(saved).toEqual({
      key: 'anthropic',
      env_var: 'ANTHROPIC_API_KEY',
      configured: true,
      source: 'db',
      hint: '…wxyz',
      updated_at: '2026-05-01T00:00:00.000Z',
      updated_by_user_id: null,
    })
    // DB vence o env também na leitura.
    await s.set('groq', { value: 'gsk-db-9876' })
    expect((await s.get('groq')).source).toBe('db')
    const all = JSON.stringify(await s.list())
    expect(all).not.toContain('PLATFORMSECRET')
    expect(all).not.toContain('ENVSECRET')

    const [row] = await db.select().from(platformSecrets).where(eq(platformSecrets.key, 'anthropic'))
    expect(row!.valueEnc).not.toContain('PLATFORMSECRET')
    expect(await readPlatformSecret(db, 'anthropic', cipher)).toBe(SECRET)
    expect(await hasPlatformSecret(db, 'openai')).toBe(false)
  })

  it('trocar regrava; remover volta ao env; chave desconhecida → not_found; valor vazio → validation', async () => {
    const s = new PlatformSecretsService({ db, cipher, env: { ELEVENLABS_API_KEY: ENV_SECRET } })
    await s.set('elevenlabs', { value: 'first-aaaa' })
    expect((await s.set('elevenlabs', { value: 'second-bbbb' })).hint).toBe('…bbbb')
    expect(await readPlatformSecret(db, 'elevenlabs', cipher)).toBe('second-bbbb')
    expect(await db.select().from(platformSecrets)).toHaveLength(1)
    const r = await s.remove('elevenlabs')
    expect(r).toMatchObject({ removed: true, secret: { source: 'env', hint: '…1234' } })
    expect((await s.remove('elevenlabs')).removed).toBe(false)
    const unknown = (await caught(s.set('aws', { value: 'x' }))) as AdminOpsError
    expect(unknown.code).toBe('not_found')
    const empty = (await caught(s.set('openai', { value: '   ' }))) as AdminOpsError
    expect(empty.code).toBe('validation')
    expect(((await caught(s.set('openai', {}))) as AdminOpsError).code).toBe('validation')
  })

  it('AAD por chave: o cifrado de uma chave não abre como outra', async () => {
    await db
      .insert(platformSecrets)
      .values({ key: 'openai', valueEnc: sealPlatformSecret('anthropic', SECRET, cipher), hint: 'wxyz' })
    await expect(readPlatformSecret(db, 'openai', cipher)).rejects.toThrow()
  })
})

describe('runtime: empresa → segredo salvo → env', () => {
  it('resolveCredentials usa o segredo salvo antes do env; sem salvo, o env como antes; sem nada, ProviderNotConfigured', async () => {
    const co = await company()
    const keys = new AiKeysService({ db, cipher, env: { OPENAI_API_KEY: ENV_SECRET } })
    expect(await keys.resolveCredentials(co, 'openai')).toEqual({ apiKey: ENV_SECRET, source: 'platform' })
    expect(await caught(keys.resolveCredentials(co, 'groq'))).toBeInstanceOf(ProviderNotConfiguredError)
    expect(await keys.isConfigured({ companyId: co, provider: 'anthropic' })).toBe(false)

    const admin = new PlatformSecretsService({ db, cipher })
    await admin.set('openai', { value: SECRET })
    await admin.set('groq', { value: 'gsk-platform' })
    await admin.set('anthropic', { value: 'sk-ant-platform' })
    expect(await keys.resolveCredentials(co, 'openai')).toEqual({ apiKey: SECRET, source: 'platform' })
    expect(await keys.resolveCredentials(co, 'groq')).toEqual({ apiKey: 'gsk-platform', source: 'platform' })
    expect(await keys.isConfigured({ companyId: co, provider: 'anthropic' })).toBe(true)

    // A chave da empresa continua vencendo.
    const own = await keys.create(co, { provider: 'openai', name: 'Própria', secret: 'sk-company-cccc' })
    expect(await keys.resolveCredentials(co, 'openai')).toEqual({
      apiKey: 'sk-company-cccc',
      source: 'company',
      keyId: own.id,
    })
    await db.delete(aiProviderKeys).where(eq(aiProviderKeys.id, own.id))

    await admin.remove('openai')
    expect((await keys.resolveCredentials(co, 'openai')).apiKey).toBe(ENV_SECRET)
  })

  it('envProviderKeys: sem db só o env (como antes); com db o segredo salvo também conta', async () => {
    const co = await company()
    expect(envProviderKeys({ GOOGLE_API_KEY: 'g' }).isConfigured({ companyId: co, provider: 'google' })).toBe(true)
    expect(envProviderKeys({}).isConfigured({ companyId: co, provider: 'openrouter' })).toBe(false)
    expect(await envProviderKeys({}, { db }).isConfigured({ companyId: co, provider: 'openrouter' })).toBe(false)
    await new PlatformSecretsService({ db, cipher }).set('openrouter', { value: 'sk-or-1' })
    expect(await envProviderKeys({}, { db }).isConfigured({ companyId: co, provider: 'openrouter' })).toBe(true)
    expect(envProviderKeys({}).isConfigured({ companyId: co, provider: 'openrouter' })).toBe(false)
  })
})
