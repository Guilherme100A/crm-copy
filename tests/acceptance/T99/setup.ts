// Ambiente da suíte T99 (contrato combinado com o Cinzel):
// - FakeMetaGraph (servidor HTTP local) de '@crm/core/meta-testing': addUser, issueCode, issueToken, setAdAccounts,
//   requests[]/requestsTo(endpoint); valida o appsecret_proof. Nunca a Meta real.
// - createApp({ ..., metaConfig: { appId, appSecret, graphUrl, version, redirectUri, webUrl, dialogUrl } }) e app.request.
// - OAuth: POST /api/meta/oauth/start → { oauth_url } (state na query); GET /api/meta/oauth/callback?code&state com a sessão.
import { createHmac, randomBytes } from 'node:crypto'
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

export const APP_ID = 'app-t99'
export const APP_SECRET = `secret-t99-${randomBytes(6).toString('hex')}`
export const VERSION = 'v26.0'
export const WEB_URL = 'http://web.t99.test'

export const proofOf = (token: string, secret = APP_SECRET) => createHmac('sha256', secret).update(token).digest('hex')

export interface Env {
  tmp: TempDatabase
  db: Any
  app: Any
  fake: Any
  graphUrl: string
  q: (text: string, params?: unknown[]) => Promise<Any[]>
  close: () => Promise<void>
}

export async function startEnv(): Promise<Env> {
  const api: Any = await import('@crm/api')
  const kit: Any = await import('@crm/node-kit')
  const { FakeMetaGraph }: Any = await import('@crm/core/meta-testing')
  const key = kit.generateCredentialsKey ? kit.generateCredentialsKey() : randomBytes(32).toString('base64')
  process.env.CREDENTIALS_KEY = typeof key === 'string' ? key : Buffer.from(key).toString('base64')
  kit.resetCredentialsCrypto?.()
  kit.initCredentialsCrypto?.({ key })

  const fake = new FakeMetaGraph({ appId: APP_ID, appSecret: APP_SECRET, pageSize: 2 })
  const started = await fake.start()
  const graphUrl: string = started?.url ?? fake.url

  const tmp = await createTempDatabase({ migrate: true })
  const storageDir = mkdtempSync(join(tmpdir(), 'crm-t99-'))
  const db = createDb(tmp.url)
  const redis = redisConnection()
  redis.on?.('error', () => {})
  const app = api.createApp({
    db,
    redis,
    mailer: new MemoryMailer(),
    blobStore: new FsBlobStore(storageDir),
    waGateway: new FakeWaGateway(),
    appName: 'ProdutoTesteT99',
    webPublicUrl: WEB_URL,
    trustProxy: true,
    metaConfig: {
      appId: APP_ID,
      appSecret: APP_SECRET,
      graphUrl,
      version: VERSION,
      redirectUri: 'http://api.t99.test/api/meta/oauth/callback',
      webUrl: WEB_URL,
      dialogUrl: 'http://facebook.t99.test/dialog/oauth',
    },
  })
  const q = async (text: string, params: unknown[] = []) => (await db.$client.query(text, params)).rows
  return {
    tmp,
    db,
    app,
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
  token: string
}

let ipSeq = 0
function newClient(env: Env) {
  const ip = `10.99.${Math.floor(++ipSeq / 250)}.${(ipSeq % 250) + 1}`
  return createClient({
    fetcher: (path, init) => {
      const headers = new Headers(init.headers)
      headers.set('x-forwarded-for', ip)
      return env.app.request(path, { ...init, headers })
    },
  })
}

export async function owner(env: Env): Promise<User> {
  const c = newClient(env)
  const password = `Senha-${randomBytes(5).toString('hex')}`
  const email = fakeEmail('t99')
  const reg = await c.post('/api/auth/register', { name: `Dona ${uniqueId('t99')}`, email, password, password_confirmation: password })
  if (reg.status >= 300) throw new Error(`cadastro: ${reg.status} ${reg.text}`)
  const login = await c.post('/api/auth/login', { email, password })
  if (login.status !== 200) throw new Error(`login: ${login.status} ${login.text}`)
  const companyId = login.body.companies[0].id
  c.setCompany(companyId)
  const [u] = await env.q(`SELECT id FROM crm.users WHERE lower(email) = lower($1)`, [email])
  return { c, userId: u.id, companyId, token: c.cookies.get('crm_session')! }
}

/** Usuário novo vinculado à empresa com papel e permissões (null = matriz padrão do papel). */
export async function memberOf(env: Env, companyId: string, role: 'admin' | 'member', permissionKeys: string[] | null): Promise<User> {
  const u = await owner(env)
  await env.q(`INSERT INTO crm.company_members (company_id, user_id, role, permission_keys) VALUES ($1, $2, $3, $4)`, [companyId, u.userId, role, permissionKeys])
  u.c.setCompany(companyId)
  // empresa ativa da sessão = a empresa de destino (o callback usa a empresa ativa)
  await env.q(`UPDATE crm.users SET last_company_id = $2 WHERE id = $1`, [u.userId, companyId])
  return { ...u, companyId }
}

/** POST /api/meta/oauth/start → state da URL. */
export async function startOauth(u: User): Promise<string> {
  const r = await u.c.post('/api/meta/oauth/start', {})
  if (r.status !== 200 && r.status !== 201) throw new Error(`oauth/start: ${r.status} ${r.text}`)
  const url = new URL(r.body.oauth_url)
  const state = url.searchParams.get('state')
  if (!state) throw new Error(`oauth_url sem state: ${r.body.oauth_url}`)
  return state
}

/** GET /api/meta/oauth/callback com a sessão do usuário → { status, location, result }. */
export async function callback(u: User, params: Record<string, string>) {
  const r = await u.c.get(`/api/meta/oauth/callback?${new URLSearchParams(params)}`)
  const location = r.headers.get('location') ?? ''
  const result = location ? new URL(location, WEB_URL).searchParams.get('meta_oauth') : null
  return { status: r.status, location, result }
}

/** Fluxo completo (start → code do fake → callback) para um usuário Meta semeado. */
export async function connectProfile(env: Env, u: User, metaUser: { id: string; name: string; adAccounts: Array<{ id: string; name?: string }> }) {
  env.fake.addUser(metaUser)
  const state = await startOauth(u)
  const code = env.fake.issueCode(metaUser.id)
  const cb = await callback(u, { code, state })
  if (cb.result !== 'success') throw new Error(`callback não deu success: ${cb.status} ${cb.location}`)
  const list = await u.c.get('/api/meta/profiles')
  const profile = list.body.items.find((p: Any) => p.fb_user_id === metaUser.id)
  if (!profile) throw new Error(`perfil ${metaUser.id} não listado: ${list.text}`)
  return profile
}

export const metaUser = (n = 3) => {
  const id = `fbu-${randomBytes(4).toString('hex')}`
  return { id, name: `Pessoa Meta ${id}`, adAccounts: Array.from({ length: n }, (_, i) => ({ id: `act_${id}_${i + 1}`, name: `Conta ${i + 1}` })) }
}
