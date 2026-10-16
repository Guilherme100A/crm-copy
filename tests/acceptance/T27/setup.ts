// Ambiente da suíte T27. Contrato combinado com o Operário (Bigorna):
// '@crm/core': registerExportKind(kind, { permission, columns, query, count?, fileName? }) → unregister, getExportKind,
//   keysetPages(fetchPage, { pageSize }), FsExportFileStore({ dir }), RealtimePublisher.
// '@crm/worker': createExportsProcessor({ db, files, publisher }) → proc({ data: { jobId } }).
// createApp deps: exportFiles (mesmo FsExportFileStore do processor), exportsEnqueue(jobId) (capturado aqui).
// HTTP: POST /api/jobs { kind, filters?, delimiter? }, GET /api/jobs/:id, GET /api/jobs?kind=&limit=, GET /api/jobs/:id/file.
import { randomBytes } from 'node:crypto'
import { mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDb } from '@crm/db'
import { createTempDatabase, type TempDatabase } from '@crm/db/testing'
import { MemoryMailer, redisConnection } from '@crm/node-kit'
import { FakeWaGateway } from '@crm/wa-port/testing'
import { createClient, type ApiClient } from '../helpers/http'
import { fakeEmail, uniqueId } from '../helpers/factories'
import { connectSse, type SseConnection } from '../helpers/sse'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

export interface Env {
  tmp: TempDatabase
  db: Any
  app: Any
  core: Any
  /** ids de job enfileirados pela API */
  enqueued: string[]
  /** processa o job (processor da fila 'exports'); devolve o erro, se lançar */
  process: (jobId: string) => Promise<unknown>
  filesDir: string
  q: (text: string, params?: unknown[]) => Promise<Any[]>
  close: () => Promise<void>
}

