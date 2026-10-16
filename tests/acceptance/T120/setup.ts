// Sistema MONTADO como produção (T120), contrato combinado com o Cinzel:
// - wa-worker REAL em processo filho (helpers/wa-worker.ts, WA_TRANSPORT=fake);
// - worker do CRM pela MESMA função do main.ts: startProductionWorker({ env, handleSignals: false }) de '@crm/worker'
//   (WA_GATEWAY=rpc, AI_MODE=fake → FakeLlm em production.fakeLlm, exigindo a chave BYOK da empresa);
// - API: createApp com o WaGateway de createWaGatewayFromEnv(WA_GATEWAY=rpc), BlobStore/exportFiles no MESMO STORAGE_DIR
//   e o mesmo CREDENTIALS_KEY; aiKeyProbe falso (cadastrar chave sem rede).
// Tudo observado por HTTP (API e /internal/fake/*), SSE e linhas crm.* de resultado (ai_usage).
import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fakeEmail, uniqueId } from '../helpers/factories'
import { createClient } from '../helpers/http'
import { fake, newWorkerEnv, startWorker, waitFor, type Worker, type WorkerEnv } from '../helpers/wa-worker'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

export interface System {
  wenv: WorkerEnv
  wa: Worker
  tmp: Any
  db: Any
  app: Any
  prod: Any
  storageDir: string
  q: (text: string, params?: unknown[]) => Promise<Any[]>
  close: () => Promise<void>
}

export async function startSystem(): Promise<System> {
  // Redis ISOLADO (db 2..15 aleatório): as filas do CRM têm nome/prefixo fixos e, no db 1 compartilhado,
  // workers de testes de outros worktrees pegariam os jobs desta suíte. Produtores e consumidores leem na chamada.
  const REDIS_URL = `redis://127.0.0.1:6379/${2 + Math.floor(Math.random() * 14)}`
  process.env.REDIS_URL = REDIS_URL
  const wenv = newWorkerEnv()
  wenv.vars.REDIS_URL = REDIS_URL
  const wa = await startWorker(wenv)
  const credentialsKey = randomBytes(32).toString('base64')
  process.env.CREDENTIALS_KEY = credentialsKey
  const storageDir = mkdtempSync(join(tmpdir(), 'crm-t120-storage-'))

  const { createDb }: Any = await import('@crm/db')
  const { createTempDatabase }: Any = await import('@crm/db/testing')
  const kit: Any = await import('@crm/node-kit')
  const core: Any = await import('@crm/core')
  const rpc: Any = await import('@crm/wa-gateway-rpc')
  const wk: Any = await import('@crm/worker')
  const api: Any = await import('@crm/api')
  kit.resetCredentialsCrypto?.()
  kit.initCredentialsCrypto?.()

  const tmp = await createTempDatabase({ migrate: true })
  const db = createDb(tmp.url)
  db.$client.on?.('error', () => {})
  const q = async (text: string, params: unknown[] = []) => (await db.$client.query(text, params)).rows

  const env = {
    ...process.env,
    DATABASE_URL: tmp.url,
    REDIS_URL,
    CREDENTIALS_KEY: credentialsKey,
    STORAGE_DIR: storageDir,
    WA_GATEWAY: 'rpc',
    WA_RPC_URL: wa.url,
    WA_RPC_PROFILE: 'crm',
    INTERNAL_TOKEN: wenv.token,
    WA_EVENTS_STREAM: wenv.stream,
    AI_MODE: 'fake',
    ANTIBAN_MODE: 'passthrough',
    LOG_LEVEL: 'warn',
  }
  const prod = await wk.startProductionWorker({ env, db, migrate: false, handleSignals: false })

  const redis = kit.redisConnection({ url: REDIS_URL })
  redis.on?.('error', () => {})
  const built = rpc.createWaGatewayFromEnv(env, { redis: REDIS_URL })
  const app = api.createApp({
    db,
    redis,
    mailer: new kit.MemoryMailer(),
    waGateway: built.gateway,
    blobStore: new kit.FsBlobStore({ dir: storageDir }),
    exportFiles: new core.FsExportFileStore({ dir: join(storageDir, 'exports') }),
    aiKeyProbe: async () => ({ ok: true }),
    appName: 'ProdutoTesteT120',
    webPublicUrl: 'http://web.t120.test',
    trustProxy: true,
  })

  return {
    wenv,
    wa,
    tmp,
    db,
    app,
    prod,
    storageDir,
    q,
    close: async () => {
      await prod?.stop?.().catch(() => {})
      await built?.close?.().catch(() => {})
      await Promise.resolve(redis.quit?.()).catch(() => {})
      await wa.shutdown().catch(() => wa.kill())
      await db.$client.end().catch(() => {})
      await tmp.drop().catch(() => {})
      rmSync(storageDir, { recursive: true, force: true })
      wenv.cleanup()
    },
  }
}

export interface Tenant {
  c: ReturnType<typeof createClient>
  token: string
  companyId: string
  connectionId: string
  sessionId: string
}

