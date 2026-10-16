// AC-T52-01..04: base de conhecimento dos agentes pela API, com ingestão processada pelo AiKnowledgeService.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { connectSse } from '../helpers/sse'
import { buildPdf, closedPort, ingest, newAgent, owner, sourcesPath, startEnv, startSite, upload, type Env, type User } from './setup'

let env: Env
let site: { port: number; close: () => Promise<void> }

beforeAll(async () => {
  env = await startEnv()
  site = await startSite()
}, 120_000)

afterAll(async () => {
  await site?.close()
  await env?.close()
})

async function agentOf(): Promise<{ o: User; agent: string }> {
  const o = await owner(env)
  return { o, agent: await newAgent(o) }
}

const createJson = (o: User, agent: string, body: Record<string, unknown>) => o.c.post(sourcesPath(agent), body)

describe('T52 — ingestão (AC-T52-01)', () => {
  it('AC-T52-01 PDF válido de 2 páginas termina ready com pages_count 2', async () => {
    const { o, agent } = await agentOf()
    const pdf = await buildPdf(['Primeira página: matrícula e mensalidade do curso.', 'Segunda página: certificado ao final.'])
    const r = await upload(env, o, agent, 'pdf', pdf, 'curso.pdf')
    expect(r.status, r.text).toBe(201)
    expect(r.body.source).toMatchObject({ kind: 'pdf', slot: 'pdf', status: 'pending' })
    expect(env.enqueued.some((e) => e.sourceId === r.body.source.id)).toBe(true)
    const done = await ingest(env, o, agent, r.body.source.id)
    expect(done.status).toBe('ready')
    expect(done.pages_count).toBe(2)
    expect(done.error_message ?? null).toBeNull()
  })

  it('AC-T52-01 texto (JSON e arquivo .txt/.md) termina ready', async () => {
    const { o, agent } = await agentOf()
    const a = await createJson(o, agent, { kind: 'text', title: 'Sobre', body: 'Atendemos todo o Brasil com frete grátis acima de 200 reais.' })
    expect(a.status, a.text).toBe(201)
    expect((await ingest(env, o, agent, a.body.source.id)).status).toBe('ready')
    const b = await upload(env, o, agent, 'file', new TextEncoder().encode('# Prazos\nEntrega em até 5 dias úteis.'), 'prazos.md')
    expect(b.status, b.text).toBe(201)
    expect(b.body.source.slot).toBe('text')
    expect((await ingest(env, o, agent, b.body.source.id)).status).toBe('ready')
  })

  it('AC-T52-01 FAQ válida termina ready com questions_count', async () => {
    const { o, agent } = await agentOf()
    const items = [
      { q: 'Qual o horário?', a: 'De segunda a sexta, das 9h às 18h.' },
      { q: 'Aceitam Pix?', a: 'Sim, com 5% de desconto.' },
      { q: 'Tem garantia?', a: 'Sim, 7 dias.' },
    ]
    const r = await createJson(o, agent, { kind: 'faq', items })
    expect(r.status, r.text).toBe(201)
    const done = await ingest(env, o, agent, r.body.source.id)
    expect(done.status).toBe('ready')
    expect(done.questions_count).toBe(3)
  })

  it('AC-T52-01 arquivo > 8 MB → 413 sem criar fonte', async () => {
    const { o, agent } = await agentOf()
    const big = new Uint8Array(8 * 1024 * 1024 + 1024)
    big.set(new TextEncoder().encode('%PDF-1.4\n'))
    const r = await upload(env, o, agent, 'pdf', big, 'grande.pdf')
    expect(r.status, r.text).toBe(413)
    expect(r.body.error.code).toBe('PAYLOAD_TOO_LARGE')
    expect((await o.c.get(sourcesPath(agent))).body.items).toEqual([])
  })

  it('AC-T52-01 PDFs inválidos terminam failed com o código (sem texto, criptografado, ilegível) ou 422 not_pdf', async () => {
    const { o, agent } = await agentOf()
    const notPdf = await upload(env, o, agent, 'pdf', new TextEncoder().encode('não sou um pdf'), 'falso.pdf')
    expect(notPdf.status).toBe(422)
    expect(notPdf.body.error.details?.error_code).toBe('not_pdf')
    const empty = await upload(env, o, agent, 'pdf', await buildPdf(['']), 'vazio.pdf')
    expect((await ingest(env, o, agent, empty.body.source.id))).toMatchObject({ status: 'failed', error_message: 'empty_pdf' })
    const enc = await upload(env, o, agent, 'pdf', await buildPdf(['segredo'], { encrypted: true }), 'cripto.pdf')
    expect((await ingest(env, o, agent, enc.body.source.id))).toMatchObject({ status: 'failed', error_message: 'encrypted_pdf' })
  })
})

