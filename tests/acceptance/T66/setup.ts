// Ambiente da suíte T66. Contrato combinado com o Operário (Bigorna):
// GET /api/contacts (T26 estendida: search, label_ids, crm_column_ids, custom_field_key/value, created_at_from/to, skip_total);
// POST /api/contacts/exports, GET /api/contacts/exports(/:id) (job 'contacts_export' da T27, processado pelo createExportsProcessor);
// POST /api/contacts/bulk-deletes (manifesto), GET /api/contacts/bulk-deletes/:id (job 'contacts_bulk_delete', tipo import da T27,
// processado pelo createImportsProcessor); configureContactsBulk({ batchSize }) para forçar vários lotes com pouco dado.
// createApp deps: exportFiles (FsExportFileStore compartilhado com os processors), exportsEnqueue, importsEnqueue.
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
import { connectSse, type SseConnection } from '../helpers/sse'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

export interface Env {
  tmp: TempDatabase
  db: Any
  app: Any
  core: Any
  worker: Any
  enqueued: string[]
  processExport: (jobId: string) => Promise<unknown>
  processImport: (jobId: string) => Promise<unknown>
  q: (text: string, params?: unknown[]) => Promise<Any[]>
  close: () => Promise<void>
}

const fakeJob = (jobId: string, prefix: string) => ({ data: { jobId }, id: `${prefix}-${jobId}`, name: prefix, attemptsMade: 0, opts: { attempts: 1 } })

export async function startEnv(): Promise<Env> {
  const api: Any = await import('@crm/api')
  const core: Any = await import('@crm/core')
  const worker: Any = await import('@crm/worker')
  for (const n of ['createExportsProcessor', 'createImportsProcessor']) if (typeof worker[n] !== 'function') throw new Error(`@crm/worker não exporta ${n}`)
  const tmp = await createTempDatabase({ migrate: true })
  const db = createDb(tmp.url)
  db.$client.on?.('error', () => {})
  const redis = redisConnection()
  redis.on?.('error', () => {})
  const pubRedis = redisConnection()
  pubRedis.on?.('error', () => {})
  const filesDir = mkdtempSync(join(tmpdir(), 'crm-t66-'))
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
      importsEnqueue: async (jobId: string) => void enqueued.push(jobId),
      trustProxy: true,
    })
    const publisher = new core.RealtimePublisher({ redis: pubRedis })
    const exp = worker.createExportsProcessor({ db, files, publisher })
    const imp = worker.createImportsProcessor({ db, files, publisher })
    const wrap = (proc: Any, prefix: string) => async (jobId: string) => {
      try {
        await proc(fakeJob(jobId, prefix))
        return null
      } catch (err) {
        return err
      }
    }
    const q = async (text: string, params: unknown[] = []) => (await db.$client.query(text, params)).rows
    return { tmp, db, app, core, worker, enqueued, processExport: wrap(exp, 'export'), processImport: wrap(imp, 'import'), q, close }
  } catch (err) {
    await close().catch(() => {})
    throw err
  }
}

