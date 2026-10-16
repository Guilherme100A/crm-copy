// Ambiente da suíte T67. Contrato combinado com o Operário (Bigorna):
// createApp deps: exportFiles (FsExportFileStore da T27, o mesmo do processor), importsEnqueue(jobId) (capturado aqui),
//   waGateway (FakeWaGateway: recordConsent/optOut/listContacts/sessions).
// '@crm/worker': configureContactsImport({ files, waGateway }), createImportsProcessor({ db, files, publisher }).
// HTTP: POST /api/contacts/imports (multipart), GET /api/contacts/imports/:id, GET /api/contacts/import-template.csv,
//   POST /api/contacts/import-from-whatsapp { connection_id }.
import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDb } from '@crm/db'
import { createTempDatabase, type TempDatabase } from '@crm/db/testing'
import { MemoryMailer, redisConnection } from '@crm/node-kit'
import { FakeWaGateway } from '@crm/wa-port/testing'
import { createClient, type ApiClient } from '../helpers/http'
import { fakeEmail, uniqueId } from '../helpers/factories'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

export interface Env {
  tmp: TempDatabase
  db: Any
  app: Any
  wa: Any
  enqueued: string[]
  process: (jobId: string) => Promise<unknown>
  q: (text: string, params?: unknown[]) => Promise<Any[]>
  close: () => Promise<void>
}

