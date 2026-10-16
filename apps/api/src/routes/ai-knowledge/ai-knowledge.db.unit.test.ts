/* eslint-disable @typescript-eslint/no-explicit-any -- respostas JSON lidas como dados soltos */
// Base de conhecimento pela API (AC-T52-01..04): multipart de PDF, 413, 409 LIMIT_REACHED, site interno bloqueado,
// reindex com evento, isolamento entre empresas e permissões.
import { AiKnowledgeService, type AiKnowledgeJobData } from '@crm/core'
import { buildPdf } from '@crm/core/ai-knowledge-testing'
import { companyMembers, createDb, users, type Database } from '@crm/db'
import { createTempDatabase, type TempDatabase } from '@crm/db/testing'
import { createLogger, MemoryMailer, redisConnection } from '@crm/node-kit'
import { randomBytes } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp, type RedisClient } from '../../app'

let temp: TempDatabase
let db: Database
let redis: RedisClient
let app: ReturnType<typeof createApp>
const H = { 'x-requested-with': 'crm' }
const JSON_H = { ...H, 'content-type': 'application/json' }
const jobs: AiKnowledgeJobData[] = []
const events: { type: string; data: any }[] = []
const rnd = () => randomBytes(4).toString('hex')

interface Session {
  cookie: string
  companyId: string
  userId: string
}
async function signUp(): Promise<Session> {
  const email = `t52-${rnd()}@x.com`
  const ip = { 'x-forwarded-for': `10.52.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` }
  const reg = await app.request('/api/auth/register', { method: 'POST', headers: { ...JSON_H, ...ip }, body: JSON.stringify({ name: 'T', email, password: '12345678', password_confirmation: '12345678' }) })
  const { user } = (await reg.json()) as any
  const login = await app.request('/api/auth/login', { method: 'POST', headers: { ...JSON_H, ...ip }, body: JSON.stringify({ email, password: '12345678' }) })
  return { cookie: /crm_session=[^;]+/.exec(login.headers.get('set-cookie') ?? '')![0], companyId: user.last_company_id, userId: user.id }
}
const call = async (s: Session, method: string, path: string, body?: unknown) => {
  const res = await app.request(path, { method, headers: { ...JSON_H, cookie: s.cookie }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) })
  const text = await res.text()
  return { status: res.status, body: text ? (JSON.parse(text) as any) : {} }
}
const upload = async (s: Session, path: string, fields: Record<string, string | Blob>, filename = 'arquivo.pdf') => {
  const form = new FormData()
  for (const [k, v] of Object.entries(fields)) {
    if (typeof v === 'string') form.append(k, v)
    else form.append(k, v, filename)
  }
  const res = await app.request(path, { method: 'POST', headers: { ...H, cookie: s.cookie }, body: form })
  const text = await res.text()
  return { status: res.status, body: text ? (JSON.parse(text) as any) : {} }
}
const pdfBlob = (pages: string[]) => new Blob([new Uint8Array(buildPdf(pages))], { type: 'application/pdf' })
const ingest = (sourceId: string) => new AiKnowledgeService({ db }).process(sourceId)

async function agentOf(s: Session): Promise<string> {
  const r = await call(s, 'POST', '/api/ai-agents', { name: 'Atendente' })
  expect(r.status).toBe(201)
  return r.body.agent.id
}

beforeAll(async () => {
  temp = await createTempDatabase({ migrate: true })
  db = createDb(temp.url, { max: 6 })
  redis = redisConnection({ url: process.env.REDIS_URL ?? 'redis://127.0.0.1:6379/1' })
  app = createApp({
    db,
    redis,
    mailer: new MemoryMailer(),
    trustProxy: true,
    logger: createLogger({ level: 'silent' }),
    aiProviderKeys: { isConfigured: () => true } as never,
    aiKnowledgeEnqueue: async (d) => void jobs.push(d),
    realtimePublisher: { publish: async (_c: string, type: string, data: unknown) => (events.push({ type, data }), '1-0') } as never,
  })
}, 120_000)

afterAll(async () => {
  await db?.$client.end()
  redis?.disconnect()
  await temp?.drop()
})

