// AC-T102-06 (API e SSE): o usuário da empresa B não vê nenhum dado da empresa A. Sistema montado (setup.ts).
// A varredura é gerada do próprio app (`app.routes` do Hono de createApp), para não envelhecer: TODA rota GET /api/**
// é chamada por B — sem parâmetros, com `?company_id=<A>`, com `x-company-id: <A>` e, nas rotas com parâmetros, com
// cada id de linha da empresa A (um por tabela crm.* com company_id). Vazamento = a resposta contém um id de A (fora
// o que foi posto na URL), o marcador de texto de A, o e-mail da dona de A.
// A parte "por URL" (telas da web) está em isolation.e2e.ts.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { connectSse, envelopeOf } from '../helpers/sse'
import { aiKey, chatOf, phone, receive, say, activeFlow, edge, startSystem, tag, tenant, waitFor, sleep, type System, type Tenant } from './setup'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

let sys: System
let A: Tenant
let B: Tenant
const MARK = `segredoA${tag()}${tag()}`
/** ids de A por tabela (uma amostra por tabela entra nos parâmetros). */
let idsByTable: Map<string, string[]>
let secrets: string[]
const seedLog: string[] = []

const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

async function tryCreate(what: string, fn: () => Promise<Any>) {
  try {
    const r = await fn()
    if (r && typeof r.status === 'number' && r.status >= 300) seedLog.push(`${what}: ${r.status} ${String(r.text).slice(0, 160)}`)
    return r
  } catch (e) {
    seedLog.push(`${what}: ${(e as Error).message}`)
  }
}

beforeAll(async () => {
  sys = await startSystem()
  A = await tenant(sys)
  B = await tenant(sys)
  const c = A.c
  // dados de A em vários módulos, todos com o marcador
  const p1 = phone()
  const p2 = phone()
  await receive(sys, A.sessionId, p1, `mensagem ${MARK}`)
  await receive(sys, A.sessionId, p2, `outra ${MARK}`)
  const chat1 = await chatOf(sys, A.companyId, p1)
  await chatOf(sys, A.companyId, p2)
  await tryCreate('envio', () => c.post(`/api/chats/${chat1}/messages`, { type: 'text', text: `resposta ${MARK}` }))
  await tryCreate('contato', () => c.post('/api/contacts', { name: `Contato ${MARK}`, phone_e164: phone() }))
  const label = await tryCreate('etiqueta', () => c.post('/api/labels', { name: `Etiqueta ${MARK}`, color: '#ff0000' }))
  await tryCreate('departamento', () => c.post('/api/departments', { name: `Depto ${MARK}` }))
  await tryCreate('resposta rápida', () => c.post('/api/quick-replies', { shortcut: `atalho${tag()}`, title: `Rápida ${MARK}`, message: `Texto ${MARK}`, content: `Texto ${MARK}` }))
  await tryCreate('campo', () => c.post('/api/custom-fields', { name: `Campo ${MARK}`, key: `campo_${tag()}`, type: 'text', field_type: 'text' }))
  await tryCreate('variável', () => c.post('/api/global-variables', { name: `var_${tag()}`, key: `var_${tag()}`, value: `valor ${MARK}` }))
  await tryCreate('pasta', () => c.post('/api/flow-folders', { name: `Pasta ${MARK}` }))
  await tryCreate('fluxo', () => activeFlow(A, [say('M', `Fluxo ${MARK}`)], [edge('start', 'source', 'M')]))
  const crm = await tryCreate('crm', () => c.post('/api/crms', { name: `Funil ${MARK}` }))
  if (crm?.body?.crm?.id) {
    const cols = await c.get(`/api/crms/${crm.body.crm.id}/columns`)
    const col = cols.body?.items?.[0]?.id
    if (col) await tryCreate('card', () => c.post(`/api/crms/${crm.body.crm.id}/cards`, { chat_id: chat1, column_id: col }))
  }
  await tryCreate('produto', () => c.post('/api/products', { name: `Produto ${MARK}`, price_cents: 1000 }))
  await tryCreate('modelo', () => c.post('/api/message-templates', { name: `Modelo ${MARK}`, content: `Olá ${MARK}`, text: `Olá ${MARK}` }))
  await tryCreate('webhook', () => c.post('/api/inbound-webhooks', { name: `Webhook ${MARK}` }))
  await tryCreate('chave IA', () => aiKey(A, 'openai'))
  await tryCreate('agente', () =>
    c.post('/api/ai-agents', { name: `Agente ${MARK}`, generated_prompt: `Prompt ${MARK}`, model: { provider: 'openai', model: 'modelo-t102' }, settings: { buffer_enabled: false }, skills: [] }),
  )
  await tryCreate('agendamento', () => c.post('/api/schedules', { chat_id: chat1, message: `Agendada ${MARK}`, text: `Agendada ${MARK}`, scheduled_at: new Date(Date.now() + 86_400_000).toISOString() }))
  if (label?.body?.label?.id) await tryCreate('etiqueta no chat', () => c.post(`/api/chats/${chat1}/labels`, { label_id: label.body.label.id }))
  await tryCreate('token de API', () => c.post('/api/auth/api-tokens', { name: `Token ${MARK}` }))
  await tryCreate('convite', () => c.post('/api/team/invitations', { email: `convite-${tag()}@example.test`, role: 'member' }))

  // ids de A em TODAS as tabelas crm.* com company_id (resultado do que a API gravou)
  const tables = await sys.q(
    `SELECT c.table_name FROM information_schema.columns c
       JOIN information_schema.columns i ON i.table_schema = c.table_schema AND i.table_name = c.table_name AND i.column_name = 'id'
      WHERE c.table_schema = 'crm' AND c.column_name = 'company_id' AND i.data_type = 'uuid'`,
  )
  idsByTable = new Map()
  for (const { table_name } of tables) {
    const rows = await sys.q(`SELECT id::text AS id FROM crm."${table_name}" WHERE company_id = $1 LIMIT 50`, [A.companyId])
    if (rows.length) idsByTable.set(table_name, rows.map((r: Any) => r.id))
  }
  secrets = [...new Set([A.companyId, A.userId, ...[...idsByTable.values()].flat()].map((s) => s.toLowerCase()))]
}, 600_000)

