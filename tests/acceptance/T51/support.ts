// Apoio da suíte T51. Superfície pública combinada com o Operário (Bigorna):
// '@crm/core': registerMessagingNodes(registry, { rng?, sleep?, resolveTarget?, loadTemplate?, globals?, mediaUrl? }),
//   pixEmv({ key, merchantName?, city?, amount?, txid? }), crc16ccitt(payload), FlowEngine, FlowStore, createNodeRegistry.
// O envio sai da conexão do chat do run (crm.chats.connection_id → crm.connections.session_id) para o telefone do contato,
// sempre por ctx.wa.send (FakeWaGateway registra em `sent`; presença em `presences`).
import { createDb, runMigrations } from '@crm/db'
import { FakeWaGateway } from '@crm/wa-port/testing'
import { createTempDb, dropTempDb, type TempDb } from '../helpers/pg'
import { uniqueId } from '../helpers/factories'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

export interface Env {
  tmp: TempDb
  db: Any
  core: Any
  store: Any
  q: (text: string, params?: unknown[]) => Promise<Any[]>
  close: () => Promise<void>
}

export async function startEnv(): Promise<Env> {
  const core: Any = await import('@crm/core')
  for (const n of ['FlowEngine', 'FlowStore', 'createNodeRegistry', 'registerMessagingNodes', 'pixEmv', 'crc16ccitt'])
    if (core[n] === undefined) throw new Error(`@crm/core não exporta ${n}`)
  const tmp = createTempDb('crm_acc_t51')
  const db = createDb(tmp.url)
  db.$client.on?.('error', () => {})
  await runMigrations(db, { set: 'crm' })
  return {
    tmp,
    db,
    core,
    store: new core.FlowStore(db),
    q: async (text, params = []) => (await db.$client.query(text, params)).rows,
    close: async () => {
      await db.$client.end().catch(() => {})
      dropTempDb(tmp)
    },
  }
}

/** CRC16-CCITT-FALSE independente (poly 0x1021, init 0xFFFF), para conferir o EMV sem confiar na implementação. */
export function crc16(s: string): string {
  let c = 0xffff
  for (const b of Buffer.from(s, 'utf8')) {
    c ^= b << 8
    for (let i = 0; i < 8; i++) c = c & 0x8000 ? ((c << 1) ^ 0x1021) & 0xffff : (c << 1) & 0xffff
  }
  return c.toString(16).toUpperCase().padStart(4, '0')
}

/** Lê os campos TLV de primeiro nível de um EMV (id → valor). */
export function tlv(emv: string): Record<string, string> {
  const out: Record<string, string> = {}
  let i = 0
  while (i + 4 <= emv.length) {
    const id = emv.slice(i, i + 2)
    const len = Number(emv.slice(i + 2, i + 4))
    out[id] = emv.slice(i + 4, i + 4 + len)
    i += 4 + len
  }
  return out
}

export type Event = ['presence', string, string, string] | ['send', Any] | ['sleep', number]

export interface World {
  companyId: string
  contactId: string
  contactPhone: string
  chatId: string
  sessionId: string
  wa: Any
  timeline: Event[]
  sleeps: number[]
}

/**
 * Empresa + contato "Maria Souza" + conexão (sessão no FakeWaGateway) + chat. Os métodos send/presence do gateway
 * são envolvidos para registrar a ordem de presença, envio e espera numa linha do tempo única.
 */
export async function world(env: Env, opts: { sessions?: Array<{ id: string; state?: string }>; useSession?: string } = {}): Promise<World> {
  const slug = uniqueId('t51').toLowerCase()
  const [co] = await env.q(`INSERT INTO crm.companies (name, slug) VALUES ($1, $2) RETURNING id`, [`Empresa ${slug}`, slug])
  const contactPhone = `+55119${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`
  const [ct] = await env.q(`INSERT INTO crm.contacts (company_id, name, phone_e164) VALUES ($1, 'Maria Souza', $2) RETURNING id`, [co.id, contactPhone])
  const sessions = opts.sessions ?? [{ id: `sess-${slug}` }]
  const wa = new FakeWaGateway({ sessions: sessions as Any })
  const connIds: Record<string, string> = {}
  for (const s of sessions) {
    const [cn] = await env.q(`INSERT INTO crm.connections (company_id, session_id, name) VALUES ($1, $2, $3) RETURNING id`, [co.id, s.id, `Conexão ${s.id}`])
    connIds[s.id] = cn.id
  }
  const sessionId = opts.useSession ?? sessions[0]!.id
  const [ch] = await env.q(`INSERT INTO crm.chats (company_id, connection_id, contact_id) VALUES ($1, $2, $3) RETURNING id`, [co.id, connIds[sessionId], ct.id])
  const timeline: Event[] = []
  const sleeps: number[] = []
  const send = wa.send.bind(wa)
  const presence = wa.presence.bind(wa)
  wa.send = async (req: Any, ...rest: Any[]) => {
    timeline.push(['send', structuredClone(req)])
    return send(req, ...rest)
  }
  wa.presence = async (sid: string, to: string, kind: string) => {
    timeline.push(['presence', sid, to, kind])
    return presence(sid, to, kind as Any)
  }
  return { companyId: co.id, contactId: ct.id, contactPhone, chatId: ch.id, sessionId, wa, timeline, sleeps }
}

export const action = (id: string, type: string, config: Any, order = 0) => ({ id, type, order, config })
export const node = (id: string, type: string, actions: Any[]) => ({ id, type, name: `Nó ${id}`, position: { x: 0, y: 0 }, actions })
export const edge = (from: string, to: string, handle = 'source') => ({ id: `e-${from}-${to}`, from, handle, to })
export const startNode = () => ({ id: 'start', type: 'start', name: 'Início', position: { x: 0, y: 0 }, actions: [] })

/** start → nós em sequência. */
export const chain = (...nodes: Any[]) => ({
  schema: 'crm.flow/v1',
  entry: 'start',
  nodes: [startNode(), ...nodes],
  edges: nodes.map((n: Any, i: number) => edge(i === 0 ? 'start' : nodes[i - 1].id, n.id)),
  variables: [],
  refs: {},
})

/**
 * Publica a definição, cria o run do chat e executa até parar. Deps extras vão para registerMessagingNodes.
 * `rng` padrão = 0; `sleep` registra na linha do tempo e resolve na hora.
 */
export async function run(env: Env, w: World, def: Any, deps: Record<string, unknown> = {}) {
  const ctx = { companyId: w.companyId }
  const flow = await env.store.createFlow(ctx, { name: uniqueId('Fluxo') })
  await env.store.fromDefinition(ctx, flow.id, def)
  await env.store.publish(ctx, flow.id)
  const sleep = async (ms: number) => {
    w.sleeps.push(ms)
    w.timeline.push(['sleep', ms])
  }
  const registry = env.core.registerMessagingNodes(env.core.createNodeRegistry(), { rng: () => 0, sleep, ...deps })
  const engine = new env.core.FlowEngine({ db: env.db, wa: w.wa, registry })
  const { runId } = await engine.startRun(ctx, { flowId: flow.id, contactId: w.contactId, chatId: w.chatId })
  let res: Any
  let error: unknown = null
  try {
    res = await engine.step(runId, 0)
  } catch (err) {
    error = err
  }
  const [row] = await env.q(`SELECT status, error FROM crm.flow_runs WHERE id = $1`, [runId])
  return { runId, res, error, status: row.status as string, row }
}

export const sends = (w: World) => w.timeline.filter((e) => e[0] === 'send').map((e) => e[1] as Any)
