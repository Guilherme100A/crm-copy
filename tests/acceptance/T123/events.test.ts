// AC-T123-01/02 — montado como produção (setup da T120: wa-worker real, startProductionWorker, API com RPC): os nós de
// lógica e de CRM publicam no SSE da empresa. O fluxo é disparado por palavra-chave (connection-flow-configs, T61/T120).
import { randomBytes } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { connectSse, envelopeOf, type SseConnection } from '../helpers/sse'
import { chatOf, phone, receive, startSystem, tenant, waitFor, type System, type Tenant } from '../T120/setup'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

let sys: System

beforeAll(async () => {
  sys = await startSystem()
}, 300_000)

afterAll(async () => {
  await sys?.close()
}, 120_000)

const tag = () => randomBytes(3).toString('hex')
const act = (id: string, type: string, config: Any) => ({ id, type, order: 0, config })
const nd = (id: string, type: string, actions: Any[] = []) => ({ id, type, name: id, position: { x: 0, y: 0 }, actions })
const msg = (id: string, text: string) => nd(id, 'message', [act(`${id}-a`, 'send_message', { message_text: text })])
const ed = (from: string, handle: string, to: string) => ({ id: `e-${from}-${handle}-${to}`.replace(/[^a-zA-Z0-9-]/g, '_'), from, handle, to })

/** Cria, define e ativa o fluxo pela API (T28) e o liga a uma palavra-chave da conexão. */
async function flowOnKeyword(t: Tenant, nodes: Any[], edges: Any[], keyword: string): Promise<string> {
  const f = await t.c.post('/api/flows', { name: `T123 ${tag()}` })
  expect(f.status, f.text).toBe(201)
  const id = (f.body.flow ?? f.body).id
  const def = { schema: 'crm.flow/v1', entry: 'start', nodes: [nd('start', 'start'), ...nodes], edges, variables: [], refs: {} }
  const put = await t.c.put(`/api/flows/${id}/definition`, def)
  expect(put.status, put.text).toBeLessThan(300)
  const activate = await t.c.post(`/api/flows/${id}/activate`, {})
  expect(activate.status, activate.text).toBeLessThan(300)
  const cfg = await t.c.put(`/api/connection-flow-configs/${t.connectionId}`, { keyword_triggers: [{ flow_id: id, conditions: [{ keyword, match_type: 'equals' }] }] })
  expect(cfg.status, cfg.text).toBe(200)
  return id
}

async function openEvents(t: Tenant): Promise<SseConnection> {
  const conn = await connectSse((path, init) => sys.app.request(path, init), `/api/events?company_id=${t.companyId}`, { cookie: `crm_session=${t.token}` })
  if (conn.status !== 200) throw new Error(`GET /api/events → ${conn.status}: ${conn.text?.slice(0, 300)}`)
  await conn.waitFor((m) => m.event === 'ping', 15_000)
  return conn
}

const data = (m: Any) => envelopeOf(m).data

describe('T123 — distribuidor na montagem de produção', () => {
  it('AC-T123-01 um run que passa pelo distribuidor publica flow.distributor_updated recebido pelo SSE da empresa', async () => {
    const t = await tenant(sys)
    const kw = `dist${tag()}`
    const flowId = await flowOnKeyword(
      t,
      [
        nd('D', 'distributor', [act('D-a', 'distribute_contacts', { outputs: [{ id: 'A', name: 'Saída A', quantity: 1 }, { id: 'B', name: 'Saída B', quantity: 1 }] })]),
        msg('MA', `saída A ${tag()}`),
        msg('MB', `saída B ${tag()}`),
      ],
      [ed('start', 'source', 'D'), ed('D', 'output:A', 'MA'), ed('D', 'output:B', 'MB')],
      kw,
    )
    const sse = await openEvents(t)
    try {
      await receive(sys, t, phone(), kw)
      const ev = await sse.waitFor((m) => m.event === 'flow.distributor_updated' && data(m)?.flow_id === flowId, 60_000)
      const env = envelopeOf(ev)
      expect(env.company_id).toBe(t.companyId)
      expect(env.data.node_id).toBe('D')
      const outputs = env.data.outputs as Any[]
      expect(outputs.map((o) => o.id).sort()).toEqual(['A', 'B'])
      expect(outputs.reduce((n, o) => n + Number(o.count ?? 0), 0)).toBe(1)
    } finally {
      await sse.close()
    }
  }, 180_000)
})

