// Ambiente da suíte T40: banco descartável migrado, Redis real (db 1), MemoryMailer, FsBlobStore temporário e
// FakeWaGateway como `deps.waGateway`. App de `@crm/api` testada sem porta (app.request). Contrato combinado com o Cinzel.
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

// a senha do proxy é cifrada com a CREDENTIALS_KEY (SPEC 1.4 nº 8)
process.env.CREDENTIALS_KEY ??= randomBytes(32).toString('base64')

export interface Env {
  tmp: TempDatabase
  db: Any
  gateway: Any
  app: Any
  q: (text: string, params?: unknown[]) => Promise<Any[]>
  close: () => Promise<void>
}

export async function startEnv(gatewayOpts: Record<string, unknown> = {}): Promise<Env> {
  const api: Any = await import('@crm/api')
  if (typeof api.createApp !== 'function') throw new Error('@crm/api não exporta createApp')
  const tmp = await createTempDatabase({ migrate: true })
  const storageDir = mkdtempSync(join(tmpdir(), 'crm-t40-blobs-'))
  const db = createDb(tmp.url)
  const redis = redisConnection()
  redis.on?.('error', () => {})
  const gateway = new FakeWaGateway(gatewayOpts)
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
      appName: 'ProdutoTesteT40',
      webPublicUrl: 'http://web.t40.test',
      trustProxy: true,
    })
    const q = async (text: string, params: unknown[] = []) => (await db.$client.query(text, params)).rows
    return { tmp, db, gateway, app, q, close }
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

export interface User {
  c: ReturnType<typeof client>
  userId: string
  companyId: string
}

/** Cadastra (empresa própria, papel owner), loga e fixa X-Company-Id. */
export async function owner(env: Env): Promise<User> {
  const password = `Senha-${randomBytes(5).toString('hex')}`
  const email = fakeEmail('t40')
  const c = client(env)
  const reg = await c.post('/api/auth/register', { name: `Dona ${uniqueId('t40')}`, email, password, password_confirmation: password })
  if (reg.status < 200 || reg.status >= 300) throw new Error(`cadastro falhou: ${reg.status} ${reg.text}`)
  const login = await c.post('/api/auth/login', { email, password })
  if (login.status !== 200) throw new Error(`login falhou: ${login.status} ${login.text}`)
  const [row] = await env.q(`SELECT id FROM crm.users WHERE lower(email) = lower($1)`, [email])
  const companyId = login.body?.companies?.[0]?.id
  if (!companyId) throw new Error(`login sem companies[0].id: ${login.text}`)
  c.setCompany(companyId)
  return { c, userId: row.id, companyId }
}

/** Usuário novo vinculado à empresa `companyId` como member com permissões explícitas; cliente já na empresa. */
export async function member(env: Env, companyId: string, permissionKeys: string[]): Promise<User> {
  const u = await owner(env)
  await env.q(`INSERT INTO crm.company_members (company_id, user_id, role, permission_keys) VALUES ($1, $2, 'member', $3)`, [companyId, u.userId, permissionKeys])
  u.c.setCompany(companyId)
  return { c: u.c, userId: u.userId, companyId }
}

export async function createConnection(u: User, name = `Conexão ${randomBytes(2).toString('hex')}`) {
  const r = await u.c.post('/api/connections', { name })
  if (r.status !== 201) throw new Error(`criar conexão: ${r.status} ${r.text}`)
  return r.body.connection
}

export async function setLimit(env: Env, companyId: string, limit: number | null) {
  await env.q(
    `UPDATE crm.companies SET settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{limits}', coalesce(settings->'limits', '{}'::jsonb) || jsonb_build_object('connections', $2::int)) WHERE id = $1`,
    [companyId, limit],
  )
}