describe('/api/ai-agents/:id/knowledge-sources', () => {
  it('AC-T52-01/02: PDF multipart termina ready com pages_count; texto e FAQ em JSON; 3º PDF → 409; > 8 MB → 413', async () => {
    const s = await signUp()
    const agent = await agentOf(s)
    const base = `/api/ai-agents/${agent}/knowledge-sources`
    const pdf = await upload(s, base, { kind: 'pdf', file: pdfBlob(['Cardápio do dia', 'Promoções da semana']) }, 'cardapio.pdf')
    expect(pdf.status).toBe(201)
    expect(pdf.body.source).toMatchObject({ kind: 'pdf', slot: 'pdf', status: 'pending', filename: 'cardapio.pdf' })
    expect(jobs.at(-1)).toEqual({ companyId: s.companyId, sourceId: pdf.body.source.id })
    await ingest(pdf.body.source.id)
    expect((await call(s, 'GET', `${base}/${pdf.body.source.id}`)).body.source).toMatchObject({ status: 'ready', pages_count: 2 })

    const text = await call(s, 'POST', base, { kind: 'text', title: 'Regras', body: 'Não trabalhamos aos feriados.' })
    expect(text.status).toBe(201)
    expect((await ingest(text.body.source.id))!.status).toBe('ready')
    const faq = await call(s, 'POST', base, { kind: 'faq', items: [{ q: 'Tem estacionamento?', a: 'Sim, gratuito.' }] })
    expect((await ingest(faq.body.source.id))!.questions_count).toBe(1)

    expect((await upload(s, base, { kind: 'file', file: pdfBlob(['segundo']) }, 'outro.pdf')).status).toBe(201)
    const third = await upload(s, base, { kind: 'pdf', file: pdfBlob(['terceiro']) }, 'mais.pdf')
    expect(third.status).toBe(409)
    expect(third.body.error).toMatchObject({ code: 'LIMIT_REACHED', details: expect.objectContaining({ error_code: 'pdf_limit' }) })

    const big = await upload(s, base, { kind: 'text', file: new Blob([new Uint8Array(8 * 1024 * 1024 + 10)], { type: 'text/plain' }) }, 'grande.txt')
    expect(big.status).toBe(413)
    expect(big.body.error.code).toBe('PAYLOAD_TOO_LARGE')

    const list = await call(s, 'GET', base)
    expect(list.body.items.map((i: any) => i.slot).sort()).toEqual(['faq', 'pdf', 'pdf', 'text'])
  })

  it('validação 422 com error_code; site interno → failed site_unreachable (ssrf_blocked)', async () => {
    const s = await signUp()
    const agent = await agentOf(s)
    const base = `/api/ai-agents/${agent}/knowledge-sources`
    const noBody = await call(s, 'POST', base, { kind: 'text', body: '' })
    expect(noBody.status).toBe(422)
    expect(noBody.body.error.details.error_code).toBe('text_required')
    expect((await call(s, 'POST', base, { kind: 'nope' })).body.error.details.error_code).toBe('unsupported_kind')
    expect((await upload(s, base, { kind: 'pdf', file: new Blob(['oi'], { type: 'application/pdf' }) })).body.error.details.error_code).toBe('not_pdf')

    const internal = await call(s, 'POST', base, { kind: 'site', url: 'http://127.0.0.1:9/' })
    expect(internal.status).toBe(201)
    expect(await ingest(internal.body.source.id)).toMatchObject({ status: 'failed', error_message: 'site_unreachable', error_detail: 'ssrf_blocked' })
  })

  it('AC-T52-04: reindex volta a pending, enfileira e publica o evento; DELETE remove; outra empresa → 404; sem flows.edit → 403', async () => {
    const s = await signUp()
    const agent = await agentOf(s)
    const base = `/api/ai-agents/${agent}/knowledge-sources`
    const src = (await call(s, 'POST', base, { kind: 'text', body: 'Horário: 8h às 17h.' })).body.source
    await ingest(src.id)
    events.length = 0
    jobs.length = 0
    const re = await call(s, 'POST', `${base}/${src.id}/reindex`)
    expect(re.status).toBe(200)
    expect(re.body.source.status).toBe('pending')
    expect(jobs).toEqual([{ companyId: s.companyId, sourceId: src.id }])
    expect(events).toEqual([{ type: 'ai_knowledge_source.updated', data: expect.objectContaining({ agent_id: agent, source_id: src.id, status: 'pending' }) }])

    const other = await signUp()
    expect((await call(other, 'GET', base)).status).toBe(404)
    expect((await call(other, 'DELETE', `${base}/${src.id}`)).status).toBe(404)

    const m = await signUp()
    await db.insert(companyMembers).values({ companyId: s.companyId, userId: m.userId, role: 'member', permissionKeys: ['flows.view'] })
    await db.update(users).set({ lastCompanyId: s.companyId }).where(eq(users.id, m.userId))
    const member = { ...m, companyId: s.companyId }
    expect((await call(member, 'GET', base)).status).toBe(200)
    expect((await call(member, 'POST', base, { kind: 'text', body: 'x' })).status).toBe(403)
    expect((await call(member, 'POST', `${base}/${src.id}/reindex`)).status).toBe(403)

    expect((await call(s, 'DELETE', `${base}/${src.id}`)).status).toBe(204)
    expect((await call(s, 'GET', `${base}/${src.id}`)).status).toBe(404)
  })
})
