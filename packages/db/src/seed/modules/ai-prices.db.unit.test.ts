// Seed de preços padrão de IA (T37): idempotente, não sobrescreve preço existente e cobre os modelos do Bloco F.
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createDb, type Database } from '../../client.js'
import { llmPrices } from '../../schema/crm/ai-usage.js'
import { createTempDatabase, type TempDatabase } from '../../testing.js'
import { runSeeds } from '../index.js'
import { DEFAULT_AI_PRICES, ensureDefaultAiPrices } from './ai-prices.js'

let tmp: TempDatabase
let db: Database

beforeAll(async () => {
  tmp = await createTempDatabase({ migrate: true })
  db = createDb(tmp.url, { max: 4 })
}, 120_000)

afterAll(async () => {
  await db?.$client.end()
  await tmp?.drop()
})

describe('ensureDefaultAiPrices', () => {
  it('banco vazio: insere todos os padrões (vigência = data do seed, salvo a vigência fixa); repetir não duplica', async () => {
    await db.delete(llmPrices)
    const now = new Date('2026-10-20T12:00:00Z')
    expect(await ensureDefaultAiPrices(db, { now })).toEqual({ inserted: DEFAULT_AI_PRICES.length })
    expect(await ensureDefaultAiPrices(db, { now: new Date('2026-10-21T12:00:00Z') })).toEqual({ inserted: 0 })
    const rows = await db.select().from(llmPrices)
    expect(rows).toHaveLength(DEFAULT_AI_PRICES.length)
    const haiku = rows.find((r) => r.model === 'claude-haiku-5-5')!
    expect(haiku).toMatchObject({ provider: 'anthropic', kind: 'llm', inputPerMtokMicros: 100_000, outputPerMtokMicros: 500_000 })
    expect(haiku.effectiveFrom.toISOString()).toBe(now.toISOString())
    const argon = rows.filter((r) => r.model === 'gemini-4-argon').map((r) => [r.effectiveFrom.toISOString(), r.inputPerMtokMicros])
    expect(argon).toEqual(expect.arrayContaining([[now.toISOString(), 2_000_000], ['2026-12-01T00:00:00.000Z', 4_000_000]]))
    expect(rows.find((r) => r.provider === 'elevenlabs' && r.model === 'eleven_flash_v2_5')).toMatchObject({ kind: 'tts', unitPriceMicros: 40_000_000 })
    expect(rows.find((r) => r.provider === 'groq' && r.model === 'whisper-large-v3-turbo')).toMatchObject({ kind: 'stt', unitPriceMicros: 667 })
  })

  it('não sobrescreve um preço já cadastrado (ex.: pelo admin) e só completa os modelos que faltam', async () => {
    await db.delete(llmPrices)
    await db.insert(llmPrices).values({ provider: 'openai', model: 'gpt-6-luna', kind: 'llm', effectiveFrom: new Date('2026-01-01T00:00:00Z'), inputPerMtokMicros: 1, outputPerMtokMicros: 2 })
    const { inserted } = await ensureDefaultAiPrices(db)
    expect(inserted).toBe(DEFAULT_AI_PRICES.length - 1)
    const luna = await db.select().from(llmPrices).where(eq(llmPrices.model, 'gpt-6-luna'))
    expect(luna).toEqual([expect.objectContaining({ inputPerMtokMicros: 1, outputPerMtokMicros: 2 })])
  })

  it('roda como módulo de seed (runSeeds)', async () => {
    await db.delete(llmPrices)
    const { applied } = await runSeeds(db, { base: false })
    expect(applied).toContain('ai-prices')
    expect((await db.select().from(llmPrices)).length).toBe(DEFAULT_AI_PRICES.length)
  })
})
