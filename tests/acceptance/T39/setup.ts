// Ambiente da suíte T39: banco descartável migrado, Redis real, app(s) de `@crm/api` (sem porta) e sessão real
// (POST /api/auth/register + /login). Contrato combinado com o Torno:
//  - /api/ai-agents (GET|POST), /:id (GET|PATCH|DELETE), /:id/{duplicate,publish,pause}; resposta { agent }
//  - deps.aiProviderKeys = { isConfigured({ companyId, provider }) } (sem a dep: chave da plataforma no env)
//  - limite: companies.settings.limits.ai_agents; presets: companies.settings.ai_presets / platform_settings 'ai_presets'
import { mkdtempSync, rmSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDb } from '@crm/db'
import { createTempDatabase, type TempDatabase } from '@crm/db/testing'
import { FsBlobStore, MemoryMailer, redisConnection } from '@crm/node-kit'
import { createClient, type ApiClient } from '../helpers/http'
import { fakeEmail, uniqueId } from '../helpers/factories'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

export type KeyCheck = (args: { companyId: string; provider: string }) => boolean | Promise<boolean>

export interface Env {
  tmp: TempDatabase
  db: Any
  core: Any
  api: Any
  /** app com todas as chaves de provedor configuradas */
  app: Any
  /** cria outro app sobre o mesmo banco (ex.: sem chaves, ou com aiProviderKeys próprio; `undefined` = sem a dep) */
  makeApp: (keys: KeyCheck | undefined) => Any
  q: (text: string, params?: unknown[]) => Promise<Any[]>
  close: () => Promise<void>
}

export async function startEnv(): Promise<Env> {
  const api: Any = await import('@crm/api')
  const core: Any = await import('@crm/core')
  if (typeof api.createApp !== 'function') throw new Error('@crm/api não exporta createApp')
  const tmp = await createTempDatabase({ migrate: true })
  const db = createDb(tmp.url)
  const storage = mkdtempSync(join(tmpdir(), 'crm-t39-'))
  const conns: Any[] = []
  const makeApp = (keys: KeyCheck | undefined) => {
    const redis = redisConnection({})
    redis.on?.('error', () => {})
    conns.push(redis)
    const deps: Any = { db, redis, mailer: new MemoryMailer(), blobStore: new FsBlobStore(storage), trustProxy: true }
    if (keys) deps.aiProviderKeys = { isConfigured: keys }
    return api.createApp(deps)
  }
  const app = makeApp(() => true)
  const q = async (text: string, params: unknown[] = []) => (await db.$client.query(text, params)).rows
  return {
    tmp,
    db,
    core,
    api,
    app,
    makeApp,
    q,
    close: async () => {
      for (const r of conns) {
        await Promise.resolve(api.stopRealtimeHub?.(r)).catch(() => {})
        await Promise.resolve(r.quit?.()).catch(() => r.disconnect?.())
      }
      await db.$client.end().catch(() => {})
      await tmp.drop()
      rmSync(storage, { recursive: true, force: true })
    },
  }
}

const randomIp = () => `10.${randomBytes(1)[0]}.${randomBytes(1)[0]}.${1 + (randomBytes(1)[0]! % 250)}`

export function clientOn(app: Any, companyId?: string): ApiClient {
  const ip = randomIp()
  return createClient({
    fetcher: (path, init) => {
      const headers = new Headers(init.headers)
      headers.set('x-forwarded-for', ip)
      return app.request(path, { ...init, headers })
    },
    companyId: companyId ?? null,
  })
}

export interface Owner {
  c: ApiClient
  companyId: string
  userId: string
  email: string
  password: string
}

/** Cadastro + login reais: owner da própria "Minha empresa". */
export async function newOwner(env: Env, app: Any = env.app): Promise<Owner> {
  const password = `Senha-${randomBytes(6).toString('hex')}`
  const email = fakeEmail('t39')
  const c = clientOn(app)
  const reg = await c.post('/api/auth/register', { name: `Dona ${uniqueId('t39')}`, email, password, password_confirmation: password })
  if (reg.status >= 300) throw new Error(`cadastro falhou: ${reg.status} ${reg.text}`)
  const login = await c.post('/api/auth/login', { email, password })
  if (login.status !== 200) throw new Error(`login falhou: ${login.status} ${login.text}`)
  const companyId = login.body.companies[0].id
  c.setCompany(companyId)
  return { c, companyId, userId: login.body.user.id, email, password }
}

