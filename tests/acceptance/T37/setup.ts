// Ambiente da suíte T37 (contrato combinado com o Cinzel): createApp + app.request, Redis real (SSE), FakeWaGateway.
// - Admin da plataforma: crm.users.system_role = 'platform_admin' (SQL) e login normal; /api/platform/* sem X-Company-Id.
// - Fixture de uso: AiUsageService({ db }).record({ companyId, requestId, provider, model, usage, at }) de @crm/core (T18):
//   precifica pela vigência em `at` e grava created_at = at; feature/agent_id (colunas da T24) ajustados por UPDATE.
import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDb } from '@crm/db'
import { createTempDatabase, type TempDatabase } from '@crm/db/testing'
import { FsBlobStore, MemoryMailer, redisConnection } from '@crm/node-kit'
import { FakeWaGateway } from '@crm/wa-port/testing'
import { fakeEmail, uniqueId } from '../helpers/factories'
import { createClient } from '../helpers/http'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

process.env.CREDENTIALS_KEY ??= randomBytes(32).toString('base64')

export interface Env {
  tmp: TempDatabase
  db: Any
  app: Any
  core: Any
  q: (text: string, params?: unknown[]) => Promise<Any[]>
  close: () => Promise<void>
}

export async function startEnv(): Promise<Env> {
  const api: Any = await import('@crm/api')
  const core: Any = await import('@crm/core')
  if (typeof core.AiUsageService !== 'function') throw new Error('@crm/core não exporta AiUsageService')
  const tmp = await createTempDatabase({ migrate: true })
  const storageDir = mkdtempSync(join(tmpdir(), 'crm-t37-'))
  const db = createDb(tmp.url)
  const redis = redisConnection()
  redis.on?.('error', () => {})
  const app = api.createApp({
    db,
    redis,
    mailer: new MemoryMailer(),
    blobStore: new FsBlobStore(storageDir),
    waGateway: new FakeWaGateway(),
    appName: 'ProdutoTesteT37',
    webPublicUrl: 'http://web.t37.test',
    trustProxy: true,
  })
  const q = async (text: string, params: unknown[] = []) => (await db.$client.query(text, params)).rows
  return {
    tmp,
    db,
    app,
    core,
    q,
    close: async () => {
      await Promise.resolve(redis.quit?.()).catch(() => redis.disconnect?.())
      await db.$client.end().catch(() => {})
      await tmp.drop()
      rmSync(storageDir, { recursive: true, force: true })
    },
  }
}

export interface User {
  c: ReturnType<typeof createClient>
  userId: string
  companyId: string
  token: string
}

let ipSeq = 0
const nextIp = () => `10.37.${Math.floor(++ipSeq / 250)}.${(ipSeq % 250) + 1}`

/** Cadastra (empresa própria, owner) e loga. */
export async function owner(env: Env): Promise<User> {
  const ip = nextIp()
  const c = createClient({
    fetcher: (path, init) => {
      const headers = new Headers(init.headers)
      headers.set('x-forwarded-for', ip)
      return env.app.request(path, { ...init, headers })
    },
  })
  const password = `Senha-${randomBytes(5).toString('hex')}`
  const email = fakeEmail('t37')
  const reg = await c.post('/api/auth/register', { name: `Dona ${uniqueId('t37')}`, email, password, password_confirmation: password })
  if (reg.status >= 300) throw new Error(`cadastro: ${reg.status} ${reg.text}`)
  const login = await c.post('/api/auth/login', { email, password })
  if (login.status !== 200) throw new Error(`login: ${login.status} ${login.text}`)
  const companyId = login.body.companies[0].id
  c.setCompany(companyId)
  const [u] = await env.q(`SELECT id FROM crm.users WHERE lower(email) = lower($1)`, [email])
  return { c, userId: u.id, companyId, token: c.cookies.get('crm_session')! }
}

/** Admin da plataforma (papel de sistema). */
export async function platformAdmin(env: Env): Promise<User> {
  const u = await owner(env)
  await env.q(`UPDATE crm.users SET system_role = 'platform_admin' WHERE id = $1`, [u.userId])
  return u
}

/** Usuário novo como `member` da empresa, com permissões explícitas. */
export async function member(env: Env, companyId: string, permissionKeys: string[]): Promise<User> {
  const u = await owner(env)
  await env.q(`INSERT INTO crm.company_members (company_id, user_id, role, permission_keys) VALUES ($1, $2, 'member', $3)`, [companyId, u.userId, permissionKeys])
  u.c.setCompany(companyId)
  return { ...u, companyId }
}

export const MODEL_A = { provider: 'openai', model: 'gpt-t37-a' }
export const MODEL_B = { provider: 'anthropic', model: 'claude-t37-b' }

/** Preço pela API da plataforma (vigência informada). */
export async function postPrice(admin: User, m: { provider: string; model: string }, effectiveFrom: string, inMicros: number, outMicros: number) {
  return admin.c.post('/api/platform/ai/prices', {
    provider: m.provider,
    model: m.model,
    kind: 'llm',
    effective_from: effectiveFrom,
    input_per_mtok_micros: inMicros,
    output_per_mtok_micros: outMicros,
  })
}

/** Uso registrado pela porta pública da T18, com data e (opcional) feature/agente. */
export async function recordUsage(
  env: Env,
  companyId: string,
  m: { provider: string; model: string },
  at: Date,
  tokens: { input: number; output: number },
  extra: { feature?: string; agentId?: string } = {},
) {
  const svc = new env.core.AiUsageService({ db: env.db })
  const r = await svc.record({
    companyId,
    requestId: uniqueId('req-t37'),
    provider: m.provider,
    model: m.model,
    usage: { inputTokens: tokens.input, outputTokens: tokens.output },
    at,
  })
  const id = r.usage.id as string
  if (extra.feature || extra.agentId) await env.q(`UPDATE crm.ai_usage SET feature = $2, agent_id = $3 WHERE id = $1`, [id, extra.feature ?? null, extra.agentId ?? null])
  return r.usage
}
