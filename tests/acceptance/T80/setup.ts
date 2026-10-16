// Ambiente da suíte T80 (contrato combinado com o Cinzel):
// - FakeElevenLabsVoices (@crm/core/ai-voices-testing): servidor HTTP local da ElevenLabs (nunca a API paga real).
//   Endpoints conferidos na doc pública: POST /v1/voices/add (IVC), DELETE /v1/voices/{voice_id}, POST /v1/text-to-speech/{voice_id}.
//   ELEVENLABS_API_URL = fake.url no process.env (o mesmo que a API lê).
// - createApp com aiKeyProbe falso (cadastrar chave sem rede). Chave da empresa por POST /api/ai-keys.
// - Medição do preview (T24): preços padrão (ensureDefaultAiPrices) e carteira com saldo por SQL.
import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createDb } from '@crm/db'
import { createTempDatabase, type TempDatabase } from '@crm/db/testing'
import { FsBlobStore, MemoryMailer, redisConnection } from '@crm/node-kit'
import { FakeWaGateway } from '@crm/wa-port/testing'
import { ROOT } from '../helpers/exec'
import { fakeEmail, uniqueId } from '../helpers/factories'
import { createClient } from '../helpers/http'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

process.env.CREDENTIALS_KEY ??= randomBytes(32).toString('base64')

export interface Env {
  tmp: TempDatabase
  db: Any
  app: Any
  fake: Any
  q: (text: string, params?: unknown[]) => Promise<Any[]>
  close: () => Promise<void>
}

async function loadFake(): Promise<Any> {
  try {
    return await import('@crm/core/ai-voices-testing')
  } catch {
    return import(pathToFileURL(resolve(ROOT, 'packages/core/src/ai-voices/testing/index.ts')).href)
  }
}

export async function startEnv(): Promise<Env> {
  const api: Any = await import('@crm/api')
  const dbMod: Any = await import('@crm/db')
  const { FakeElevenLabsVoices } = await loadFake()
  const fake = new FakeElevenLabsVoices()
  const started = await fake.start?.()
  process.env.ELEVENLABS_API_URL = started?.url ?? fake.url
  delete process.env.ELEVENLABS_API_KEY // sem chave de plataforma por padrão

  const tmp = await createTempDatabase({ migrate: true })
  const storageDir = mkdtempSync(join(tmpdir(), 'crm-t80-'))
  const db = createDb(tmp.url)
  if (typeof dbMod.ensureDefaultAiPrices === 'function') await dbMod.ensureDefaultAiPrices(db)
  const redis = redisConnection()
  redis.on?.('error', () => {})
  const app = api.createApp({
    db,
    redis,
    mailer: new MemoryMailer(),
    blobStore: new FsBlobStore(storageDir),
    waGateway: new FakeWaGateway(),
    appName: 'ProdutoTesteT80',
    webPublicUrl: 'http://web.t80.test',
    trustProxy: true,
    aiKeyProbe: async () => undefined,
  })
  const q = async (text: string, params: unknown[] = []) => (await db.$client.query(text, params)).rows
  return {
    tmp,
    db,
    app,
    fake,
    q,
    close: async () => {
      await (started?.close ?? fake.close)?.call(started ?? fake)
      await Promise.resolve(redis.quit?.()).catch(() => redis.disconnect?.())
      await db.$client.end().catch(() => {})
      await tmp.drop()
      rmSync(storageDir, { recursive: true, force: true })
    },
  }
}

export interface User {
  c: ReturnType<typeof createClient>
  userId: string
  companyId: string
  token: string
}

let ipSeq = 0
export async function owner(env: Env): Promise<User> {
  const ip = `10.80.${Math.floor(++ipSeq / 250)}.${(ipSeq % 250) + 1}`
  const c = createClient({
    fetcher: (path, init) => {
      const headers = new Headers(init.headers)
      headers.set('x-forwarded-for', ip)
      return env.app.request(path, { ...init, headers })
    },
  })
  const password = `Senha-${randomBytes(5).toString('hex')}`
  const email = fakeEmail('t80')
  const reg = await c.post('/api/auth/register', { name: `Dona ${uniqueId('t80')}`, email, password, password_confirmation: password })
  if (reg.status >= 300) throw new Error(`cadastro: ${reg.status} ${reg.text}`)
  const login = await c.post('/api/auth/login', { email, password })
  if (login.status !== 200) throw new Error(`login: ${login.status} ${login.text}`)
  const companyId = login.body.companies[0].id
  c.setCompany(companyId)
  const [u] = await env.q(`SELECT id FROM crm.users WHERE lower(email) = lower($1)`, [email])
  return { c, userId: u.id, companyId, token: c.cookies.get('crm_session')! }
}

export async function addKey(u: User, provider: 'elevenlabs' | 'openai') {
  const r = await u.c.post('/api/ai-keys', { provider, name: `Chave ${provider}`, secret: `${provider === 'openai' ? 'sk-' : 'el-'}${randomBytes(12).toString('hex')}` })
  if (r.status !== 201) throw new Error(`chave ${provider}: ${r.status} ${r.text}`)
}

/** Dono com chave ElevenLabs da empresa e carteira com saldo. */
export async function ready(env: Env): Promise<User> {
  const u = await owner(env)
  await addKey(u, 'elevenlabs')
  await fund(env, u.companyId)
  return u
}

export async function fund(env: Env, companyId: string, credits = 1_000_000_000) {
  await env.q(
    `INSERT INTO crm.ai_wallets (company_id, balance_credits, status) VALUES ($1, $2, 'ok')
     ON CONFLICT (company_id) DO UPDATE SET balance_credits = $2, status = 'ok'`,
    [companyId, credits],
  )
}

/** Amostra de áudio (bytes arbitrários; o formato é aceito pela extensão/mime). */
export const sample = (name = 'amostra.mp3', type = 'audio/mpeg', size = 2048) => ({ name, type, bytes: randomBytes(size) })

/** POST multipart /api/ai-voices. */
export async function createVoice(env: Env, u: User, fields: { name?: string; language?: string }, files: Array<{ name: string; type: string; bytes: Uint8Array }>) {
  const form = new FormData()
  if (fields.name !== undefined) form.append('name', fields.name)
  if (fields.language !== undefined) form.append('language', fields.language)
  for (const f of files) form.append('audios', new Blob([f.bytes], { type: f.type }), f.name)
  const res = await env.app.request('/api/ai-voices', {
    method: 'POST',
    headers: { cookie: `crm_session=${u.token}`, 'x-company-id': u.companyId, 'x-requested-with': 'crm' },
    body: form,
  })
  const text = await res.text()
  let body: Any = text
  try {
    body = text ? JSON.parse(text) : undefined
  } catch {
    /* não-JSON */
  }
  return { status: res.status, body, text }
}

/** POST /:id/preview → resposta crua (áudio binário em sucesso). */
export async function preview(env: Env, u: User, voiceId: string, text?: string) {
  const res = await env.app.request(`/api/ai-voices/${voiceId}/preview`, {
    method: 'POST',
    headers: { cookie: `crm_session=${u.token}`, 'x-company-id': u.companyId, 'x-requested-with': 'crm', 'content-type': 'application/json' },
    body: JSON.stringify(text === undefined ? {} : { text }),
  })
  const buf = new Uint8Array(await res.arrayBuffer())
  let json: Any
  try {
    json = JSON.parse(new TextDecoder().decode(buf))
  } catch {
    json = undefined
  }
  return { status: res.status, contentType: res.headers.get('content-type') ?? '', bytes: buf, json }
}
