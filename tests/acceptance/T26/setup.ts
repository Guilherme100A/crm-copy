// Ambiente da suíte T26: banco descartável migrado, Redis real (db 1), MemoryMailer, FsBlobStore temporário e
// FakeWaGateway como `deps.waGateway`. App de `@crm/api` testada sem porta (app.request). Contrato combinado com o Fole.
import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDb } from '@crm/db'
import { createTempDatabase, type TempDatabase } from '@crm/db/testing'
import { FsBlobStore, MemoryMailer, redisConnection } from '@crm/node-kit'
import { FakeWaGateway } from '@crm/wa-port/testing'
import { createClient } from '../helpers/http'
import { fakeEmail, uniqueId } from '../helpers/factories'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

export interface Env {
  tmp: TempDatabase
  db: Any
  redis: Any
  gateway: Any
  app: Any
  q: (text: string, params?: unknown[]) => Promise<Any[]>
  close: () => Promise<void>
}

export async function startEnv(): Promise<Env> {
  const api: Any = await import('@crm/api')
  if (typeof api.createApp !== 'function') throw new Error('@crm/api não exporta createApp')
  const tmp = await createTempDatabase({ migrate: true })
  const storageDir = mkdtempSync(join(tmpdir(), 'crm-t26-blobs-'))
  const db = createDb(tmp.url)
  const redis = redisConnection()
  redis.on?.('error', () => {})
  const gateway = new FakeWaGateway()
  const close = async () => {
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
      blobStore: new FsBlobStore(storageDir),
      waGateway: gateway,
      appName: 'ProdutoTesteT26',
      webPublicUrl: 'http://web.t26.test',
      trustProxy: true,
    })
    const q = async (text: string, params: unknown[] = []) => (await db.$client.query(text, params)).rows
    return { tmp, db, redis, gateway, app, q, close }
  } catch (err) {
    await close().catch(() => {})
    throw err
  }
}

export const fakeIp = () => `10.${randomBytes(1)[0]}.${randomBytes(1)[0]}.${1 + (randomBytes(1)[0]! % 250)}`

export function client(env: Env, ip = fakeIp()) {
  return createClient({
    fetcher: (path, init) => {
      const headers = new Headers(init.headers)
      if (!headers.has('x-forwarded-for')) headers.set('x-forwarded-for', ip)
      return env.app.request(path, { ...init, headers })
    },
  })
}

export interface Owner {
  c: ReturnType<typeof client>
  userId: string
  companyId: string
  email: string
  password: string
}

/** Cadastra (empresa própria, papel owner), loga e fixa X-Company-Id. */
export async function owner(env: Env): Promise<Owner> {
  const password = `Senha-${randomBytes(5).toString('hex')}`
  const email = fakeEmail('t26')
  const c = client(env)
  const reg = await c.post('/api/auth/register', { name: `Dona ${uniqueId('t26')}`, email, password, password_confirmation: password })
  if (reg.status < 200 || reg.status >= 300) throw new Error(`cadastro falhou: ${reg.status} ${reg.text}`)
  const login = await c.post('/api/auth/login', { email, password })
  if (login.status !== 200) throw new Error(`login falhou: ${login.status} ${login.text}`)
  const [row] = await env.q(`SELECT id FROM crm.users WHERE lower(email) = lower($1)`, [email])
  const companyId = login.body?.companies?.[0]?.id
  if (!companyId) throw new Error(`login sem companies[0].id: ${login.text}`)
  c.setCompany(companyId)
  return { c, userId: row.id, companyId, email, password }
}

/** Torna `user` membro da empresa `companyId` com lista explícita de permissões (sem API de equipe nesta onda). */
export async function addMember(env: Env, companyId: string, userId: string, permissionKeys: string[]) {
  await env.q(`INSERT INTO crm.company_members (company_id, user_id, role, permission_keys) VALUES ($1, $2, 'member', $3)`, [companyId, userId, permissionKeys])
}

/** Telefone BR fictício (DDD 11, celular 9xxxx-xxxx) em formato livre e o E.164 esperado. */
export function brMobile() {
  const n = String(Math.floor(Math.random() * 1e8)).padStart(8, '0')
  return { raw: `(11) 9${n.slice(0, 4)}-${n.slice(4)}`, e164: `+55119${n}` }
}
export function brLandline() {
  const n = String(2 + Math.floor(Math.random() * 7)) + String(Math.floor(Math.random() * 1e7)).padStart(7, '0')
  return { raw: `11${n}`, e164: `+5511${n}` }
}

export const fakeLid = () => `${String(Math.floor(Math.random() * 1e15)).padStart(15, '1')}@lid`
export const uniq = (p: string) => `${p}${randomBytes(3).toString('hex')}`
