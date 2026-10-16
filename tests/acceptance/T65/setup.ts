// Ambiente da suíte T65 (dashboard de atendimento). Contrato combinado com o Operário (Cinzel):
// GET /api/dashboard/attendance?start_date&end_date (YYYY-MM-DD inclusivos no fuso de companies.time_zone)
//   &connection_ids[]&force_refresh=1 (permissão dashboard.support) →
//   { range, previous_range, cached, computed_at, attendance: { new_leads, attended_leads, resolved_leads, unanswered_chats,
//     response_time_seconds, first_reply_since, attendance_over_time, response_time_over_time, attendance_by_weekday_hour,
//     peak, peaks, leads_by_status_chart, leads_by_user, attendance_by_department, previous, trends, inverted_kpis } }.
// Base = chats com opened_at no período (fuso); "resposta humana" = 1ª crm.messages sender_type='user' com
// coalesce(sent_at, created_at) ≥ opened_at. Fixture semeada por SQL (chats + mensagens), sem WhatsApp.
import { randomBytes } from 'node:crypto'
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
  const close = async () => {
    await Promise.resolve(api.stopRealtimeHub?.(redis)).catch(() => {})
    await Promise.resolve(redis.quit?.()).catch(() => redis.disconnect?.())
    await db.$client.end().catch(() => {})
    await tmp.drop()
  }
  try {
    const app = api.createApp({ db, redis, mailer: new MemoryMailer(), waGateway: new FakeWaGateway(), trustProxy: true })
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
  name: string
}

export async function newOwner(env: Env, name = `Pessoa ${uniqueId('t65')}`): Promise<User> {
  const password = `Senha-${randomBytes(6).toString('hex')}`
  const email = fakeEmail('t65')
  const c = client(env)
  const reg = await c.post('/api/auth/register', { name, email, password, password_confirmation: password })
  if (reg.status >= 300) throw new Error(`cadastro falhou: ${reg.status} ${reg.text}`)
  const login = await c.post('/api/auth/login', { email, password })
  if (login.status !== 200) throw new Error(`login falhou: ${login.status} ${login.text}`)
  const [u] = await env.q(`SELECT id, name FROM crm.users WHERE lower(email) = lower($1)`, [email])
  const [m] = await env.q(`SELECT company_id FROM crm.company_members WHERE user_id = $1 AND role = 'owner' LIMIT 1`, [u.id])
  c.setCompany(m.company_id)
  return { c, userId: u.id, companyId: m.company_id, name: u.name }
}

export async function newMember(env: Env, companyId: string, keys: string[] | null, name?: string): Promise<User> {
  const u = await newOwner(env, name)
  await env.q(`INSERT INTO crm.company_members (company_id, user_id, role, permission_keys) VALUES ($1, $2, 'member', $3)`, [companyId, u.userId, keys])
  u.c.setCompany(companyId)
  return { ...u, companyId }
}

export async function setTimeZone(env: Env, companyId: string, tz: string) {
  await env.q(`UPDATE crm.companies SET time_zone = $2 WHERE id = $1`, [companyId, tz])
}

export async function newConnection(env: Env, companyId: string, name: string): Promise<string> {
  const [r] = await env.q(`INSERT INTO crm.connections (company_id, session_id, name) VALUES ($1, $2, $3) RETURNING id`, [
    companyId,
    `sess-t65-${uniqueId('s').toLowerCase()}`,
    name,
  ])
  return r.id
}

export async function newDepartment(env: Env, companyId: string, name: string, color: string): Promise<string> {
  const [r] = await env.q(`INSERT INTO crm.departments (company_id, name, color) VALUES ($1, $2, $3) RETURNING id`, [companyId, name, color])
  return r.id
}

export type Sender = 'contact' | 'user' | 'bot' | 'ai' | 'flow' | 'system'

export interface ChatSeed {
  connectionId: string
  /** instante com offset explícito, ex.: '2026-06-01T10:00:00-03:00' */
  openedAt: string
  status?: 'waiting' | 'attending' | 'resolved'
  assignedUserId?: string | null
  departmentId?: string | null
  /** mensagens: [remetente, segundos depois da abertura, usuário (sender_type user)] */
  messages?: Array<[Sender, number, string?]>
}

/** Chat + contato + mensagens. first_human_reply_* fica coerente com as mensagens. */
export async function seedChat(env: Env, companyId: string, s: ChatSeed): Promise<string> {
  const [contact] = await env.q(`INSERT INTO crm.contacts (company_id, name) VALUES ($1, $2) RETURNING id`, [companyId, `Lead ${uniqueId('c')}`])
  const opened = new Date(s.openedAt)
  const msgs = s.messages ?? [['contact', 0]]
  const human = msgs.filter(([who, sec]) => who === 'user' && sec >= 0).sort((a, b) => a[1] - b[1])[0]
  const [chat] = await env.q(
    `INSERT INTO crm.chats (company_id, connection_id, contact_id, status, assigned_user_id, department_id, opened_at,
       first_human_reply_at, first_human_reply_by, resolved_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
    [
      companyId,
      s.connectionId,
      contact.id,
      s.status ?? 'waiting',
      s.assignedUserId ?? null,
      s.departmentId ?? null,
      opened.toISOString(),
      human ? new Date(opened.getTime() + human[1] * 1000).toISOString() : null,
      human?.[2] ?? null,
      s.status === 'resolved' ? new Date(opened.getTime() + 3_600_000).toISOString() : null,
    ],
  )
  for (const [who, sec, userId] of msgs) {
    const at = new Date(opened.getTime() + sec * 1000).toISOString()
    const inbound = who === 'contact'
    await env.q(
      `INSERT INTO crm.messages (company_id, chat_id, direction, sender_type, sender_user_id, type, body, status, sent_at, created_at)
       VALUES ($1, $2, $3, $4, $5, 'text', 'msg', $6, $7, $7)`,
      [companyId, chat.id, inbound ? 'inbound' : 'outbound', who, who === 'user' ? (userId ?? null) : null, inbound ? 'received' : 'sent', at],
    )
  }
  return chat.id
}

export interface AttQuery {
  start: string
  end: string
  connectionIds?: string[]
  force?: boolean
}

export function attPath(p: AttQuery): string {
  const qs = new URLSearchParams({ start_date: p.start, end_date: p.end })
  for (const id of p.connectionIds ?? []) qs.append('connection_ids[]', id)
  if (p.force) qs.set('force_refresh', '1')
  return `/api/dashboard/attendance?${qs.toString()}`
}

export async function attendance(u: User, p: AttQuery): Promise<Any> {
  const res = await u.c.get(attPath({ force: true, ...p }))
  if (res.status !== 200) throw new Error(`GET ${attPath(p)} → ${res.status} ${res.text}`)
  return res.body
}

export const sum = (xs: Any[], k: string) => xs.reduce((a, x) => a + Number(x[k] ?? 0), 0)