afterAll(async () => {
  await sys?.close()
}, 120_000)

/** Segredos de A presentes na resposta (ignorando os ids postos na URL). */
function leaks(text: string, allowed: string[] = []): string[] {
  const low = text.toLowerCase()
  const out: string[] = []
  if (low.includes(MARK.toLowerCase())) out.push(`marcador ${MARK}`)
  if (low.includes(A.email.toLowerCase())) out.push(`e-mail ${A.email}`)
  for (const s of secrets) if (!allowed.includes(s) && low.includes(s)) out.push(`id ${s}`)
  return out
}

function getRoutes(): string[] {
  const all: Array<{ method: string; path: string }> = sys.app.routes ?? []
  return [
    ...new Set(
      all
        .filter((r) => r.method === 'GET' && r.path.startsWith('/api/') && !r.path.includes('*') && r.path !== '/api/events')
        .map((r) => r.path),
    ),
  ].sort()
}

const fill = (path: string, value: string) => path.replace(/:[A-Za-z_]+(\{[^}]*\})?/g, value)

describe('T102 — isolamento por API e SSE (AC-T102-06)', () => {
  it('AC-T102-06 a varredura cobre as rotas de listagem e detalhe do app e A tem dados em vários módulos', () => {
    const routes = getRoutes()
    expect(routes.length, 'app.routes vazio: varredura sem rotas').toBeGreaterThan(100)
    for (const must of ['/api/contacts', '/api/chats', '/api/flows', '/api/connections', '/api/ai-agents', '/api/chats/:id/messages']) expect(routes, must).toContain(must)
    for (const tbl of ['contacts', 'chats', 'messages', 'connections', 'flows']) expect(idsByTable.has(tbl), `A sem linhas em crm.${tbl}`).toBe(true)
    expect(idsByTable.size, `poucos módulos com dados de A; falhas de seed: ${seedLog.join(' | ')}`).toBeGreaterThanOrEqual(10)
  })

  it('AC-T102-06 recurso de A pedido por B responde 404 (contatos, chats, mensagens, fluxos, conexões, agentes, funis)', async () => {
    const pick = (t: string) => idsByTable.get(t)?.[0]
    const cases: Array<[string, string | undefined]> = [
      ['/api/contacts/:id', pick('contacts')],
      ['/api/chats/:id', pick('chats')],
      ['/api/chats/:id/messages', pick('chats')],
      ['/api/flows/:id', pick('flows')],
      ['/api/connections/:id', pick('connections')],
      ['/api/ai-agents/:id', pick('ai_agents')],
      ['/api/crms/:id', pick('crms')],
    ]
    for (const [route, id] of cases) {
      if (!id) continue
      const r = await B.c.get(fill(route, id))
      expect(r.status, `${route} com id de A → ${r.status} ${r.text.slice(0, 200)}`).toBe(404)
      expect(leaks(r.text, [id.toLowerCase()]), route).toEqual([])
    }
  })

  it('AC-T102-06 B troca o x-company-id para o de A ou passa ?company_id=A: 404 e nenhum dado de A', async () => {
    const lists = getRoutes().filter((p) => !p.includes(':'))
    const swapped = { 'x-company-id': A.companyId }
    const bad: string[] = []
    for (const path of lists) {
      const r = await B.c.get(path, swapped)
      if (r.status < 300) bad.push(`${path} [x-company-id=A] → ${r.status}`)
      const l1 = leaks(r.text, [A.companyId.toLowerCase()])
      if (l1.length) bad.push(`${path} [x-company-id=A] vazou ${l1.slice(0, 3).join(', ')}`)
      const r2 = await B.c.get(`${path}?company_id=${A.companyId}`)
      const l2 = leaks(r2.text, [A.companyId.toLowerCase()])
      if (l2.length) bad.push(`${path}?company_id=A → ${r2.status} vazou ${l2.slice(0, 3).join(', ')}`)
    }
    expect(bad).toEqual([])
  })

  it('AC-T102-06 varredura de todas as rotas GET: listagens de B e detalhes com ids de A não devolvem dado de A', async () => {
    const routes = getRoutes()
    // B tem dados próprios: as listagens respondem (a varredura não é vazia por erro de sessão)
    expect((await B.c.get('/api/contacts')).status).toBe(200)
    expect((await B.c.get('/api/chats')).status).toBe(200)
    const candidates = [...new Set([A.companyId, A.userId, ...[...idsByTable.values()].map((ids) => ids[0]!)])]
    const bad: string[] = []
    let calls = 0
    for (const path of routes) {
      if (!path.includes(':')) {
        const r = await B.c.get(path)
        calls++
        const l = leaks(r.text)
        if (l.length) bad.push(`${path} → ${r.status} vazou ${l.slice(0, 3).join(', ')}`)
        continue
      }
      for (const id of candidates) {
        const url = fill(path, id)
        const r = await B.c.get(url)
        calls++
        const l = leaks(r.text, [id.toLowerCase()])
        if (l.length) bad.push(`${path} [${id}] → ${r.status} vazou ${l.slice(0, 3).join(', ')}`)
      }
    }
    console.info(`AC-T102-06 varredura: ${routes.length} rotas GET, ${calls} chamadas, ${idsByTable.size} tabelas com dados de A (${[...idsByTable.keys()].join(', ')}); seed com falha: ${seedLog.join(' | ') || 'nenhuma'}`)
    expect(calls).toBeGreaterThan(routes.length)
    expect(bad, `vazamentos de A para B (${bad.length})`).toEqual([])
  }, 900_000)

  it('AC-T102-06 SSE: B não recebe nenhum evento de A e não abre o stream de A', async () => {
    const other = await connectSse((p, i) => sys.app.request(p, i), `/api/events?company_id=${A.companyId}`, { cookie: `crm_session=${B.token}` })
    expect(other.status, other.text).toBe(404)
    expect(leaks(other.text ?? '', [A.companyId.toLowerCase()])).toEqual([])
    await other.close?.()

    const sseA = await connectSse((p, i) => sys.app.request(p, i), `/api/events?company_id=${A.companyId}`, { cookie: `crm_session=${A.token}` })
    const sseB = await connectSse((p, i) => sys.app.request(p, i), `/api/events?company_id=${B.companyId}`, { cookie: `crm_session=${B.token}` })
    expect(sseA.status).toBe(200)
    expect(sseB.status).toBe(200)
    try {
      await sleep(500)
      // atividade de A: mensagem recebida (chat/mensagem) e contato criado/alterado
      const p = phone()
      await receive(sys, A.sessionId, p, `evento ${MARK}`)
      const chat = await chatOf(sys, A.companyId, p)
      await A.c.post(`/api/chats/${chat}/messages`, { type: 'text', text: `evento enviado ${MARK}` })
      await A.c.post('/api/contacts', { name: `Contato SSE ${MARK}`, phone_e164: phone() })
      await waitFor(() => sseA.messages.filter((m) => m.event !== 'ping').length >= 2, 30_000, 'eventos de A no stream de A')
      await sleep(3000)
      const mineA = sseA.events().filter((m) => {
        try {
          return envelopeOf(m).company_id === A.companyId
        } catch {
          return false
        }
      })
      expect(mineA.length, 'o stream de A recebeu os eventos de A').toBeGreaterThan(0)
      for (const m of sseB.events()) {
        let env: Any
        try {
          env = envelopeOf(m)
        } catch {
          env = undefined
        }
        expect(env?.company_id ?? B.companyId, `evento ${m.event} de outra empresa no stream de B`).toBe(B.companyId)
        expect(leaks(m.data), `evento ${m.event} com dado de A`).toEqual([])
      }
    } finally {
      await sseA.close?.()
      await sseB.close?.()
    }
  })
})
