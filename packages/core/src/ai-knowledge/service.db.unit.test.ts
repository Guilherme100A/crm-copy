// Base de conhecimento contra Postgres real (AC-T52-01..04): ingestão de PDF/texto/FAQ/fluxo/site, limites por slot,
// SSRF no site, busca textual, reindex e o evento ai_knowledge_source.updated.
import { randomBytes } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { companies, createDb, type Database } from '@crm/db'
import { createTempDatabase, type TempDatabase } from '@crm/db/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { AiAgentsService } from '../ai-agents/service'
import { FlowStore } from '../flows/store/store'
import { AiKnowledgeService, KNOWLEDGE_FILE_MAX_BYTES, type AiKnowledgeJobData } from './service'
import { buildPdf } from './testing/pdf'

let tmp: TempDatabase
let db: Database
let site: Server
let sitePort = 0
let closedPort = 0
const events: { type: string; data: Record<string, unknown> }[] = []
const jobs: AiKnowledgeJobData[] = []

beforeAll(async () => {
  tmp = await createTempDatabase({ migrate: true })
  db = createDb(tmp.url, { max: 4 })
  site = createServer((req, res) => {
    res.setHeader('content-type', 'text/html; charset=utf-8')
    if (req.url === '/') return res.end('<html><head><title>Pizzaria Bella</title></head><body><h1>Pizzaria Bella</h1><p>Entregamos pizza de calabresa em 30 minutos.</p><a href="/horarios">Horários</a></body></html>')
    if (req.url === '/horarios') return res.end('<p>Abrimos de terça a domingo, das 18h às 23h.</p>')
    if (req.url === '/vazio') return res.end('<html><body><script>x()</script></body></html>')
    res.statusCode = 404
    res.end('nada')
  })
  await new Promise<void>((r) => site.listen(0, '127.0.0.1', () => r()))
  sitePort = (site.address() as AddressInfo).port
  const probe = createServer()
  await new Promise<void>((r) => probe.listen(0, '127.0.0.1', () => r()))
  closedPort = (probe.address() as AddressInfo).port
  await new Promise<void>((r) => probe.close(() => r()))
}, 120_000)

afterAll(async () => {
  await new Promise<void>((r) => site.close(() => r()))
  await db?.$client.end()
  await tmp?.drop()
})

/** Lookup de teste: todo host → 127.0.0.1 (só `site.test`/`down.test` são liberados via allowHosts). */
const lookup = async () => [{ address: '127.0.0.1', family: 4 }]
const service = () =>
  new AiKnowledgeService({
    db,
    publisher: { publish: async (_c: string, type: string, data: unknown) => (events.push({ type, data: data as Record<string, unknown> }), '1-0') } as never,
    enqueue: async (d) => void jobs.push(d),
    http: { lookup, allowHosts: ['site.test', 'down.test'] },
  })

async function world() {
  const tag = randomBytes(4).toString('hex')
  const [c] = await db.insert(companies).values({ name: `K${tag}`, slug: `k-t52-${tag}` }).returning()
  const agent = await new AiAgentsService({ db, providerKeys: { isConfigured: () => true } }).create(c!.id, { name: 'Atendente' })
  return { companyId: c!.id, agentId: agent.id }
}

