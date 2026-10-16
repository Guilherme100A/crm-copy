// Ambiente da suíte T117: banco descartável migrado, Redis real (db 1), app de `@crm/api` com MemoryMailer,
// sessões criadas pelo login real (POST /api/auth/login) e streams SSE em GET /api/events.
import { mkdtempSync, rmSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDb } from '@crm/db'
import { createTempDatabase, type TempDatabase } from '@crm/db/testing'
import { FsBlobStore, MemoryMailer, redisConnection } from '@crm/node-kit'
import { fakeEmail, uniqueId } from '../helpers/factories'
import { connectSse, type Fetcher, type SseConnection } from '../helpers/sse'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

export const WEB_URL = 'http://web.t117.test'

export interface Env {
  tmp: TempDatabase
  app: Any
  core: Any
  publisher: Any
  mailer: Any
  fetcher: Fetcher
  close: () => Promise<void>
}

export async function startEnv(): Promise<Env> {
  const api: Any = await import('@crm/api')
  const core: Any = await import('@crm/core')
  if (typeof api.createApp !== 'function') throw new Error('@crm/api não exporta createApp')
  if (typeof core.RealtimePublisher !== 'function') throw new Error('@crm/core não exporta RealtimePublisher')
  const tmp = await createTempDatabase({ migrate: true })
  const storageDir = mkdtempSync(join(tmpdir(), 'crm-t117-'))
  const db = createDb(tmp.url)
  const conns: Any[] = []
  const redis = () => {
    const r = redisConnection({})
    r.on?.('error', () => {})
    conns.push(r)
    return r
  }
  const mailer = new MemoryMailer()
  const appRedis = redis()
  const close = async () => {
    for (const r of conns) {
      await Promise.resolve(api.stopRealtimeHub?.(r)).catch(() => {})
      await Promise.resolve(r.quit?.()).catch(() => r.disconnect?.())
    }
    await db.$client.end().catch(() => {})
    await tmp.drop()
    rmSync(storageDir, { recursive: true, force: true })
  }
  try {
    // heartbeat padrão (20 s): fechamento em < 2 s só acontece se o logout encerrar o stream ativamente
    const app = api.createApp({ db, redis: appRedis, mailer, blobStore: new FsBlobStore(storageDir), webPublicUrl: WEB_URL, trustProxy: true })
    const publisher = new core.RealtimePublisher({ redis: redis() })
    const fetcher: Fetcher = (path, init) => {
      const headers = new Headers(init.headers)
      if (!headers.has('x-forwarded-for')) headers.set('x-forwarded-for', randomIp())
      return app.request(path, { ...init, headers })
    }
    return { tmp, app, core, publisher, mailer, fetcher, close }
  } catch (err) {
    await close().catch(() => {})
    throw err
  }
}

const randomIp = () => `10.${randomBytes(1)[0]}.${randomBytes(1)[0]}.${1 + (randomBytes(1)[0]! % 250)}`

export interface HttpResult {
  status: number
  headers: Headers
  body: Any
  text: string
}

/** Requisição JSON pelo fetcher dado (sempre com X-Requested-With: crm nas mutações). */
export async function call(fetcher: Fetcher, method: string, path: string, body?: unknown, cookie?: string): Promise<HttpResult> {
  const headers: Record<string, string> = { accept: 'application/json' }
  if (method !== 'GET') headers['x-requested-with'] = 'crm'
  if (body !== undefined) headers['content-type'] = 'application/json'
  if (cookie) headers.cookie = cookie
  const res = await fetcher(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
  const text = await res.text()
  let parsed: Any = text
  try {
    parsed = text ? JSON.parse(text) : undefined
  } catch {
    /* não JSON */
  }
  return { status: res.status, headers: res.headers, body: parsed, text }
}

export interface Account {
  email: string
  password: string
  companyId: string
}

/** Cadastro pela API (cria "Minha empresa" com o usuário owner). */
export async function register(fetcher: Fetcher): Promise<Account> {
  const password = `Senha-${randomBytes(6).toString('hex')}`
  const email = fakeEmail('t117')
  const res = await call(fetcher, 'POST', '/api/auth/register', { name: `Usuária ${uniqueId('t117')}`, email, password, password_confirmation: password })
  if (res.status < 200 || res.status >= 300) throw new Error(`cadastro falhou: ${res.status} ${res.text}`)
  const login = await call(fetcher, 'POST', '/api/auth/login', { email, password })
  if (login.status !== 200) throw new Error(`login falhou: ${login.status} ${login.text}`)
  const companyId = login.body?.companies?.[0]?.id
  if (!companyId) throw new Error(`login sem companies[0].id: ${login.text}`)
  return { email, password, companyId }
}

/** Login real: devolve o cookie `crm_session=<token>` desta sessão. */
export async function login(fetcher: Fetcher, acc: Account): Promise<string> {
  const res = await call(fetcher, 'POST', '/api/auth/login', { email: acc.email, password: acc.password })
  if (res.status !== 200) throw new Error(`login falhou: ${res.status} ${res.text}`)
  const set = res.headers.getSetCookie().find((s) => s.startsWith('crm_session='))
  if (!set) throw new Error('login sem Set-Cookie crm_session')
  return set.split(';')[0]!
}

/** Abre GET /api/events da empresa com o cookie e espera o ping inicial. */
export async function openStream(fetcher: Fetcher, cookie: string, companyId: string): Promise<SseConnection> {
  const conn = await connectSse(fetcher, `/api/events?company_id=${encodeURIComponent(companyId)}`, { cookie })
  if (conn.status !== 200) throw new Error(`GET /api/events → ${conn.status}: ${conn.text?.slice(0, 300)}`)
  await conn.waitFor((m) => m.event === 'ping', 10_000)
  return conn
}

/** Espera o stream terminar; devolve o tempo gasto (ou Infinity se não terminou dentro do limite). */
export async function endedWithin(conn: SseConnection, t0: number, limitMs: number): Promise<number> {
  await Promise.race([conn.ended, new Promise((r) => setTimeout(r, limitMs + 500))])
  return conn.isEnded() ? Date.now() - t0 : Number.POSITIVE_INFINITY
}

/** Token do link de reset enviado ao e-mail (`...?token=<tok>` ou último segmento do caminho). */
export function resetToken(mailer: Any, email: string): string {
  const mail = [...(mailer.messages ?? [])].reverse().find((m: Any) => (Array.isArray(m.to) ? m.to : [m.to]).some((t: string) => String(t).toLowerCase() === email.toLowerCase()))
  if (!mail) throw new Error(`nenhum e-mail para ${email}`)
  const body = `${mail.text ?? ''}\n${mail.html ?? ''}`
  for (const raw of body.match(/https?:\/\/[^\s"'<>]+/g) ?? []) {
    const u = new URL(raw.replace(/&amp;/g, '&'))
    const tok = u.searchParams.get('token') ?? u.pathname.split('/').filter(Boolean).pop()
    if (tok && tok.length >= 16) return tok
  }
  throw new Error(`e-mail sem link de reset:\n${body.slice(0, 400)}`)
}