export function configureBulk(env: Env, opts: { batchSize: number }) {
  const fn = env.core.configureContactsBulk ?? env.worker.configureContactsBulk
  if (typeof fn !== 'function') throw new Error('configureContactsBulk não exportado')
  fn(opts)
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
  const email = fakeEmail('t66')
  const c = client(env)
  const reg = await c.post('/api/auth/register', { name: `Pessoa ${uniqueId('t66')}`, email, password, password_confirmation: password })
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

const usedPhones = new Set<string>()
export function mobile(): string {
  for (;;) {
    const p = `+5511988${String(Math.floor(Math.random() * 1e6)).padStart(6, '0')}`
    if (!usedPhones.has(p)) {
      usedPhones.add(p)
      return p
    }
  }
}

export interface ContactSeed {
  name: string
  phone?: string | null
  email?: string | null
  customFields?: Record<string, unknown>
  createdAt?: string
  optOut?: boolean
}

export async function newContact(env: Env, companyId: string, s: ContactSeed): Promise<string> {
  const [r] = await env.q(
    `INSERT INTO crm.contacts (company_id, name, phone_e164, email, custom_fields, created_at, opt_out)
     VALUES ($1, $2, $3, $4, $5, coalesce($6::timestamptz, now()), $7) RETURNING id`,
    [companyId, s.name, s.phone === undefined ? mobile() : s.phone, s.email ?? null, JSON.stringify(s.customFields ?? {}), s.createdAt ?? null, s.optOut ?? false],
  )
  return r.id
}

/** Uma conexão por empresa (chats.connection_id tem FK para crm.connections; session_id é único global, T40). */
const connectionOf = new Map<string, Promise<string>>()
function connectionFor(env: Env, companyId: string): Promise<string> {
  let p = connectionOf.get(companyId)
  if (!p) {
    p = env
      .q(`INSERT INTO crm.connections (company_id, session_id, name) VALUES ($1, $2, 'Conexão de teste') RETURNING id`, [companyId, `sess-t66-${uniqueId('s').toLowerCase()}`])
      .then((rows) => rows[0].id as string)
    connectionOf.set(companyId, p)
  }
  return p
}

export async function newChat(env: Env, companyId: string, contactId: string, messages = 0): Promise<string> {
  const connectionId = await connectionFor(env, companyId)
  const [ch] = await env.q(`INSERT INTO crm.chats (company_id, connection_id, contact_id) VALUES ($1, $2, $3) RETURNING id`, [companyId, connectionId, contactId])
  for (let i = 0; i < messages; i++)
    await env.q(`INSERT INTO crm.messages (company_id, chat_id, direction, sender_type, type, body, status) VALUES ($1, $2, 'inbound', 'contact', 'text', $3, 'received')`, [
      companyId,
      ch.id,
      `msg ${i}`,
    ])
  return ch.id
}

export async function newLabel(env: Env, companyId: string, name = uniqueId('Etq')): Promise<string> {
  const [r] = await env.q(`INSERT INTO crm.labels (company_id, name, color) VALUES ($1, $2, 'blue') RETURNING id`, [companyId, name])
  return r.id
}

export const labelContact = (env: Env, companyId: string, contactId: string, labelId: string) =>
  env.q(`INSERT INTO crm.contact_labels (company_id, contact_id, label_id) VALUES ($1, $2, $3)`, [companyId, contactId, labelId])
export const labelChat = (env: Env, companyId: string, chatId: string, labelId: string) =>
  env.q(`INSERT INTO crm.chat_labels (company_id, chat_id, label_id) VALUES ($1, $2, $3)`, [companyId, chatId, labelId])

/** Quadro kanban pela API (T50): devolve o quadro com as 3 colunas padrão. */
export async function newBoard(u: User) {
  const res = await u.c.post('/api/crms', { name: uniqueId('Funil') })
  if (res.status !== 201) throw new Error(`POST /api/crms → ${res.status} ${res.text}`)
  return res.body.crm
}

export async function addCard(u: User, crmId: string, chatId: string, columnId: string) {
  const res = await u.c.post(`/api/crms/${crmId}/cards`, { chat_id: chatId, column_id: columnId })
  if (res.status !== 201) throw new Error(`POST cards → ${res.status} ${res.text}`)
  return res.body.card
}

/** Todos os ids da listagem com a query dada (segue as páginas). */
export async function listIds(u: User, query = ''): Promise<string[]> {
  const ids: string[] = []
  for (let page = 1; page < 100; page++) {
    const res = await u.c.get(`/api/contacts?${query}${query ? '&' : ''}limit=50&page=${page}`)
    if (res.status !== 200) throw new Error(`GET /api/contacts?${query} → ${res.status} ${res.text}`)
    ids.push(...res.body.items.map((x: Any) => x.id))
    if (!res.body.page.has_more) break
  }
  return ids.sort()
}

export async function openEvents(env: Env, u: { token: string }, companyId: string): Promise<SseConnection> {
  const conn = await connectSse((path, init) => env.app.request(path, init), `/api/events?company_id=${companyId}`, { cookie: `crm_session=${u.token}` })
  if (conn.status !== 200) throw new Error(`GET /api/events → ${conn.status}: ${conn.text?.slice(0, 300)}`)
  await conn.waitFor((m) => m.event === 'ping', 10_000)
  return conn
}

/** GET /api/jobs/:id/file (T27) → texto sem BOM. */
export async function downloadCsv(env: Env, u: User, jobId: string) {
  const res = await env.app.request(`/api/jobs/${jobId}/file`, { headers: { cookie: `crm_session=${u.token}`, 'x-company-id': u.companyId, 'x-forwarded-for': randomIp() } })
  const text = new TextDecoder('utf-8', { ignoreBOM: true }).decode(await res.arrayBuffer())
  return { status: res.status, text: text.replace(/^﻿/, '') }
}

/** Parser CSV RFC 4180 mínimo. */
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
  return rows.filter((r) => r.some((x) => x !== ''))
}

/** Multipart com o manifesto como arquivo .json. */
export async function postManifestFile(env: Env, u: User, manifest: unknown) {
  const form = new FormData()
  form.append('manifest', new Blob([JSON.stringify(manifest)], { type: 'application/json' }), `customers-bulk-delete-${Date.now()}.json`)
  const res = await env.app.request('/api/contacts/bulk-deletes', {
    method: 'POST',
    headers: { cookie: `crm_session=${u.token}`, 'x-company-id': u.companyId, 'x-requested-with': 'crm', 'x-forwarded-for': randomIp() },
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

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