describe('AiKnowledgeService', () => {
  it('AC-T52-01: PDF, texto e FAQ terminam ready com pages_count/questions_count; arquivo > 8 MB → payload_too_large', async () => {
    const w = await world()
    const svc = service()
    const pdf = await svc.create(w.companyId, w.agentId, { kind: 'pdf', file: { filename: 'catalogo.pdf', contentType: 'application/pdf', data: buildPdf(['Tabela de preços', 'Frete grátis acima de 200 reais']) } })
    expect(pdf).toMatchObject({ status: 'pending', slot: 'pdf', filename: 'catalogo.pdf' })
    expect(jobs.at(-1)).toEqual({ companyId: w.companyId, sourceId: pdf.id })
    expect(await svc.process(pdf.id)).toMatchObject({ status: 'ready', pages_count: 2, error_message: null })

    const text = await svc.create(w.companyId, w.agentId, { kind: 'text', title: 'Política', body: 'Trocas em até 7 dias.' })
    expect(await svc.process(text.id)).toMatchObject({ status: 'ready', pages_count: 1, chunks_count: 1 })

    const faq = await svc.create(w.companyId, w.agentId, { kind: 'faq', items: [{ q: 'Vocês entregam?', a: 'Sim, em toda a cidade.' }, { q: 'Aceita Pix?', a: 'Aceitamos Pix e cartão.' }] })
    expect(await svc.process(faq.id)).toMatchObject({ status: 'ready', questions_count: 2, chunks_count: 2 })

    const txtFile = await svc.create(w.companyId, w.agentId, { kind: 'file', file: { filename: 'notas.md', data: Buffer.from('# Notas\nAtendemos sábado.') } })
    expect(txtFile.slot).toBe('text')
    expect(await svc.process(txtFile.id)).toMatchObject({ status: 'ready' })

    await expect(svc.create(w.companyId, w.agentId, { kind: 'pdf', file: { filename: 'grande.pdf', data: Buffer.alloc(KNOWLEDGE_FILE_MAX_BYTES + 1) } })).rejects.toMatchObject({
      code: 'payload_too_large',
      details: { error_code: 'too_large' },
    })
  })

  it('PDF sem texto, criptografado e corrompido terminam failed com o código; não-PDF e extensão errada → validation', async () => {
    const w = await world()
    const svc = service()
    const empty = await svc.create(w.companyId, w.agentId, { kind: 'pdf', file: { filename: 'scan.pdf', data: buildPdf(['']) } })
    expect(await svc.process(empty.id)).toMatchObject({ status: 'failed', error_message: 'empty_pdf', chunks_count: 0 })
    const enc = await svc.create(w.companyId, w.agentId, { kind: 'pdf', file: { filename: 'senha.pdf', data: buildPdf(['x'], { encrypted: true }) } })
    expect(await svc.process(enc.id)).toMatchObject({ status: 'failed', error_message: 'encrypted_pdf' })
    await expect(svc.create(w.companyId, w.agentId, { kind: 'pdf', file: { filename: 'a.pdf', data: Buffer.from('texto') } })).rejects.toMatchObject({ details: { error_code: 'not_pdf' } })
    await expect(svc.create(w.companyId, w.agentId, { kind: 'file', file: { filename: 'a.exe', data: Buffer.from('MZ') } })).rejects.toMatchObject({ details: { error_code: 'unsupported_file' } })
    await expect(svc.create(w.companyId, w.agentId, { kind: 'pdf' })).rejects.toMatchObject({ details: { error_code: 'file_missing' } })
    await expect(svc.create(w.companyId, w.agentId, { kind: 'video' })).rejects.toMatchObject({ details: { error_code: 'unsupported_kind' } })
    await expect(svc.create(w.companyId, w.agentId, { kind: 'text', body: ' ' })).rejects.toMatchObject({ details: { error_code: 'text_required' } })
    await expect(svc.create(w.companyId, w.agentId, { kind: 'faq', items: [{ q: 'só pergunta' }] })).rejects.toMatchObject({ details: { error_code: 'faq_item_required' } })
    await expect(svc.create(w.companyId, w.agentId, { kind: 'site', url: '' })).rejects.toMatchObject({ details: { error_code: 'url_required' } })
    await expect(svc.create(w.companyId, w.agentId, { kind: 'flow', flow_id: randomBytes(16).toString('hex') })).rejects.toMatchObject({ details: { error_code: 'flow_missing' } })
  })

  it('AC-T52-02: limites por slot (3º PDF, 2º site, 3º texto, 2º fluxo) → limit_reached; replace troca as FAQs', async () => {
    const w = await world()
    const svc = service()
    const pdf = () => svc.create(w.companyId, w.agentId, { kind: 'pdf', file: { filename: 'a.pdf', data: buildPdf(['a']) } })
    await pdf()
    await pdf()
    await expect(pdf()).rejects.toMatchObject({ code: 'limit_reached', details: { error_code: 'pdf_limit', limit: 2 } })
    await svc.create(w.companyId, w.agentId, { kind: 'site', url: 'https://exemplo.com' })
    await expect(svc.create(w.companyId, w.agentId, { kind: 'site', url: 'https://outro.com' })).rejects.toMatchObject({ code: 'limit_reached', details: { error_code: 'knowledge_limit' } })
    await svc.create(w.companyId, w.agentId, { kind: 'text', body: 'um' })
    await svc.create(w.companyId, w.agentId, { kind: 'text', body: 'dois' })
    await expect(svc.create(w.companyId, w.agentId, { kind: 'text', body: 'três' })).rejects.toMatchObject({ details: { error_code: 'text_limit' } })
    const faq = { kind: 'faq', items: [{ q: 'p', a: 'r' }] }
    for (let i = 0; i < 10; i++) await svc.create(w.companyId, w.agentId, faq)
    await expect(svc.create(w.companyId, w.agentId, faq)).rejects.toMatchObject({ details: { error_code: 'faq_limit' } })
    await svc.create(w.companyId, w.agentId, { ...faq, replace: true })
    expect((await svc.list(w.companyId, w.agentId)).filter((s) => s.slot === 'faq')).toHaveLength(1)
    // Agente de outra empresa → not_found.
    const other = await world()
    await expect(svc.list(other.companyId, w.agentId)).rejects.toMatchObject({ code: 'not_found' })
  })

  it('AC-T52-03: site interno bloqueado (ssrf_blocked), fora do ar → failed site_unreachable; site OK lê as páginas do mesmo host', async () => {
    const w = await world()
    const svc = service()
    const internal = await svc.create(w.companyId, w.agentId, { kind: 'site', url: `http://127.0.0.1:${sitePort}/` })
    expect(await svc.process(internal.id)).toMatchObject({ status: 'failed', error_message: 'site_unreachable', error_detail: 'ssrf_blocked' })
    await svc.remove(w.companyId, w.agentId, internal.id)

    const down = await svc.create(w.companyId, w.agentId, { kind: 'site', url: `http://down.test:${closedPort}/` })
    expect(await svc.process(down.id)).toMatchObject({ status: 'failed', error_message: 'site_unreachable', error_detail: 'network_error' })
    await svc.remove(w.companyId, w.agentId, down.id)

    const ok = await svc.create(w.companyId, w.agentId, { kind: 'site', url: `http://site.test:${sitePort}/` })
    expect(await svc.process(ok.id)).toMatchObject({ status: 'ready', pages_count: 2, title: 'Pizzaria Bella' })
    await svc.remove(w.companyId, w.agentId, ok.id)

    const notFound = await svc.create(w.companyId, w.agentId, { kind: 'site', url: `http://site.test:${sitePort}/nao-existe` })
    expect(await svc.process(notFound.id)).toMatchObject({ status: 'failed', error_message: 'site_unreachable', error_detail: 'http_404' })
    await svc.remove(w.companyId, w.agentId, notFound.id)

    const empty = await svc.create(w.companyId, w.agentId, { kind: 'site', url: `http://site.test:${sitePort}/vazio` })
    expect(await svc.process(empty.id)).toMatchObject({ status: 'failed', error_message: 'empty_site' })
  })

  it('AC-T52-04: search devolve os trechos mais relevantes; reindex volta a pending e publica o evento; fluxo vira conhecimento', async () => {
    const w = await world()
    const svc = service()
    const faq = await svc.create(w.companyId, w.agentId, {
      kind: 'faq',
      items: [
        { q: 'Qual o prazo de entrega?', a: 'A entrega leva de 3 a 5 dias úteis.' },
        { q: 'Como funciona a garantia?', a: 'A garantia cobre defeitos por 12 meses.' },
        { q: 'Quais formas de pagamento?', a: 'Pix, boleto e cartão de crédito.' },
      ],
    })
    await svc.process(faq.id)
    const flowStore = new FlowStore(db)
    const flow = await flowStore.createFlow({ companyId: w.companyId }, { name: 'Boas-vindas' })
    await flowStore.fromDefinition({ companyId: w.companyId }, flow.id, {
      schema: 'crm.flow/v1',
      entry: 'start',
      nodes: [
        { id: 'start', type: 'start', name: 'start', position: { x: 0, y: 0 }, actions: [] },
        { id: 'm', type: 'message', name: 'Saudação', position: { x: 0, y: 0 }, actions: [{ id: 'a', type: 'send_message', order: 0, config: { message_type: 'text', text: 'Nosso horário de atendimento é das 9h às 18h.' } }] },
      ],
      edges: [{ id: 'e', from: 'start', handle: 'source', to: 'm' }],
      variables: [],
      refs: {},
    })
    const fromFlow = await svc.create(w.companyId, w.agentId, { kind: 'flow', flow_id: flow.id })
    expect(fromFlow.title).toBe('Boas-vindas')
    expect(await svc.process(fromFlow.id)).toMatchObject({ status: 'ready' })

    const hits = await svc.search({ companyId: w.companyId, agentId: w.agentId, query: 'qual é a garantia do produto?' })
    expect(hits[0]).toMatchObject({ source_id: faq.id, kind: 'faq', content: expect.stringContaining('12 meses') })
    expect((await svc.search({ companyId: w.companyId, agentId: w.agentId, query: 'horário de atendimento' }))[0]).toMatchObject({ source_id: fromFlow.id })
    expect(await svc.search({ companyId: w.companyId, agentId: w.agentId, query: '?!' })).toEqual([])
    const other = await world()
    expect(await svc.search({ companyId: other.companyId, agentId: w.agentId, query: 'garantia' })).toEqual([])
    expect(await svc.asKnowledgeSearch().search({ companyId: w.companyId, agentId: w.agentId, query: 'pagamento pix' })).toEqual([expect.stringContaining('Pix, boleto')])

    events.length = 0
    jobs.length = 0
    const re = await svc.reindex(w.companyId, w.agentId, faq.id)
    expect(re.status).toBe('pending')
    expect(jobs).toEqual([{ companyId: w.companyId, sourceId: faq.id }])
    expect(events).toEqual([{ type: 'ai_knowledge_source.updated', data: expect.objectContaining({ agent_id: w.agentId, source_id: faq.id, status: 'pending' }) }])
    // Fonte pending não aparece na busca até ficar pronta de novo.
    expect((await svc.search({ companyId: w.companyId, agentId: w.agentId, query: 'garantia' })).some((h) => h.source_id === faq.id)).toBe(false)
    await svc.process(faq.id)
    expect(events.at(-1)).toMatchObject({ data: { status: 'ready', source: expect.objectContaining({ questions_count: 3 }) } })

    await svc.remove(w.companyId, w.agentId, faq.id)
    expect(events.at(-1)).toMatchObject({ data: { source_id: faq.id, status: 'deleted' } })
    expect(await svc.process(faq.id)).toBeNull()
  })
})
