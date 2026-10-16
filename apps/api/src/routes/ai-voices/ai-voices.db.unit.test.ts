/* eslint-disable @typescript-eslint/no-explicit-any -- respostas JSON lidas como dados soltos */
// Vozes pela API (AC-T80-01..04) contra o FakeElevenLabsVoices: multipart com 1–3 áudios, prévia binária medida,
// keep, exclusão com aviso dos agentes, chave ausente e permissões.
import { FakeElevenLabsVoices } from '@crm/core/ai-voices-testing'
import { aiUsage, aiWallets, companyMembers, createDb, ensureDefaultAiPrices, users, type Database } from '@crm/db'
import { createTempDatabase, type TempDatabase } from '@crm/db/testing'
import { createLogger, generateCredentialsKey, initCredentialsCrypto, MemoryMailer, redisConnection } from '@crm/node-kit'
import { randomBytes } from 'node:crypto'
import { and, eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp, type RedisClient } from '../../app'

let temp: TempDatabase
let db: Database
let redis: RedisClient
let app: ReturnType<typeof createApp>
const fake = new FakeElevenLabsVoices()
const H = { 'x-requested-with': 'crm' }
const JSON_H = { ...H, 'content-type': 'application/json' }
const rnd = () => randomBytes(4).toString('hex')
const saved = { url: process.env.ELEVENLABS_API_URL, key: process.env.ELEVENLABS_API_KEY }

interface Session {
  cookie: string
  companyId: string
  userId: string
}
async function signUp(): Promise<Session> {
  const email = `t80-${rnd()}@x.com`
  const ip = { 'x-forwarded-for': `10.80.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` }
  const reg = await app.request('/api/auth/register', { method: 'POST', headers: { ...JSON_H, ...ip }, body: JSON.stringify({ name: 'T', email, password: '12345678', password_confirmation: '12345678' }) })
  const { user } = (await reg.json()) as any
  const login = await app.request('/api/auth/login', { method: 'POST', headers: { ...JSON_H, ...ip }, body: JSON.stringify({ email, password: '12345678' }) })
  const s = { cookie: /crm_session=[^;]+/.exec(login.headers.get('set-cookie') ?? '')![0], companyId: user.last_company_id, userId: user.id }
  await db.insert(aiWallets).values({ companyId: s.companyId, balanceCredits: 1_000_000 }).onConflictDoNothing()
  return s
}
const call = async (s: Session, method: string, path: string, body?: unknown) => {
  const res = await app.request(path, { method, headers: { ...JSON_H, cookie: s.cookie }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) })
  const text = await res.text()
  return { status: res.status, body: text ? (JSON.parse(text) as any) : {} }
}
const audio = (name: string, type = 'audio/mpeg') => ({ blob: new Blob([`ID3 ${rnd()}`], { type }), name })
async function createVoice(s: Session, files: { blob: Blob; name: string }[], field = 'audios', extra: Record<string, string> = { name: 'Minha voz', language: 'pt' }) {
  const form = new FormData()
  for (const [k, v] of Object.entries(extra)) form.append(k, v)
  for (const f of files) form.append(field, f.blob, f.name)
  const res = await app.request('/api/ai-voices', { method: 'POST', headers: { ...H, cookie: s.cookie }, body: form })
  const text = await res.text()
  return { status: res.status, body: text ? (JSON.parse(text) as any) : {} }
}

beforeAll(async () => {
  initCredentialsCrypto({ key: generateCredentialsKey() })
  await fake.start()
  process.env.ELEVENLABS_API_URL = fake.url
  process.env.ELEVENLABS_API_KEY = 'platform-el-key'
  temp = await createTempDatabase({ migrate: true })
  db = createDb(temp.url, { max: 6 })
  await ensureDefaultAiPrices(db)
  redis = redisConnection({ url: process.env.REDIS_URL ?? 'redis://127.0.0.1:6379/1' })
  app = createApp({ db, redis, mailer: new MemoryMailer(), trustProxy: true, logger: createLogger({ level: 'silent' }), aiKeyProbe: async () => undefined })
}, 120_000)

afterAll(async () => {
  await fake.close()
  await db?.$client.end()
  redis?.disconnect()
  await temp?.drop()
  for (const [k, v] of [['ELEVENLABS_API_URL', saved.url], ['ELEVENLABS_API_KEY', saved.key]] as const) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
})