export async function startEnv(): Promise<Env> {
  const api: Any = await import('@crm/api')
  const core: Any = await import('@crm/core')
  const worker: Any = await import('@crm/worker')
  for (const n of ['registerExportKind', 'FsExportFileStore', 'keysetPages']) if (core[n] === undefined) throw new Error(`@crm/core não exporta ${n}`)
  if (typeof worker.createExportsProcessor !== 'function') throw new Error('@crm/worker não exporta createExportsProcessor')
  const tmp = await createTempDatabase({ migrate: true })
  const db = createDb(tmp.url)
  db.$client.on?.('error', () => {})
  const redis = redisConnection()
  redis.on?.('error', () => {})
  const pubRedis = redisConnection()
  pubRedis.on?.('error', () => {})
  const filesDir = mkdtempSync(join(tmpdir(), 'crm-t27-'))
  const close = async () => {
    await Promise.resolve(api.stopRealtimeHub?.(redis)).catch(() => {})
    for (const r of [redis, pubRedis]) await Promise.resolve(r.quit?.()).catch(() => r.disconnect?.())
    await db.$client.end().catch(() => {})
    await tmp.drop()
    rmSync(filesDir, { recursive: true, force: true })
  }
  try {
    const files = new core.FsExportFileStore({ dir: filesDir })
    const enqueued: string[] = []
    const app = api.createApp({
      db,
      redis,
      mailer: new MemoryMailer(),
      waGateway: new FakeWaGateway(),
      exportFiles: files,
      exportsEnqueue: async (jobId: string) => void enqueued.push(jobId),
      trustProxy: true,
    })
    const proc = worker.createExportsProcessor({ db, files, publisher: new core.RealtimePublisher({ redis: pubRedis }) })
    const process = async (jobId: string) => {
      try {
        await proc({ data: { jobId }, id: `export-${jobId}`, name: 'export', attemptsMade: 0, opts: { attempts: 1 } })
        return null
      } catch (err) {
        return err
      }
    }
    const q = async (text: string, params: unknown[] = []) => (await db.$client.query(text, params)).rows
    return { tmp, db, app, core, enqueued, process, filesDir, q, close }
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
  memberId?: string
}

/** Cadastro + login reais: owner da própria empresa (ativa no cliente). */
export async function newOwner(env: Env): Promise<User> {
  const password = `Senha-${randomBytes(6).toString('hex')}`
  const email = fakeEmail('t27')
  const c = client(env)
  const reg = await c.post('/api/auth/register', { name: `Pessoa ${uniqueId('t27')}`, email, password, password_confirmation: password })
  if (reg.status >= 300) throw new Error(`cadastro falhou: ${reg.status} ${reg.text}`)
  const login = await c.post('/api/auth/login', { email, password })
  if (login.status !== 200) throw new Error(`login falhou: ${login.status} ${login.text}`)
  const [u] = await env.q(`SELECT id FROM crm.users WHERE lower(email) = lower($1)`, [email])
  const [m] = await env.q(`SELECT company_id FROM crm.company_members WHERE user_id = $1 AND role = 'owner' LIMIT 1`, [u.id])
  c.setCompany(m.company_id)
  return { c, userId: u.id, companyId: m.company_id, token: c.cookies.get('crm_session')! }
}

/** Usuário novo como membro da empresa, com lista explícita de permissões. */
export async function newMember(env: Env, companyId: string, keys: string[] | null): Promise<User> {
  const u = await newOwner(env)
  const [m] = await env.q(`INSERT INTO crm.company_members (company_id, user_id, role, permission_keys) VALUES ($1, $2, 'member', $3) RETURNING id`, [companyId, u.userId, keys])
  u.c.setCompany(companyId)
  return { ...u, companyId, memberId: m.id }
}

export async function setKeys(env: Env, u: User, keys: string[]) {
  await env.q(`UPDATE crm.company_members SET permission_keys = $3 WHERE company_id = $1 AND user_id = $2`, [u.companyId, u.userId, keys])
}

export async function openEvents(env: Env, u: { token: string }, companyId: string): Promise<SseConnection> {
  const conn = await connectSse((path, init) => env.app.request(path, init), `/api/events?company_id=${companyId}`, { cookie: `crm_session=${u.token}` })
  if (conn.status !== 200) throw new Error(`GET /api/events → ${conn.status}: ${conn.text?.slice(0, 300)}`)
  await conn.waitFor((m) => m.event === 'ping', 10_000)
  return conn
}

/** POST /api/jobs → job criado (e enfileirado). */
export async function createJob(u: User, kind: string, filters: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) {
  const res = await u.c.post('/api/jobs', { kind, filters, ...extra })
  if (res.status !== 201) throw new Error(`POST /api/jobs → ${res.status} ${res.text}`)
  return res.body.job
}

/** GET /api/jobs/:id/file com a sessão do usuário → status, headers e bytes. */
export async function download(env: Env, u: User, jobId: string) {
  const res = await env.app.request(`/api/jobs/${jobId}/file`, { headers: { cookie: `crm_session=${u.token}`, 'x-company-id': u.companyId, 'x-forwarded-for': randomIp() } })
  const bytes = new Uint8Array(await res.arrayBuffer())
  return { status: res.status, headers: res.headers, bytes, text: new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes) }
}

/** Parser CSV RFC 4180 (aspas, aspas dobradas, quebras de linha entre aspas). */
export function parseCsv(text: string, delimiter = ','): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i++
        } else quoted = false
      } else field += ch
    } else if (ch === '"') quoted = true
    else if (ch === delimiter) {
      row.push(field)
      field = ''
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++
      row.push(field)
      rows.push(row)
      row = []
      field = ''
    } else field += ch
  }
  if (field.length || row.length) {
    row.push(field)
    rows.push(row)
  }
  return rows
}

/** Todos os arquivos (recursivo) do diretório de exportações. */
export function filesUnder(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out.push(...filesUnder(p))
    else out.push(p)
  }
  return out
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
