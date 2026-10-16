// Ambiente da suíte T15: banco descartável migrado, Redis real (db 1), MemoryMailer e FsBlobStore em diretório temporário.
// App de `@crm/api` testada sem porta (app.request). Contrato combinado com o Operário (Torno).
import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDb } from '@crm/db'
import { createTempDatabase, type TempDatabase } from '@crm/db/testing'
import { FsBlobStore, MemoryMailer, redisConnection } from '@crm/node-kit'
import { createClient } from '../helpers/http'
import { fakeEmail, uniqueId } from '../helpers/factories'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

/** Nome do produto e URL do web injetados (deps `appName`/`webPublicUrl`). */
export const APP_NAME_T15 = 'ProdutoTesteT15'
export const WEB_URL_T15 = 'http://web.t15.test'

export interface Env {
  tmp: TempDatabase
  db: Any
  redis: Any
  mailer: Any
  blobStore: Any
  app: Any
  q: (text: string, params?: unknown[]) => Promise<Any[]>
  close: () => Promise<void>
}

export async function startEnv(): Promise<Env> {
  const api: Any = await import('@crm/api')
  if (typeof api.createApp !== 'function') throw new Error('@crm/api não exporta createApp')
  const tmp = await createTempDatabase({ migrate: true })
  const storageDir = mkdtempSync(join(tmpdir(), 'crm-t15-blobs-'))
  const db = createDb(tmp.url)
  const redis = redisConnection()
  redis.on?.('error', () => {})
  const mailer = new MemoryMailer()
  const blobStore = new FsBlobStore(storageDir)
  const close = async () => {
    await Promise.resolve(redis.quit?.()).catch(() => redis.disconnect?.())
    await db.$client.end().catch(() => {})
    await tmp.drop()
    rmSync(storageDir, { recursive: true, force: true })
  }
  try {
    const app = api.createApp({ db, redis, mailer, blobStore, appName: APP_NAME_T15, webPublicUrl: WEB_URL_T15, trustProxy: true })
    const q = async (text: string, params: unknown[] = []) => (await db.$client.query(text, params)).rows
    return { tmp, db, redis, mailer, blobStore, app, q, close }
  } catch (err) {
    await close().catch(() => {})
    throw err
  }
}

/** IP fictício único (rate limit por IP+e-mail isolado por teste). */
export const fakeIp = () => `10.${randomBytes(1)[0]}.${randomBytes(1)[0]}.${1 + (randomBytes(1)[0]! % 250)}`

/** Cliente HTTP caixa-preta (cookie jar + X-Requested-With: crm nas mutações) com IP próprio. */
export function client(env: Env, ip = fakeIp()) {
  return createClient({
    fetcher: (path, init) => {
      const headers = new Headers(init.headers)
      if (!headers.has('x-forwarded-for')) headers.set('x-forwarded-for', ip)
      return env.app.request(path, { ...init, headers })
    },
  })
}

export const newPassword = () => `Senha-${randomBytes(5).toString('hex')}`

export const registration = (overrides: Record<string, unknown> = {}) => {
  const password = newPassword()
  return {
    name: `Usuária ${uniqueId('t15')}`,
    email: fakeEmail('t15'),
    password,
    password_confirmation: password,
    ...overrides,
  }
}

/** Cadastra pela API e devolve credenciais + id do usuário (via banco). */
export async function registerUser(env: Env, overrides: Record<string, unknown> = {}) {
  const data = registration(overrides)
  const res = await client(env).post('/api/auth/register', data)
  if (res.status < 200 || res.status >= 300) throw new Error(`cadastro falhou: ${res.status} ${res.text}`)
  const [row] = await env.q(`SELECT id FROM crm.users WHERE lower(email) = lower($1)`, [data.email])
  return { ...data, userId: row?.id as string }
}

/** Cadastra e loga: devolve o cliente já com cookie de sessão. */
export async function loggedIn(env: Env, overrides: Record<string, unknown> = {}) {
  const user = await registerUser(env, overrides)
  const c = client(env)
  const res = await c.post('/api/auth/login', { email: user.email, password: user.password })
  if (res.status !== 200) throw new Error(`login falhou: ${res.status} ${res.text}`)
  return { user, c, login: res }
}

/** Mensagens do MemoryMailer enviadas para `to`. */
export function mailsTo(env: Env, to: string): Any[] {
  const all: Any[] = env.mailer.messages ?? []
  return all.filter((m) => (Array.isArray(m.to) ? m.to : [m.to]).some((t: string) => String(t).toLowerCase().includes(to.toLowerCase())))
}

/** Extrai o token de reset do link do e-mail (aceita `?token=…` ou `/<token>` no fim do caminho). */
export function resetTokenFrom(mail: Any): string {
  const body = `${mail.text ?? ''}\n${mail.html ?? ''}`
  const urls = body.match(/https?:\/\/[^\s"'<>]+/g) ?? []
  for (const raw of urls) {
    const u = new URL(raw.replace(/&amp;/g, '&'))
    const q = u.searchParams.get('token')
    if (q) return q
    const last = u.pathname.split('/').filter(Boolean).pop()
    if (last && last.length >= 16) return last
  }
  throw new Error(`nenhum link com token no e-mail:\n${body.slice(0, 500)}`)
}

/** Imagem fictícia com cabeçalho real do formato, preenchida até `size` bytes. */
export function fakeImage(kind: 'png' | 'jpeg' | 'webp' | 'gif', size = 2048): Blob {
  const magic: Record<typeof kind, number[]> = {
    png: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
    jpeg: [0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00],
    webp: [0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x20],
    gif: [0x47, 0x49, 0x46, 0x38, 0x39, 0x61],
  }
  const buf = Buffer.alloc(size)
  Buffer.from(magic[kind]).copy(buf)
  if (kind === 'jpeg') buf.writeUInt16BE(0xffd9, size - 2)
  return new Blob([buf], { type: kind === 'jpeg' ? 'image/jpeg' : `image/${kind}` })
}

/** POST multipart do avatar com o cookie do cliente. */
export async function uploadAvatar(env: Env, c: ReturnType<typeof client>, file: Blob, filename: string) {
  const form = new FormData()
  form.append('avatar', file, filename)
  const cookie = [...c.cookies].map(([k, v]) => `${k}=${v}`).join('; ')
  const res = await env.app.request('/api/auth/profile/avatar', {
    method: 'POST',
    headers: { cookie, 'x-requested-with': 'crm', 'x-forwarded-for': fakeIp() },
    body: form,
  })
  const text = await res.text()
  let body: Any = text
  try {
    body = JSON.parse(text)
  } catch {
    /* não JSON */
  }
  return { status: res.status, body, text }
}