/** Mesmo usuário (cookie) num app diferente sobre o mesmo banco. */
export function sameUserOn(app: Any, o: Owner): ApiClient {
  const c = clientOn(app, o.companyId)
  for (const [k, v] of o.c.cookies) c.cookies.set(k, v)
  return c
}

export const MODEL = { provider: 'openai', model: 'gpt-teste-t39' }

export const SKILLS = [
  { enabled: true, when_text: 'quando o cliente pedir para falar com um humano', action_type: 'transfer_human', action_params: {}, schedule_mode: 'now', silence_amount: 1, silence_unit: 'days' },
  { enabled: false, when_text: 'quando o cliente sumir por dois dias', action_type: 'compose_message', action_params: {}, schedule_mode: 'if_silent', silence_amount: 2, silence_unit: 'days' },
]

export const FIELDS = [
  { key: 'nome', label: 'Nome', variable: '{nome}', enabled: true, position: 0 },
  { key: 'placa', label: 'Placa do carro', variable: '{placa}', enabled: true, position: 1 },
]

export async function createAgent(c: ApiClient, body: Record<string, unknown> = {}) {
  const res = await c.post('/api/ai-agents', body)
  if (res.status !== 201) throw new Error(`criar agente falhou: ${res.status} ${res.text}`)
  return res.body.agent
}

/** Agente pronto para publicar (prompt + modelo explícito). */
export async function readyAgent(c: ApiClient, extra: Record<string, unknown> = {}) {
  return createAgent(c, { name: uniqueId('Agente'), generated_prompt: 'Você é um vendedor educado.', model: MODEL, ...extra })
}

/** Remove ids e carimbos para comparar coleções copiadas. */
export const strip = (list: Any[]) => list.map(({ id, agent_id, created_at, updated_at, ...rest }: Any) => rest)

export async function setAgentLimit(env: Env, companyId: string, limit: number | null) {
  await env.q(
    limit === null
      ? `UPDATE crm.companies SET settings = settings #- '{limits,ai_agents}' WHERE id = $1`
      : `UPDATE crm.companies SET settings = jsonb_set(coalesce(settings, '{}'::jsonb) || jsonb_build_object('limits', coalesce(settings->'limits', '{}'::jsonb)), '{limits,ai_agents}', to_jsonb($2::int)) WHERE id = $1`,
    limit === null ? [companyId] : [companyId, limit],
  )
}

/** Fluxo com um nó cujo action `control_ai_agent` aponta para o agente. */
export async function linkFlow(env: Env, companyId: string, agentId: string) {
  const [flow] = await env.q(`INSERT INTO crm.flows (company_id, name) VALUES ($1, $2) RETURNING id, name`, [companyId, uniqueId('Fluxo')])
  const [node] = await env.q(
    `INSERT INTO crm.flow_nodes (company_id, flow_id, key, type, name, position_x, position_y) VALUES ($1, $2, 'n1', 'action', 'Agente', 0, 0) RETURNING id`,
    [companyId, flow.id],
  )
  await env.q(`INSERT INTO crm.flow_node_actions (company_id, node_id, key, type, config) VALUES ($1, $2, 'a1', 'control_ai_agent', $3)`, [
    companyId,
    node.id,
    JSON.stringify({ mode: 'activate', agent_id: agentId }),
  ])
  return flow as { id: string; name: string }
}

/** Chat com o agente atendendo, no status dado. */
export async function linkChat(env: Env, companyId: string, agentId: string, status: 'waiting' | 'attending' | 'resolved') {
  const [contact] = await env.q(`INSERT INTO crm.contacts (company_id, name) VALUES ($1, $2) RETURNING id`, [companyId, uniqueId('Contato')])
  const [chat] = await env.q(
    `INSERT INTO crm.chats (company_id, connection_id, contact_id, status, ai_agent_id) VALUES ($1, gen_random_uuid(), $2, $3, $4) RETURNING id`,
    [companyId, contact.id, status, agentId],
  )
  return chat.id as string
}
