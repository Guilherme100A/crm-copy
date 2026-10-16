// Ambiente da suíte T104 (contrato combinado com o Cinzel):
// - Pixels pela API (createApp + app.request): /api/meta/pixels (facebook.pixel), token cifrado.
// - CapiService({ db, graphUrl: fake.url, testEventCode, isProduction }).send(...) de @crm/core.
// - FakeMetaGraph (@crm/core/meta-testing): addPixel(pixelId, token), capiEventsFor(pixelId), requests[], failNext.
// - Nó `pixel` num fluxo REAL: FlowStore (publicar) + FlowEngine({ db, wa, registry }) com registerPixelNodes e
//   registerMessagingNodes; as arestas success/failure levam a nós de mensagem distintos (o envio mostra o caminho).
import { createHash, randomBytes } from 'node:crypto'
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

export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex')

export interface Env {
  tmp: TempDatabase
  db: Any
  app: Any
  core: Any
  fake: Any
  graphUrl: string
  q: (text: string, params?: unknown[]) => Promise<Any[]>
  close: () => Promise<void>
}

export async function startEnv(): Promise<Env> {
  const api: Any = await import('@crm/api')
  const core: Any = await import('@crm/core')
  const kit: Any = await import('@crm/node-kit')
  const { FakeMetaGraph }: Any = await import('@crm/core/meta-testing')
  for (const n of ['CapiService', 'FlowEngine', 'FlowStore', 'createNodeRegistry', 'registerPixelNodes', 'registerMessagingNodes'])
    if (core[n] === undefined) throw new Error(`@crm/core não exporta ${n}`)
  const key = kit.generateCredentialsKey ? kit.generateCredentialsKey() : randomBytes(32).toString('base64')
  process.env.CREDENTIALS_KEY = typeof key === 'string' ? key : Buffer.from(key).toString('base64')
  kit.resetCredentialsCrypto?.()
  kit.initCredentialsCrypto?.({ key })

  const fake = new FakeMetaGraph({ appId: 'app-t104', appSecret: 'secret-t104' })
  const started = await fake.start()
  const graphUrl: string = started?.url ?? fake.url
  process.env.META_GRAPH_URL = graphUrl

  const tmp = await createTempDatabase({ migrate: true })
  const storageDir = mkdtempSync(join(tmpdir(), 'crm-t104-'))
  const db = createDb(tmp.url)
  const redis = redisConnection()
  redis.on?.('error', () => {})
  const app = api.createApp({
    db,
    redis,
    mailer: new MemoryMailer(),
    blobStore: new FsBlobStore(storageDir),
    waGateway: new FakeWaGateway(),
    appName: 'ProdutoTesteT104',
    webPublicUrl: 'http://web.t104.test',
    trustProxy: true,
  })
  const q = async (text: string, params: unknown[] = []) => (await db.$client.query(text, params)).rows
  return {
    tmp,
    db,
    app,
    core,
    fake,
    graphUrl,
    q,
    close: async () => {
      await (started?.close ?? fake.close)?.call(started ?? fake)
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
}

let ipSeq = 0
export async function owner(env: Env): Promise<User> {
  const ip = `10.104.${Math.floor(++ipSeq / 250)}.${(ipSeq % 250) + 1}`
  const c = createClient({
    fetcher: (path, init) => {
      const headers = new Headers(init.headers)
      headers.set('x-forwarded-for', ip)
      return env.app.request(path, { ...init, headers })
    },
  })
  const password = `Senha-${randomBytes(5).toString('hex')}`
  const email = fakeEmail('t104')
  const reg = await c.post('/api/auth/register', { name: `Dona ${uniqueId('t104')}`, email, password, password_confirmation: password })
  if (reg.status >= 300) throw new Error(`cadastro: ${reg.status} ${reg.text}`)
  const login = await c.post('/api/auth/login', { email, password })
  if (login.status !== 200) throw new Error(`login: ${login.status} ${login.text}`)
  const companyId = login.body.companies[0].id
  c.setCompany(companyId)
  const [u] = await env.q(`SELECT id FROM crm.users WHERE lower(email) = lower($1)`, [email])
  return { c, userId: u.id, companyId }
}

export async function memberOf(env: Env, companyId: string, permissionKeys: string[]): Promise<User> {
  const u = await owner(env)
  await env.q(`INSERT INTO crm.company_members (company_id, user_id, role, permission_keys) VALUES ($1, $2, 'member', $3)`, [companyId, u.userId, permissionKeys])
  u.c.setCompany(companyId)
  return { ...u, companyId }
}

export interface Pixel {
  id: string
  pixelId: string
  token: string
}

/** Pixel criado pela API e cadastrado no fake. */
export async function newPixel(env: Env, u: User, extra: Record<string, unknown> = {}): Promise<Pixel> {
  const pixelId = `${Date.now()}${Math.floor(Math.random() * 1000)}`.slice(-15)
  const token = `EAAB${randomBytes(16).toString('hex')}xyz9`
  const r = await u.c.post('/api/meta/pixels', { name: `Pixel ${uniqueId('px')}`, pixel_id: pixelId, access_token: token, ...extra })
  if (r.status !== 201) throw new Error(`pixel: ${r.status} ${r.text}`)
  env.fake.addPixel(pixelId, token)
  return { id: r.body.pixel.id, pixelId, token }
}

export function capi(env: Env, opts: Record<string, unknown> = {}) {
  return new env.core.CapiService({ db: env.db, graphUrl: env.graphUrl, testEventCode: null, ...opts })
}

/** Eventos que chegaram ao fake para o pixel (1 por evento). */
export const eventsFor = (env: Env, pixelId: string): Any[] => env.fake.capiEventsFor(pixelId)

/** Normaliza ph/em (string ou array) para array. */
export const asList = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : v === undefined || v === null ? [] : [String(v)])

// ---------- fluxo com o nó pixel ----------

export interface World {
  companyId: string
  contactId: string
  chatId: string
  phone: string
  wa: Any
}

/** Empresa (do dono) com contato, conexão/sessão e chat, para rodar um fluxo de verdade. */
export async function world(env: Env, companyId: string, contact: { phone?: string; email?: string } = {}): Promise<World> {
  const phone = contact.phone ?? `+55119${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`
  const [ct] = await env.q(`INSERT INTO crm.contacts (company_id, name, phone_e164, email) VALUES ($1, 'Maria Souza', $2, $3) RETURNING id`, [
    companyId,
    phone,
    contact.email ?? null,
  ])
  const sessionId = `sess-${randomBytes(4).toString('hex')}`
  const wa = new FakeWaGateway({ sessions: [{ id: sessionId }] } as Any)
  const [cn] = await env.q(`INSERT INTO crm.connections (company_id, session_id, name) VALUES ($1, $2, 'Conexão T104') RETURNING id`, [companyId, sessionId])
  const [ch] = await env.q(`INSERT INTO crm.chats (company_id, connection_id, contact_id) VALUES ($1, $2, $3) RETURNING id`, [companyId, cn.id, ct.id])
  return { companyId, contactId: ct.id, chatId: ch.id, phone, wa }
}

const node = (id: string, type: string, actions: Any[]) => ({ id, type, name: `Nó ${id}`, position: { x: 0, y: 0 }, actions })
const msg = (id: string, text: string) => node(id, 'message', [{ id: `a-${id}`, type: 'send_message', order: 0, config: { message_text: text } }])

/** start → pixel → (success → "OK") / (failure → "FALHOU"). */
export function pixelFlow(config: Record<string, unknown>, variables: Array<{ name: string; default?: string }> = []) {
  return {
    schema: 'crm.flow/v1',
    entry: 'start',
    nodes: [
      { id: 'start', type: 'start', name: 'Início', position: { x: 0, y: 0 }, actions: [] },
      node('px', 'pixel', [{ id: 'a-px', type: 'send_pixel_event', order: 0, config }]),
      msg('ok', 'PIXEL_OK'),
      msg('ko', 'PIXEL_FALHOU'),
    ],
    edges: [
      { id: 'e1', from: 'start', handle: 'source', to: 'px' },
      { id: 'e2', from: 'px', handle: 'success', to: 'ok' },
      { id: 'e3', from: 'px', handle: 'failure', to: 'ko' },
    ],
    variables,
    refs: {},
  }
}

/** Publica e executa o fluxo para o chat do mundo; devolve o caminho tomado e o passo do nó pixel. */
export async function runFlow(env: Env, w: World, def: Any, vars?: Record<string, unknown>) {
  const ctx = { companyId: w.companyId }
  const store = new env.core.FlowStore(env.db)
  const flow = await store.createFlow(ctx, { name: uniqueId('Fluxo pixel') })
  await store.fromDefinition(ctx, flow.id, def)
  await store.publish(ctx, flow.id)
  let registry = env.core.createNodeRegistry()
  registry = env.core.registerMessagingNodes(registry, { rng: () => 0, sleep: async () => {} }) ?? registry
  registry = env.core.registerPixelNodes(registry, { graphUrl: env.graphUrl, testEventCode: null }) ?? registry
  const engine = new env.core.FlowEngine({ db: env.db, wa: w.wa, registry })
  const { runId } = await engine.startRun(ctx, { flowId: flow.id, contactId: w.contactId, chatId: w.chatId, ...(vars ? { vars } : {}) })
  let error: unknown = null
  try {
    await engine.step(runId, 0)
  } catch (e) {
    error = e
  }
  const texts = w.wa.sent.map((s: Any) => s.content?.text).filter(Boolean)
  const steps = await env.q(`SELECT node_key, action_key, result FROM crm.flow_run_steps WHERE run_id = $1 ORDER BY seq, created_at`, [runId]).catch(() => [])
  // o nó pode ter mais de uma linha (nó e ação): a saída tomada fica no resultado que traz `handle`
  const pixelStep = steps.find((s: Any) => s.node_key === 'px' && s.result?.handle)
  return { runId, error, texts, steps, handle: pixelStep?.result?.handle as string | undefined }
}
