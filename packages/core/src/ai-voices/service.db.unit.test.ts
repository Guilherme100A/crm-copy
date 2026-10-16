// Vozes contra Postgres/Redis reais e o FakeElevenLabsVoices (AC-T80-01..04): clonagem com 1–3 amostras, prévia
// medida (`feature = 'tts'`), keep, exclusão que tira a voz dos agentes e chave ausente.
import { randomBytes } from 'node:crypto'
import { aiUsage, aiWallets, companies, createDb, ensureDefaultAiPrices, type Database } from '@crm/db'
import { createTempDatabase, type TempDatabase } from '@crm/db/testing'
import { redisConnection } from '@crm/node-kit'
import { and, eq } from 'drizzle-orm'
import type { Redis } from 'ioredis'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { AiAgentsService } from '../ai-agents/service'
import { ProviderNotConfiguredError } from '../ai-keys/errors'
import { UsageGuard } from '../ai-metering/guard'
import { AiVoicesService, isAudio, VOICE_TTS_MODEL } from './service'
import { FakeElevenLabsVoices } from './testing/fake-elevenlabs'

let tmp: TempDatabase
let db: Database
let redis: Redis
const fake = new FakeElevenLabsVoices()

beforeAll(async () => {
  await fake.start()
  tmp = await createTempDatabase({ migrate: true })
  db = createDb(tmp.url, { max: 4 })
  await ensureDefaultAiPrices(db)
  redis = redisConnection()
}, 120_000)

afterAll(async () => {
  await fake.close()
  await db?.$client.end()
  await redis?.quit()
  await tmp?.drop()
})

const keys = (apiKey: string | null) => ({
  resolveCredentials: async () => {
    if (!apiKey) throw new ProviderNotConfiguredError('elevenlabs')
    return { apiKey, source: 'company' as const }
  },
})
const service = (apiKey: string | null = 'el-key') =>
  new AiVoicesService({ db, keys: keys(apiKey) as never, guard: new UsageGuard({ db, redis }), env: { ELEVENLABS_API_URL: fake.url } })
const sample = (filename = 'a.mp3', mime = 'audio/mpeg') => ({ filename, mime, data: Buffer.from(`ID3 amostra ${randomBytes(4).toString('hex')}`) })

async function company(balance = 1_000_000) {
  const tag = randomBytes(4).toString('hex')
  const [c] = await db.insert(companies).values({ name: `V${tag}`, slug: `v-t80-${tag}` }).returning()
  if (balance) await db.insert(aiWallets).values({ companyId: c!.id, balanceCredits: balance })
  return c!.id
}

describe('isAudio', () => {
  it('aceita pela extensão ou pelo mime (ignora ;codecs)', () => {
    for (const f of ['a.mp3', 'a.WAV', 'a.ogg', 'a.m4a', 'a.aac', 'a.webm', 'a.flac']) expect(isAudio(f, '')).toBe(true)
    expect(isAudio('gravacao', 'audio/webm;codecs=opus')).toBe(true)
    expect(isAudio('blob', 'audio/x-m4a')).toBe(true)
    expect(isAudio('doc.pdf', 'application/pdf')).toBe(false)
    expect(isAudio('video.mp4', 'video/mp4')).toBe(false)
  })
})