describe('T52 — limites por slot (AC-T52-02)', () => {
  it('AC-T52-02 o 3º PDF do agente → 409 LIMIT_REACHED (pdf_limit)', async () => {
    const { o, agent } = await agentOf()
    for (let i = 0; i < 2; i++) expect((await upload(env, o, agent, 'pdf', await buildPdf([`documento ${i}`]), `d${i}.pdf`)).status).toBe(201)
    const third = await upload(env, o, agent, 'pdf', await buildPdf(['terceiro']), 'd3.pdf')
    expect(third.status, third.text).toBe(409)
    expect(third.body.error.code).toBe('LIMIT_REACHED')
    expect(third.body.error.details?.error_code).toBe('pdf_limit')
    expect((await o.c.get(sourcesPath(agent))).body.items.filter((s: any) => s.slot === 'pdf')).toHaveLength(2)
  })

  it('AC-T52-02 2º site, 3º texto e 2º fluxo → 409; o limite é por agente', async () => {
    const { o, agent } = await agentOf()
    expect((await createJson(o, agent, { kind: 'site', url: `http://site.test:${site.port}/` })).status).toBe(201)
    expect((await createJson(o, agent, { kind: 'site', url: `http://site.test:${site.port}/a` })).status).toBe(409)
    for (let i = 0; i < 2; i++) expect((await createJson(o, agent, { kind: 'text', body: `texto número ${i}` })).status).toBe(201)
    expect((await createJson(o, agent, { kind: 'text', body: 'texto 3' })).status).toBe(409)
    // outro agente da mesma empresa tem seus próprios slots
    const other = await newAgent(o)
    expect((await createJson(o, other, { kind: 'site', url: `http://site.test:${site.port}/` })).status).toBe(201)
  })
})

describe('T52 — site (AC-T52-03)', () => {
  it('AC-T52-03 site interno (IP privado) é bloqueado: failed site_unreachable com ssrf_blocked', async () => {
    const { o, agent } = await agentOf()
    const r = await createJson(o, agent, { kind: 'site', url: `http://127.0.0.1:${site.port}/` })
    expect(r.status, r.text).toBe(201)
    const done = await ingest(env, o, agent, r.body.source.id)
    expect(done.status).toBe('failed')
    expect(done.error_message).toBe('site_unreachable')
    expect(done.error_detail).toBe('ssrf_blocked')
  })

  for (const url of ['http://localhost/', 'http://10.0.0.5/', 'http://192.168.1.10/', 'http://[::1]/']) {
    it(`AC-T52-03 ${url} também é bloqueado`, async () => {
      const { o, agent } = await agentOf()
      const r = await createJson(o, agent, { kind: 'site', url })
      expect(r.status, r.text).toBe(201)
      const done = await ingest(env, o, agent, r.body.source.id)
      expect(done).toMatchObject({ status: 'failed', error_message: 'site_unreachable', error_detail: 'ssrf_blocked' })
    })
  }

  it('AC-T52-03 site fora do ar → failed site_unreachable com o detalhe de rede', async () => {
    const { o, agent } = await agentOf()
    const port = await closedPort()
    const r = await createJson(o, agent, { kind: 'site', url: `http://down.test:${port}/` })
    const done = await ingest(env, o, agent, r.body.source.id)
    expect(done.status).toBe('failed')
    expect(done.error_message).toBe('site_unreachable')
    expect(String(done.error_detail)).toMatch(/network_error|timeout|http_\d+/)
  })

  it('AC-T52-03 site permitido no ar → ready com pages_count (página + links do mesmo host); página sem texto → empty_site', async () => {
    const { o, agent } = await agentOf()
    const ok = await createJson(o, agent, { kind: 'site', url: `http://site.test:${site.port}/` })
    const done = await ingest(env, o, agent, ok.body.source.id)
    expect(done.status, JSON.stringify(done)).toBe('ready')
    expect(done.pages_count).toBe(3)
    const { o: o2, agent: a2 } = await agentOf()
    const empty = await createJson(o2, a2, { kind: 'site', url: `http://site.test:${site.port}/vazio` })
    expect(await ingest(env, o2, a2, empty.body.source.id)).toMatchObject({ status: 'failed', error_message: 'empty_site' })
  })
})

