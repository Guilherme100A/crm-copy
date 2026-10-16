// Ambiente da suíte T35: banco descartável migrado, Redis real (db 1), app `@crm/api` sem porta, blobStore em diretório
// temporário (mesmo MediaService da T49). Sessões reais (register/login); membros por SQL com permission_keys;
// contatos semeados por SQL. Contrato combinado com o Operário (Bigorna): /api/quick-replies, /api/message-templates,
// /api/global-variables, /api/stickers (+ /favorite), POST /api/content/render.
import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDb } from '@crm/db'
import { createTempDatabase, type TempDatabase } from '@crm/db/testing'
import { FsBlobStore, MemoryMailer, redisConnection } from '@crm/node-kit'
import { FakeWaGateway } from '@crm/wa-port/testing'
import { createClient, type ApiClient } from '../helpers/http'
import { fakeEmail, fakePhone, uniqueId } from '../helpers/factories'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

export interface Env {
  tmp: TempDatabase
  db: Any
  app: Any
  q: (text: string, params?: unknown[]) => Promise<Any[]>
  close: () => Promise<void>
}

export async function startEnv(): Promise<Env> {
  const api: Any = await import('@crm/api')
  const tmp = await createTempDatabase({ migrate: true })
  const db = createDb(tmp.url)
  db.$client.on?.('error', () => {})
  const redis = redisConnection()
  redis.on?.('error', () => {})
  const storageDir = mkdtempSync(join(tmpdir(), 'crm-t35-'))
  const close = async () => {
    await Promise.resolve(api.stopRealtimeHub?.(redis)).catch(() => {})
    await Promise.resolve(redis.quit?.()).catch(() => redis.disconnect?.())
    await db.$client.end().catch(() => {})
    await tmp.drop()
    rmSync(storageDir, { recursive: true, force: true })
  }
  try {
    const app = api.createApp({
      db,
      redis,
      mailer: new MemoryMailer(),
      waGateway: new FakeWaGateway(),
      blobStore: new FsBlobStore({ dir: storageDir }),
      mediaSigningKey: randomBytes(32),
      trustProxy: true,
    })
    const q = async (text: string, params: unknown[] = []) => (await db.$client.query(text, params)).rows
    return { tmp, db, app, q, close }
  } catch (err) {
    await close().catch(() => {})
    throw err
  }
}

const randomIp = () => `10.${randomBytes(1)[0]}.${randomBytes(1)[0]}.${1 + (randomBytes(1)[0]! % 250)}`

function client(env: Env): ApiClient {
  const ip = randomIp()
  return createClient({
    fetcher: (path, init) => {
      const headers = new Headers(init.headers)
      headers.set('x-forwarded-for', ip)
      return env.app.request(path, { ...init, headers })
    },
  })
}

export interface User {
  c: ApiClient
  userId: string
  companyId: string
  token: string
}

/** Cadastro + login reais: owner da própria empresa (ativa no cliente). */
export async function newOwner(env: Env): Promise<User> {
  const password = `Senha-${randomBytes(6).toString('hex')}`
  const email = fakeEmail('t35')
  const c = client(env)
  const reg = await c.post('/api/auth/register', { name: `Pessoa ${uniqueId('t35')}`, email, password, password_confirmation: password })
  if (reg.status >= 300) throw new Error(`cadastro falhou: ${reg.status} ${reg.text}`)
  const login = await c.post('/api/auth/login', { email, password })
  if (login.status !== 200) throw new Error(`login falhou: ${login.status} ${login.text}`)
  const [u] = await env.q(`SELECT id FROM crm.users WHERE lower(email) = lower($1)`, [email])
  const [m] = await env.q(`SELECT company_id FROM crm.company_members WHERE user_id = $1 AND role = 'owner' LIMIT 1`, [u.id])
  c.setCompany(m.company_id)
  return { c, userId: u.id, companyId: m.company_id, token: c.cookies.get('crm_session')! }
}

/** Usuário novo como membro da empresa; `keys = null` usa a matriz padrão do papel. */
export async function newMember(env: Env, companyId: string, keys: string[] | null, role: 'member' | 'admin' = 'member'): Promise<User> {
  const u = await newOwner(env)
  await env.q(`INSERT INTO crm.company_members (company_id, user_id, role, permission_keys) VALUES ($1, $2, $3, $4)`, [companyId, u.userId, role, keys])
  u.c.setCompany(companyId)
  return { ...u, companyId }
}

/** Contato da empresa (e-mail opcional). */
export async function newContact(env: Env, companyId: string, name: string, phone = fakePhone(), email: string | null = null): Promise<string> {
  const [r] = await env.q(`INSERT INTO crm.contacts (company_id, name, phone_e164, email) VALUES ($1, $2, $3, $4) RETURNING id`, [companyId, name, phone, email])
  return r.id
}

/** Upload multipart (campo `file` + campos extras) com a sessão do usuário. */
export async function upload(env: Env, u: User, path: string, bytes: Uint8Array, mime: string, fileName = 'arquivo', extra: Record<string, string> = {}) {
  const form = new FormData()
  form.append('file', new Blob([bytes], { type: mime }), fileName)
  for (const [k, v] of Object.entries(extra)) form.append(k, v)
  const res = await env.app.request(path, {
    method: 'POST',
    headers: { cookie: `crm_session=${u.token}`, 'x-company-id': u.companyId, 'x-requested-with': 'crm', 'x-forwarded-for': randomIp() },
    body: form,
  })
  const text = await res.text()
  let body: Any = text
  try {
    body = text ? JSON.parse(text) : undefined
  } catch {
    /* corpo não-JSON */
  }
  return { status: res.status, body, text }
}

/** POST /api/media (T49) → id da mídia. */
export async function uploadMedia(env: Env, u: User, bytes: Uint8Array, mime = 'image/png'): Promise<string> {
  const res = await upload(env, u, '/api/media', bytes, mime, 'foto.png')
  if (res.status !== 201) throw new Error(`POST /api/media → ${res.status} ${res.text}`)
  return res.body.media.id
}

/** WebP mínimo (RIFF/WEBP, VP8L 1×1) com um chunk extra de `pad` bytes para controlar o tamanho. */
export function webp(pad = 0): Uint8Array {
  const vp8l = [0x56, 0x50, 0x38, 0x4c, 0x0a, 0x00, 0x00, 0x00, 0x2f, 0x00, 0x00, 0x00, 0x10, 0x07, 0x10, 0x11, 0x11, 0x88, 0x88, 0xfe, 0x07, 0x00]
  const extra = pad > 0 ? [0x58, 0x58, 0x58, 0x58, pad & 0xff, (pad >> 8) & 0xff, (pad >> 16) & 0xff, 0, ...new Array(pad + (pad % 2)).fill(0)] : []
  const payload = [0x57, 0x45, 0x42, 0x50, ...vp8l, ...extra]
  const n = payload.length
  return new Uint8Array([0x52, 0x49, 0x46, 0x46, n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, 0, ...payload])
}

/** PNG 1×1 (assinatura + IHDR; suficiente para o mime). */
export const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0, 0x1f, 0x15, 0xc4, 0x89])

export const fieldPaths = (res: { body: Any }) =>
  (res.body?.error?.details?.fields ?? []).map((f: Any) => (Array.isArray(f.path) ? f.path.join('.') : String(f.path)))

export const uid = () => uniqueId('x')