describe('AiVoicesService', () => {
  it('AC-T80-01: 1–3 amostras clonam na ElevenLabs e ficam pending; 0, 4 ou formato inválido → validation', async () => {
    const co = await company()
    const svc = service()
    const v = await svc.create(co, { name: '  Minha voz ', language: 'pt', audios: [sample('a.mp3'), sample('b.webm', 'audio/webm;codecs=opus'), sample('c.flac', '')] })
    expect(v).toMatchObject({ name: 'Minha voz', language: 'pt', status: 'pending', provider: 'elevenlabs', samples_count: 3 })
    const clone = fake.clones.find((c) => c.voiceId === v.provider_voice_id)!
    expect(clone).toMatchObject({ apiKey: 'el-key', name: 'Minha voz', labels: { language: 'pt' } })
    expect(clone.files.map((f) => f.filename)).toEqual(['a.mp3', 'b.webm', 'c.flac'])
    expect(v.samples.map((s) => s.mime)).toEqual(['audio/mpeg', 'audio/webm', 'application/octet-stream'])

    const before = fake.clones.length
    await expect(svc.create(co, { name: 'x', language: 'pt', audios: [] })).rejects.toMatchObject({ code: 'validation', details: { error_code: 'audios_count' } })
    await expect(svc.create(co, { name: 'x', language: 'pt', audios: [sample(), sample(), sample(), sample()] })).rejects.toMatchObject({ details: { error_code: 'audios_count' } })
    await expect(svc.create(co, { name: 'x', language: 'pt', audios: [sample('doc.pdf', 'application/pdf')] })).rejects.toMatchObject({ details: { error_code: 'unsupported_audio' } })
    await expect(svc.create(co, { name: 'x', language: 'fr', audios: [sample()] })).rejects.toMatchObject({ details: { error_code: 'language_invalid' } })
    await expect(svc.create(co, { name: ' ', language: 'pt', audios: [sample()] })).rejects.toMatchObject({ details: { error_code: 'name_required' } })
    expect(fake.clones.length).toBe(before)
  })

  it('AC-T80-02/04: prévia devolve áudio e grava ai_usage tts; keep muda para kept; sem saldo → quota', async () => {
    const co = await company()
    const svc = service()
    const v = await svc.create(co, { name: 'Voz', language: 'en', audios: [sample()] })
    const p = await svc.preview(co, v.id, 'Olá, mundo')
    expect(p.mime).toBe('audio/mpeg')
    expect(Buffer.from(p.audio).toString('utf8')).toBe(`ID3${v.provider_voice_id}:Olá, mundo`)
    expect(fake.ttsCalls.at(-1)).toMatchObject({ voiceId: v.provider_voice_id, modelId: VOICE_TTS_MODEL, outputFormat: 'mp3_44100_128' })
    const usage = await db.select().from(aiUsage).where(and(eq(aiUsage.companyId, co), eq(aiUsage.feature, 'tts')))
    expect(usage).toHaveLength(1)
    expect(usage[0]).toMatchObject({ kind: 'tts', provider: 'elevenlabs', model: VOICE_TTS_MODEL, units: 10 })
    // Texto vazio → frase padrão do idioma da voz.
    await svc.preview(co, v.id)
    expect(fake.ttsCalls.at(-1)!.text).toMatch(/^Hi! This is a preview/)
    await expect(svc.preview(co, v.id, 'x'.repeat(301))).rejects.toMatchObject({ details: { error_code: 'text_too_long' } })

    expect(await svc.keep(co, v.id)).toMatchObject({ status: 'kept', kept_at: expect.any(String) })
    expect((await svc.keep(co, v.id)).status).toBe('kept')

    const broke = await company(0)
    const v2 = await svc.create(broke, { name: 'Voz', language: 'pt', audios: [sample()] })
    const calls = fake.ttsCalls.length
    await expect(svc.preview(broke, v2.id)).rejects.toMatchObject({ code: 'quota', message: 'Sem saldo para ouvir essa voz' })
    expect(fake.ttsCalls.length).toBe(calls)
  })

  it('AC-T80-03: excluir voz usada por agente devolve o agente à voz padrão e avisa; apaga no provedor', async () => {
    const co = await company()
    const svc = service()
    const v = await svc.create(co, { name: 'Voz', language: 'pt', audios: [sample()] })
    const agents = new AiAgentsService({ db, providerKeys: { isConfigured: () => true } })
    const a = await agents.create(co, { name: 'Ana' })
    const b = await agents.create(co, { name: 'Bia' })
    await agents.update(co, a.id, { settings: { audio_voice: v.provider_voice_id } })
    await agents.update(co, b.id, { settings: { audio_voice: 'outra-voz' } })
    const r = await svc.remove(co, v.id)
    expect(r).toEqual({ deleted: true, removed_from_agents: [{ id: a.id, name: 'Ana' }], warning: expect.stringContaining('1 agente'), provider_deleted: true })
    expect((await agents.get(co, a.id)).settings.audio_voice).toBe('')
    expect((await agents.get(co, b.id)).settings.audio_voice).toBe('outra-voz')
    expect(fake.deleted).toContain(v.provider_voice_id)
    await expect(svc.get(co, v.id)).rejects.toMatchObject({ code: 'not_found' })

    // Falha no provedor não impede a exclusão local.
    const v2 = await svc.create(co, { name: 'Voz 2', language: 'pt', audios: [sample()] })
    fake.failNext(500)
    expect(await svc.remove(co, v2.id)).toMatchObject({ deleted: true, removed_from_agents: [], warning: null, provider_deleted: false })
  })

  it('AC-T80-04: sem chave ElevenLabs → provider_not_configured; outra empresa → not_found; lista paginada', async () => {
    const co = await company()
    await expect(service(null).create(co, { name: 'Voz', language: 'pt', audios: [sample()] })).rejects.toMatchObject({ code: 'validation', details: { error_code: 'provider_not_configured' } })
    const svc = service()
    for (let i = 0; i < 3; i++) await svc.create(co, { name: `V${i}`, language: 'pt', audios: [sample()] })
    const page = await svc.list(co, { page: 2, limit: 2 })
    expect(page).toMatchObject({ page: 2, limit: 2, total: 3 })
    expect(page.items).toHaveLength(1)
    const other = await company()
    await expect(svc.get(other, page.items[0]!.id)).rejects.toMatchObject({ code: 'not_found' })
    await expect(service(null).preview(co, page.items[0]!.id)).rejects.toMatchObject({ details: { error_code: 'provider_not_configured' } })
  })
})