export async function startEnv(): Promise<Env> {
  const api: Any = await import('@crm/api')
  const core: Any = await import('@crm/core')
  const worker: Any = await import('@crm/worker')
  if (typeof worker.createImportsProcessor !== 'function') throw new Error('@crm/worker não exporta createImportsProcessor')
  if (typeof worker.configureContactsImport !== 'function') throw new Error('@crm/worker não exporta configureContactsImport')
  const tmp = await createTempDatabase({ migrate: true })
  const db = createDb(tmp.url)
  db.$client.on?.('error', () => {})
  const redis = redisConnection()
  redis.on?.('error', () => {})
  const pubRedis = redisConnection()
  pubRedis.on?.('error', () => {})
  const filesDir = mkdtempSync(join(tmpdir(), 'crm-t67-'))
  const close = async () => {
    await Promise.resolve(api.stopRealtimeHub?.(redis)).catch(() => {})
    for (const r of [redis, pubRedis]) await Promise.resolve(r.quit?.()).catch(() => r.disconnect?.())
    await db.$client.end().catch(() => {})
    await tmp.drop()
    rmSync(filesDir, { recursive: true, force: true })
  }
  try {
    const files = new core.FsExportFileStore({ dir: filesDir })
    const wa = new FakeWaGateway()
    const enqueued: string[] = []
    const app = api.createApp({
      db,
      redis,
      mailer: new MemoryMailer(),
      waGateway: wa,
      exportFiles: files,
      importsEnqueue: async (jobId: string) => void enqueued.push(jobId),
      trustProxy: true,
    })
    worker.configureContactsImport({ files, waGateway: wa })
    const proc = worker.createImportsProcessor({ db, files, publisher: new core.RealtimePublisher({ redis: pubRedis }) })
    const process = async (jobId: string) => {
      try {
        await proc({ data: { jobId }, id: `import-${jobId}`, name: 'import', attemptsMade: 0, opts: { attempts: 1 } })
        return null
      } catch (err) {
        return err
      }
    }
    const q = async (text: string, params: unknown[] = []) => (await db.$client.query(text, params)).rows
    return { tmp, db, app, wa, enqueued, process, q, close }
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

export async function newOwner(env: Env): Promise<User> {
  const password = `Senha-${randomBytes(6).toString('hex')}`
  const email = fakeEmail('t67')
  const c = client(env)
  const reg = await c.post('/api/auth/register', { name: `Pessoa ${uniqueId('t67')}`, email, password, password_confirmation: password })
  if (reg.status >= 300) throw new Error(`cadastro falhou: ${reg.status} ${reg.text}`)
  const login = await c.post('/api/auth/login', { email, password })
  if (login.status !== 200) throw new Error(`login falhou: ${login.status} ${login.text}`)
  const [u] = await env.q(`SELECT id FROM crm.users WHERE lower(email) = lower($1)`, [email])
  const [m] = await env.q(`SELECT company_id FROM crm.company_members WHERE user_id = $1 AND role = 'owner' LIMIT 1`, [u.id])
  c.setCompany(m.company_id)
  return { c, userId: u.id, companyId: m.company_id, token: c.cookies.get('crm_session')! }
}

export async function newMember(env: Env, companyId: string, keys: string[] | null): Promise<User> {
  const u = await newOwner(env)
  await env.q(`INSERT INTO crm.company_members (company_id, user_id, role, permission_keys) VALUES ($1, $2, 'member', $3)`, [companyId, u.userId, keys])
  u.c.setCompany(companyId)
  return { ...u, companyId }
}

/** Celular brasileiro fictício e único no processo: DDD 11 + 9 dígitos (faixa 999xxxxxx). */
const usedPhones = new Set<string>()
export function mobile(): string {
  for (;;) {
    const p = `+5511999${String(Math.floor(Math.random() * 1e6)).padStart(6, '0')}`
    if (!usedPhones.has(p)) {
      usedPhones.add(p)
      return p
    }
  }
}

/** POST multipart em /api/contacts/imports → resposta crua. */
export async function postImport(env: Env, u: User, csv: Uint8Array | string, fields: Record<string, string | string[]> = {}) {
  const bytes = typeof csv === 'string' ? new TextEncoder().encode(csv) : csv
  const form = new FormData()
  form.append('file', new Blob([bytes], { type: 'text/csv' }), 'contatos.csv')
  for (const [k, v] of Object.entries(fields)) for (const x of Array.isArray(v) ? v : [v]) form.append(k, x)
  const res = await env.app.request('/api/contacts/imports', {
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

/** Envia, processa e devolve o `import` (JobDto) final. */
export async function importCsv(env: Env, u: User, csv: Uint8Array | string, fields: Record<string, string | string[]> = {}) {
  const res = await postImport(env, u, csv, fields)
  if (res.status !== 201) throw new Error(`POST /api/contacts/imports → ${res.status} ${res.text}`)
  const jobId = res.body.job.id
  const err = await env.process(jobId)
  const got = await u.c.get(`/api/contacts/imports/${jobId}`)
  if (got.status !== 200) throw new Error(`GET import → ${got.status} ${got.text} (processor: ${String(err)})`)
  return got.body.import
}

export async function contactByPhone(env: Env, companyId: string, phone: string) {
  const [r] = await env.q(`SELECT * FROM crm.contacts WHERE company_id = $1 AND phone_e164 = $2`, [companyId, phone])
  return r
}

export async function labelsOfContact(env: Env, contactId: string): Promise<string[]> {
  return (
    await env.q(`SELECT l.name FROM crm.contact_labels cl JOIN crm.labels l ON l.id = cl.label_id WHERE cl.contact_id = $1 ORDER BY l.name`, [contactId])
  ).map((r: Any) => r.name)
}

export async function countContacts(env: Env, companyId: string): Promise<number> {
  return Number((await env.q(`SELECT count(*)::int AS n FROM crm.contacts WHERE company_id = $1`, [companyId]))[0].n)
}

export async function newLabel(env: Env, companyId: string, name: string): Promise<string> {
  const [r] = await env.q(`INSERT INTO crm.labels (company_id, name, color) VALUES ($1, $2, 'blue') RETURNING id`, [companyId, name])
  return r.id
}

/**
 * Conexão da empresa com sessão própria (crm.connections.session_id é único global, T40). `state` = estado da sessão
 * criada no FakeWaGateway; `null` = sessão inexistente no gateway.
 */
export async function newConnection(env: Env, companyId: string, state: 'STABLE' | 'DISCONNECTED' | null = 'STABLE'): Promise<{ id: string; sessionId: string }> {
  const sessionId = `sess-t67-${uniqueId('s').toLowerCase()}`
  if (state) env.wa.addSession({ id: sessionId, state })
  const [r] = await env.q(`INSERT INTO crm.connections (company_id, session_id, name) VALUES ($1, $2, $3) RETURNING id`, [companyId, sessionId, `Conexão ${uniqueId('cx')}`])
  return { id: r.id, sessionId }
}

/** Codifica em Windows-1252 (latin1 cobre os acentos do português). */
export const cp1252 = (s: string) => new Uint8Array(Buffer.from(s, 'latin1'))