describe('T52 — busca e reindexação (AC-T52-04)', () => {
  it('AC-T52-04 search devolve os trechos mais relevantes da fixture, só do agente', async () => {
    const { o, agent } = await agentOf()
    const docs = [
      { title: 'Matrícula', body: 'A matrícula do curso de violão custa 99 reais e pode ser paga no Pix ou cartão.' },
      { title: 'Entrega', body: 'O material didático chega pelos Correios em até 10 dias úteis.' },
    ]
    for (const d of docs) {
      const r = await createJson(o, agent, { kind: 'text', ...d })
      await ingest(env, o, agent, r.body.source.id)
    }
    // outro agente com texto sobre o mesmo assunto não pode aparecer
    const { o: o2, agent: a2 } = await agentOf()
    const leak = await createJson(o2, a2, { kind: 'text', body: 'Matrícula gratuita para alunos antigos do curso de piano.' })
    await ingest(env, o2, a2, leak.body.source.id)

    const res = await env.service.search({ companyId: o.companyId, agentId: agent, query: 'quanto custa a matrícula' })
    expect(res.length).toBeGreaterThan(0)
    expect(res[0].content).toContain('matrícula do curso de violão')
    for (let i = 1; i < res.length; i++) expect(res[i - 1].rank).toBeGreaterThanOrEqual(res[i].rank)
    expect(JSON.stringify(res)).not.toContain('piano')

    const delivery = await env.service.search({ companyId: o.companyId, agentId: agent, query: 'prazo de entrega correios' })
    expect(delivery[0].content).toContain('Correios')
  })

  it('AC-T52-04 a FAQ e o PDF também são encontrados pela busca', async () => {
    const { o, agent } = await agentOf()
    const faq = await createJson(o, agent, { kind: 'faq', items: [{ q: 'Aceitam boleto?', a: 'Sim, boleto com vencimento em 3 dias.' }] })
    await ingest(env, o, agent, faq.body.source.id)
    const pdf = await upload(env, o, agent, 'pdf', await buildPdf(['Regulamento: aulas ao vivo toda quinta-feira.']), 'regras.pdf')
    await ingest(env, o, agent, pdf.body.source.id)
    expect((await env.service.search({ companyId: o.companyId, agentId: agent, query: 'boleto' }))[0].content).toContain('boleto')
    expect((await env.service.search({ companyId: o.companyId, agentId: agent, query: 'aulas quinta' }))[0].content).toContain('quinta')
  })

  it('AC-T52-04 reindexar volta a pending, enfileira de novo e publica ai_knowledge_source.updated', async () => {
    const { o, agent } = await agentOf()
    const r = await createJson(o, agent, { kind: 'text', body: 'Conteúdo para reindexar.' })
    const id = r.body.source.id
    expect((await ingest(env, o, agent, id)).status).toBe('ready')
    const sse = await connectSse((p, i) => env.app.request(p, i), `/api/events?company_id=${o.companyId}`, { cookie: `crm_session=${o.token}` })
    try {
      const before = env.enqueued.filter((e) => e.sourceId === id).length
      const re = await o.c.post(`${sourcesPath(agent)}/${id}/reindex`, {})
      expect(re.status, re.text).toBe(200)
      expect(re.body.source.status).toBe('pending')
      expect(env.enqueued.filter((e) => e.sourceId === id).length).toBe(before + 1)
      const ev = await sse.waitFor((m) => m.event === 'ai_knowledge_source.updated' && JSON.parse(m.data).data?.source_id === id, 10_000)
      expect(JSON.parse(ev.data).data).toMatchObject({ agent_id: agent, source_id: id, status: 'pending' })
      // o processamento publica o estado final
      await env.service.process(id)
      const fin = await sse.waitFor((m) => m.event === 'ai_knowledge_source.updated' && JSON.parse(m.data).data?.source_id === id && JSON.parse(m.data).data?.status === 'ready', 10_000)
      expect(JSON.parse(fin.data).data.status).toBe('ready')
    } finally {
      await sse.close()
    }
  })

  it('AC-T52-04 fonte de outra empresa → 404; excluir remove da busca', async () => {
    const { o, agent } = await agentOf()
    const r = await createJson(o, agent, { kind: 'text', body: 'Informação exclusiva sobre bolsas de estudo.' })
    await ingest(env, o, agent, r.body.source.id)
    const stranger = await owner(env)
    expect((await stranger.c.get(`${sourcesPath(agent)}/${r.body.source.id}`)).status).toBe(404)
    expect((await env.service.search({ companyId: o.companyId, agentId: agent, query: 'bolsas' })).length).toBeGreaterThan(0)
    expect((await o.c.delete(`${sourcesPath(agent)}/${r.body.source.id}`)).status).toBe(204)
    expect(await env.service.search({ companyId: o.companyId, agentId: agent, query: 'bolsas' })).toEqual([])
  })
})