describe('T123 — nós de CRM na montagem de produção', () => {
  it('AC-T123-02 etiqueta publica contact.updated, status publica chat.updated e venda aprovada publica notification.created no SSE', async () => {
    const t = await tenant(sys)
    const [product] = await sys.q(
      `INSERT INTO crm.products (company_id, name, currency, price_min_cents, price_max_cents, price_fallback_cents) VALUES ($1, 'Mentoria', 'BRL', 100, 1000000, 9900) RETURNING public_id`,
      [t.companyId],
    )
    const kw = `crm${tag()}`
    const label = `VIP-${tag()}`
    await flowOnKeyword(
      t,
      [
        nd('TG', 'tags', [act('TG-a', 'add_tags', { action: 'add', tags: [label] })]),
        // o editor (T10) grava o rótulo; o nó (T63) traduz para o enum interno 'attending'
        nd('CS', 'chat_controller', [act('CS-a', 'change_chat_status', { chat_status: 'Atendimento' })]),
        nd('SV', 'approved_sale', [
          act('SV-a', 'register_approved_sale', {
            product_public_id: product.public_id,
            amount_template: '150,00',
            currency_template: 'BRL',
            customer_name_template: '{full_name}',
            push_title_template: 'Venda: {produto.nome}',
            push_body_template: 'Valor {venda.moeda} {venda.valor}',
          }),
        ]),
        msg('M', `fim ${tag()}`),
      ],
      [ed('start', 'source', 'TG'), ed('TG', 'source', 'CS'), ed('CS', 'source', 'SV'), ed('SV', 'source', 'M')],
      kw,
    )
    const sse = await openEvents(t)
    try {
      const from = phone()
      await receive(sys, t, from, kw)
      const chatId = await chatOf(sys, t, from)
      const [contact] = await sys.q(`SELECT id FROM crm.contacts WHERE company_id = $1 AND phone_e164 = $2`, [t.companyId, from])

      const diag = async () => {
        const runs = await sys.q(`SELECT id, status, error, current_node_key FROM crm.flow_runs WHERE contact_id = $1`, [contact.id])
        const steps = runs.length ? await sys.q(`SELECT seq, node_key, action_key, status, error FROM crm.flow_run_steps WHERE run_id = $1 ORDER BY seq, created_at`, [runs[0].id]) : []
        return `runs: ${JSON.stringify(runs)}\nsteps: ${JSON.stringify(steps)}`
      }
      // o contact.updated do nó de etiqueta traz a etiqueta no contato
      const tagEv = await sse
        .waitFor((m) => m.event === 'contact.updated' && data(m)?.contact_id === contact.id && JSON.stringify(data(m)).includes(label), 60_000)
        .catch(async (err) => {
          throw new Error(`${String(err)}\n${await diag()}\neventos: ${JSON.stringify(sse.events('contact.updated').map((m) => data(m)))}`)
        })
      expect(envelopeOf(tagEv).company_id).toBe(t.companyId)
      // o evento pode sair antes do commit do passo: espera a etiqueta aparecer no banco
      await waitFor(
        async () =>
          (await sys.q(`SELECT 1 FROM crm.contact_labels cl JOIN crm.labels l ON l.id = cl.label_id WHERE cl.contact_id = $1 AND l.name = $2`, [contact.id, label])).length
            ? true
            : undefined,
        30_000,
        'etiqueta no contato',
      ).catch(async (err) => {
        throw new Error(`${String(err)}
${await diag()}`)
      })

      const chatEv = await sse.waitFor((m) => m.event === 'chat.updated' && data(m)?.chat_id === chatId && (data(m)?.chat?.status ?? 'attending') === 'attending', 60_000)
      expect(envelopeOf(chatEv).company_id).toBe(t.companyId)

      const push = await sse.waitFor((m) => m.event === 'notification.created' && data(m)?.kind === 'approved_sale', 60_000)
      expect(data(push)).toMatchObject({ title: 'Venda: Mentoria', body: 'Valor BRL 150,00' })
      const sales = await sys.q(`SELECT source, amount_cents FROM crm.sales WHERE company_id = $1`, [t.companyId])
      expect(sales).toHaveLength(1)
      expect(sales[0]).toMatchObject({ source: 'flow' })
      expect(Number(sales[0].amount_cents)).toBe(15_000)
    } finally {
      await sse.close()
    }
  }, 240_000)
})