describe('/api/ai-voices', () => {
  it('AC-T80-01/02: cria com 1–3 áudios (pending, clona no provedor); 0/4 → 422; prévia devolve áudio e mede; keep → kept', async () => {
    const s = await signUp()
    const created = await createVoice(s, [audio('a.mp3'), audio('b.webm', 'audio/webm;codecs=opus')], 'audios[]')
    expect(created.status).toBe(201)
    expect(created.body.voice).toMatchObject({ name: 'Minha voz', language: 'pt', status: 'pending', samples_count: 2 })
    expect(fake.clones.at(-1)).toMatchObject({ voiceId: created.body.voice.provider_voice_id, apiKey: 'platform-el-key' })

    const none = await createVoice(s, [])
    expect(none.status).toBe(422)
    expect(none.body.error.details.error_code).toBe('audios_count')
    expect((await createVoice(s, [audio('1.mp3'), audio('2.mp3'), audio('3.mp3'), audio('4.mp3')])).status).toBe(422)
    expect((await createVoice(s, [audio('x.pdf', 'application/pdf')])).body.error.details.error_code).toBe('unsupported_audio')

    const id = created.body.voice.id
    const res = await app.request(`/api/ai-voices/${id}/preview`, { method: 'POST', headers: { ...JSON_H, cookie: s.cookie }, body: JSON.stringify({ text: 'Bom dia' }) })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('audio/mpeg')
    expect(Buffer.from(await res.arrayBuffer()).toString('utf8')).toBe(`ID3${created.body.voice.provider_voice_id}:Bom dia`)
    const usage = await db.select().from(aiUsage).where(and(eq(aiUsage.companyId, s.companyId), eq(aiUsage.feature, 'tts')))
    expect(usage).toHaveLength(1)
    expect(usage[0]).toMatchObject({ kind: 'tts', units: 7 })

    const kept = await call(s, 'POST', `/api/ai-voices/${id}/keep`)
    expect(kept.body.voice.status).toBe('kept')
    const list = await call(s, 'GET', '/api/ai-voices?page=1&limit=10')
    expect(list.body).toMatchObject({ page: 1, limit: 10, total: 1, items: [expect.objectContaining({ id, status: 'kept' })] })
  })

  it('AC-T80-03: excluir voz usada por agente devolve o agente à voz padrão e avisa', async () => {
    const s = await signUp()
    const voice = (await createVoice(s, [audio('a.wav', 'audio/wav')])).body.voice
    const agent = (await call(s, 'POST', '/api/ai-agents', { name: 'Ana' })).body.agent
    const patched = await call(s, 'PATCH', `/api/ai-agents/${agent.id}`, { settings: { audio_voice: voice.provider_voice_id } })
    expect(patched.body.agent.settings.audio_voice).toBe(voice.provider_voice_id)
    const del = await call(s, 'DELETE', `/api/ai-voices/${voice.id}`)
    expect(del.status).toBe(200)
    expect(del.body).toMatchObject({ deleted: true, removed_from_agents: [{ id: agent.id, name: 'Ana' }], warning: expect.stringContaining('voz padrão'), provider_deleted: true })
    expect((await call(s, 'GET', `/api/ai-agents/${agent.id}`)).body.agent.settings.audio_voice).toBe('')
    expect((await call(s, 'GET', `/api/ai-voices/${voice.id}`)).status).toBe(404)
  })

  it('AC-T80-04: sem chave ElevenLabs (empresa nem plataforma) → 422 provider_not_configured; outra empresa → 404; sem flows.edit → 403', async () => {
    const s = await signUp()
    const voice = (await createVoice(s, [audio('a.ogg', 'audio/ogg')])).body.voice
    delete process.env.ELEVENLABS_API_KEY
    try {
      const r = await createVoice(s, [audio('a.mp3')])
      expect(r.status).toBe(422)
      expect(r.body.error.details).toMatchObject({ error_code: 'provider_not_configured', provider: 'elevenlabs' })
      expect((await call(s, 'POST', `/api/ai-voices/${voice.id}/preview`)).body.error.details.error_code).toBe('provider_not_configured')
    } finally {
      process.env.ELEVENLABS_API_KEY = 'platform-el-key'
    }

    const other = await signUp()
    expect((await call(other, 'GET', `/api/ai-voices/${voice.id}`)).status).toBe(404)
    expect((await call(other, 'DELETE', `/api/ai-voices/${voice.id}`)).status).toBe(404)

    const m = await signUp()
    await db.insert(companyMembers).values({ companyId: s.companyId, userId: m.userId, role: 'member', permissionKeys: ['flows.view'] })
    await db.update(users).set({ lastCompanyId: s.companyId }).where(eq(users.id, m.userId))
    const member = { ...m, companyId: s.companyId }
    expect((await call(member, 'GET', '/api/ai-voices')).status).toBe(200)
    expect((await call(member, 'POST', `/api/ai-voices/${voice.id}/keep`)).status).toBe(403)
    expect((await createVoice(member, [audio('a.mp3')])).status).toBe(403)
  })
})
