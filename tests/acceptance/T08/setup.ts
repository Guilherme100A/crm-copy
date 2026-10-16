// Ambiente da suíte T08: banco descartável migrado, Redis real (db 1), app Hono sem porta + rotas-sonda.
// Contrato combinado com o Operário: superfície pública importada de `@crm/api`.
// Sessões: auth_sessions.token_hash = sha256 hex do token cru.
import { createHash, randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { createDb } from '@crm/db'
import { createTempDatabase, type TempDatabase } from '@crm/db/testing'
import { redisConnection } from '@crm/node-kit'
import { rootPath } from '../helpers/exec'
import { createClient } from '../helpers/http'
import { fakeEmail, uniqueId } from '../helpers/factories'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

export const PROBE = '/api/__t08'

/** Superfície pública da API (`@crm/api`). */
export async function loadApi(): Promise<Any> {
  const api: Any = await import('@crm/api')
  if (typeof api.createApp !== 'function') throw new Error('@crm/api não exporta createApp')
  return api
}

/** zod da própria API (fallback: shared / node-kit, todos zod 4). */
export async function loadZod(): Promise<Any> {
  for (const pkg of ['apps/api', 'packages/shared', 'packages/node-kit']) {
    const manifest = rootPath(...pkg.split('/'), 'package.json')
    if (!existsSync(manifest)) continue
    try {
      const mod: Any = await import(pathToFileURL(createRequire(manifest).resolve('zod')).href)
      return mod.z ?? mod.default ?? mod
    } catch {
      /* próximo */
    }
  }
  throw new Error('zod não encontrado em apps/api, packages/shared ou packages/node-kit')
}

export interface Env {
  tmp: TempDatabase
  db: Any
  redis: Any
  api: Any
  app: Any
  q: (text: string, params?: unknown[]) => Promise<Any[]>
  close: () => Promise<void>
}

/** Registra as rotas-sonda depois de createApp (middlewares globais de /api/* valem para elas). */
async function mountProbes(api: Any, app: Any) {
  const z = await loadZod()
  const ctxOf = (c: Any) => (typeof api.getCtx === 'function' ? api.getCtx(c) : c.get('ctx'))

  app.get(`${PROBE}/whoami`, (c: Any) => {
    const ctx = ctxOf(c)
    return c.json({ user_id: ctx?.user?.id ?? null, company_id: ctx?.companyId ?? null, role: ctx?.member?.role ?? null })
  })
  app.get(`${PROBE}/contacts`, api.requirePerm('contacts.edit'), (c: Any) => c.json({ ok: true }))
  app.post(`${PROBE}/contacts`, api.requirePerm('contacts.edit'), (c: Any) => c.json({ ok: true }, 201))

  const schema = z.object({
    name: z.string().min(2),
    items: z.array(z.object({ qty: z.number().int().positive() })),
  })
  app.post(`${PROBE}/validate`, api.validate('json', schema), (c: Any) => c.json({ ok: true }))

  app.get(`${PROBE}/boom`, () => {
    throw new Error('T08-BOOM-INTERNAL-DETAIL')
  })

  app.post(`${PROBE}/items`, async (c: Any) => {
    const body = await c.req.json().catch(() => ({}))
    if (typeof api.setAudit === 'function')
      api.setAudit(c, {
        action: 't08.items.create',
        targetType: 't08_item',
        targetId: 'item-1',
        detail: { name: body?.name, password: body?.password, nested: { token: body?.token, apiKey: 'APIKEY-T08-DETAIL' } },
      })
    return c.json({ id: 'item-1' }, 201)
  })
}

export async function startEnv(opts: { redisUrl?: string; deadRedis?: boolean } = {}): Promise<Env> {
  const api = await loadApi()
  const tmp = await createTempDatabase({ migrate: true })
  const db = createDb(tmp.url)
  const redis = opts.deadRedis
    ? redisConnection({
        url: 'redis://127.0.0.1:1/1',
        lazyConnect: true,
        maxRetriesPerRequest: 0,
        enableOfflineQueue: false,
        retryStrategy: () => null,
        connectTimeout: 500,
      })
    : redisConnection({ url: opts.redisUrl })
  redis.on?.('error', () => {})
  const close = async () => {
    await Promise.resolve(redis.quit?.()).catch(() => redis.disconnect?.())
    await db.$client.end().catch(() => {})
    await tmp.drop()
  }
  try {
    const app = api.createApp({ db, redis })
    await mountProbes(api, app)
    const q = async (text: string, params: unknown[] = []) => (await db.$client.query(text, params)).rows
    return { tmp, db, redis, api, app, q, close }
  } catch (err) {
    await close().catch(() => {})
    throw err
  }
}

export const sha256Hex = (s: string) => createHash('sha256').update(s).digest('hex')

export async function seedCompany(env: Env, name = uniqueId('Empresa')): Promise<string> {
  const [row] = await env.q(`INSERT INTO crm.companies (name, slug) VALUES ($1, $2) RETURNING id`, [name, uniqueId('slug').toLowerCase()])
  return row.id
}

export async function seedUser(env: Env, lastCompanyId: string | null = null): Promise<string> {
  const [row] = await env.q(
    `INSERT INTO crm.users (email, password_hash, name, last_company_id) VALUES ($1, $2, $3, $4) RETURNING id`,
    [fakeEmail('t08'), 'scrypt$placeholder', 'Usuário T08', lastCompanyId],
  )
  return row.id
}

export async function addMember(env: Env, companyId: string, userId: string, role: 'owner' | 'admin' | 'member', keys: string[] | null = null) {
  await env.q(`INSERT INTO crm.company_members (company_id, user_id, role, permission_keys) VALUES ($1, $2, $3, $4)`, [companyId, userId, role, keys])
}

export async function createSession(env: Env, userId: string, state: 'valid' | 'expired' | 'revoked' = 'valid'): Promise<string> {
  const token = randomBytes(32).toString('base64url')
  const expires = state === 'expired' ? new Date(Date.now() - 60_000) : new Date(Date.now() + 86_400_000)
  const revoked = state === 'revoked' ? new Date(Date.now() - 1_000) : null
  await env.q(`INSERT INTO crm.auth_sessions (user_id, token_hash, expires_at, revoked_at) VALUES ($1, $2, $3, $4)`, [userId, sha256Hex(token), expires, revoked])
  return token
}

/** Cliente HTTP caixa-preta via app.request(), com cookie de sessão. */
export function clientFor(env: Env, token?: string, companyId?: string | null) {
  const client = createClient({ fetcher: (path, init) => env.app.request(path, init), companyId: companyId ?? null })
  if (token) client.cookies.set('crm_session', token)
  return client
}

/** Usuário com sessão válida, owner (ou papel dado) de uma empresa nova que é a last_company_id. */
export async function seedMember(env: Env, role: 'owner' | 'admin' | 'member' = 'owner', keys: string[] | null = null) {
  const companyId = await seedCompany(env)
  const userId = await seedUser(env, companyId)
  await addMember(env, companyId, userId, role, keys)
  const token = await createSession(env, userId)
  return { companyId, userId, token }
}