/** Dono + conexão criada pela API (sessão nasce no wa-worker) e aberta pelo controle fake. */
export async function tenant(sys: System): Promise<Tenant> {
  const c = createClient({ fetcher: (path, init) => sys.app.request(path, init) })
  const password = `Senha-${randomBytes(5).toString('hex')}`
  const email = fakeEmail('t120')
  const reg = await c.post('/api/auth/register', { name: `Dona ${uniqueId('t120')}`, email, password, password_confirmation: password })
  if (reg.status >= 300) throw new Error(`cadastro: ${reg.status} ${reg.text}`)
  const login = await c.post('/api/auth/login', { email, password })
  if (login.status !== 200) throw new Error(`login: ${login.status} ${login.text}`)
  const companyId = login.body.companies[0].id
  c.setCompany(companyId)
  const created = await c.post('/api/connections', { name: 'Conexão T120' })
  if (created.status !== 201) throw new Error(`conexão: ${created.status} ${created.text}`)
  const { id: connectionId, session_id: sessionId } = created.body.connection
  const connect = await c.post(`/api/connections/${connectionId}/connect`)
  if (connect.status !== 200) throw new Error(`connect: ${connect.status} ${connect.text}`)
  await waitFor(async () => (await fake(sys.wa, sys.wenv, `sessions/${sessionId}/qr`, {})).status === 200, 20_000, 'transporte fake')
  const open = await fake(sys.wa, sys.wenv, `sessions/${sessionId}/open`)
  if (open.status !== 200) throw new Error(`open: ${open.status} ${JSON.stringify(open.body)}`)
  await waitFor(async () => ['WARMING', 'STABLE'].includes((await c.get(`/api/connections/${connectionId}`)).body?.connection?.session_state), 20_000, 'sessão conectada')
  return { c, token: c.cookies.get('crm_session')!, companyId, connectionId, sessionId }
}

export const phone = () => `+55119${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`
export const jidOf = (e164: string) => `${e164.slice(1)}@s.whatsapp.net`

/** Mensagem chegando do WhatsApp (wa-worker fake). */
export async function receive(sys: System, t: Tenant, from: string, text: string) {
  const r = await fake(sys.wa, sys.wenv, `sessions/${t.sessionId}/receive`, { from: jidOf(from), text })
  if (r.status !== 200) throw new Error(`receive: ${r.status} ${JSON.stringify(r.body)}`)
}

/** Chat do contato (criado pela ingestão no worker montado). */
export async function chatOf(sys: System, t: Tenant, e164: string): Promise<string> {
  return waitFor(
    async () => {
      const rows = await sys.q(
        `SELECT ch.id FROM crm.chats ch JOIN crm.contacts ct ON ct.id = ch.contact_id WHERE ch.company_id = $1 AND ct.phone_e164 = $2`,
        [t.companyId, e164],
      )
      return rows[0]?.id as string | undefined
    },
    30_000,
    `chat de ${e164}`,
  )
}

/** Textos enviados pelo transporte do wa-worker na sessão. */
export async function sentTexts(sys: System, t: Tenant): Promise<string[]> {
  const st = (await fake(sys.wa, sys.wenv, `sessions/${t.sessionId}/state`, undefined, 'GET')).body
  return (st.sent ?? []).map((s: Any) => s.content?.text ?? JSON.stringify(s.content))
}

export async function history(t: Tenant, chatId: string): Promise<Any[]> {
  const r = await t.c.get(`/api/chats/${chatId}/messages`)
  if (r.status !== 200) throw new Error(`histórico: ${r.status} ${r.text}`)
  return r.body.items ?? r.body.messages ?? []
}

/** Fluxo start → mensagem, publicado e ativo, criado pela API. */
export async function messageFlow(t: Tenant, text: string): Promise<string> {
  const f = await t.c.post('/api/flows', { name: uniqueId('Fluxo T120') })
  if (f.status !== 201) throw new Error(`fluxo: ${f.status} ${f.text}`)
  const id = (f.body.flow ?? f.body).id
  const def = {
    schema: 'crm.flow/v1',
    entry: 'start',
    nodes: [
      { id: 'start', type: 'start', name: 'start', position: { x: 0, y: 0 }, actions: [] },
      { id: 'm', type: 'message', name: 'm', position: { x: 200, y: 0 }, actions: [{ id: 'a1', type: 'send_message', order: 0, config: { message_text: text } }] },
    ],
    edges: [{ id: 'e1', from: 'start', handle: 'source', to: 'm' }],
    variables: [],
    refs: {},
  }
  const put = await t.c.put(`/api/flows/${id}/definition`, def)
  if (put.status >= 300) throw new Error(`definição: ${put.status} ${put.text}`)
  const act = await t.c.post(`/api/flows/${id}/activate`, {})
  if (act.status >= 300) throw new Error(`ativar: ${act.status} ${act.text}`)
  return id
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
export { waitFor }
