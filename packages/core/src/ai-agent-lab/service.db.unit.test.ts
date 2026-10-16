// Laboratório de agentes (T79) com Postgres e Redis reais, FakeLlm e guard fake (nada sai para a rede).
import { randomBytes } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { LlmQuotaExceededError } from '@crm/ai'
import { FakeLlm, output, text, toolCall } from '@crm/ai/testing'
import { aiAgents, aiKnowledgeSources, companies, createDb, type Database } from '@crm/db'
import { createTempDatabase, type TempDatabase } from '@crm/db/testing'
import { redisConnection } from '@crm/node-kit'
import type { Redis } from 'ioredis'
import { AiAgentsService } from '../ai-agents'
import type { UsageGuard } from '../ai-metering/guard'
import { AgentLabError, AgentLabService, type PublicRun } from './service'

let temp: TempDatabase
let db: Database
let redis: Redis
let site: Server
let siteUrl = ''
const rnd = () => randomBytes(4).toString('hex')
const MODEL = { provider: 'openai' as const, model: 'gpt-test' }
let noBalance = false
const commits: { feature: string; agentId: string | null | undefined }[] = []
const guard = {
  reserve: async (companyId: string) => {
    if (noBalance) throw new LlmQuotaExceededError('sem saldo', { tenantId: companyId, limit: 0, used: 0 })
    return { requestId: 'r', companyId, feature: 'f', agentId: null, estimatedCredits: 1 }
  },
  commit: async (i: { feature: string; agentId?: string | null }) => {
    commits.push({ feature: i.feature, agentId: i.agentId })
    return { usageId: 'u', created: true, credits: 7, wallet: null }
  },
  fail: async () => undefined,
} as unknown as UsageGuard

beforeAll(async () => {
  temp = await createTempDatabase({ migrate: true })
  db = createDb(temp.url, { max: 6 })
  redis = redisConnection({ url: process.env.REDIS_URL ?? 'redis://127.0.0.1:6379/1' })
  site = createServer((req, res) => {
    if (req.url === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end('<html><head><title>Escola Fala</title></head><body><h1>Cursos de inglês</h1><p>Aulas ao vivo, turmas pequenas e parcelamento em 12x.</p></body></html>')
    } else {
      res.writeHead(404)
      res.end()
    }
  })
  await new Promise<void>((r) => site.listen(0, '127.0.0.1', r))
  siteUrl = `http://127.0.0.1:${(site.address() as AddressInfo).port}/`
}, 60_000)

afterAll(async () => {
  await new Promise<void>((r) => site.close(() => r()))
  redis?.disconnect()
  await db?.$client.end()
  await temp?.drop()
})

async function company() {
  const [co] = await db.insert(companies).values({ name: 'C', slug: `c-${rnd()}`, settings: { ai_presets: { balanced: MODEL } } }).returning({ id: companies.id })
  return co!.id
}

async function agent(companyId: string, extra: Record<string, unknown> = {}) {
  const a = await new AiAgentsService({ db }).create(companyId, {
    name: 'Lia',
    purpose: 'Vende cursos',
    skills: [{ action_type: 'transfer_human', when_text: 'cliente pede humano', enabled: true, action_params: {} }],
    ...extra,
  })
  await db.update(aiAgents).set({ model: MODEL }).where(eq(aiAgents.id, a.id))
  return a.id
}

const lab = (llm: FakeLlm, extra: Partial<ConstructorParameters<typeof AgentLabService>[0]> = {}) =>
  new AgentLabService({ db, redis, llm, guard, prefix: `t79:${rnd()}`, siteHttp: { allowHosts: ['127.0.0.1'] }, knowledge: { search: async () => ['Parcelamos em 12x.'] }, ...extra })

const caught = async (p: Promise<unknown>) => p.then(() => null, (e: unknown) => e as AgentLabError)

describe('AC-T79-01 teste ao vivo', () => {
  it('roda o turno sem WhatsApp: blocos, habilidades, campos, trace, créditos; histórico e draft', async () => {
    const co = await company()
    const id = await agent(co)
    const llm = new FakeLlm([toolCall('fill_field', { key: 'nome', value: 'Ana' }), toolCall('transfer_human', { reason: 'pediu' }), text('Oi, Ana!\n\nVou chamar alguém do time.')])
    const s = lab(llm)
    const r = await s.testMessage(co, id, null, { text: 'sou a Ana, quero falar com humano', draft: { use_emojis: false, settings: { split_messages: true } } })
    expect(r.blocks.map((b) => b.text)).toEqual(['Oi, Ana!', 'Vou chamar alguém do time.'])
    expect(r.skills_fired.map((f) => [f.tool, f.action_type])).toEqual([
      ['fill_field', 'fill_field'],
      ['transfer_human', 'transfer_human'],
    ])
    expect(r.fields_filled).toEqual({ nome: 'Ana' })
    expect(r.handoff).toEqual({ reason: 'transfer_human' })
    expect(r.trace).toMatchObject({ model: MODEL, knowledge_hits: ['Parcelamos em 12x.'], finish: 'stop', steps: 3 })
    expect(r.trace.instructions).toContain('Não use emojis.')
    expect(r.trace.instructions).toContain('Base de conhecimento')
    expect(r.charged_credits).toBe(7)
    expect(r.charged_tokens).toBeGreaterThan(0)
    expect(commits.at(-1)).toEqual({ feature: 'ai_agent_test', agentId: id })
    // o draft não salvou nada; a 2ª mensagem leva o histórico e o coletado
    expect((await new AiAgentsService({ db }).get(co, id)).use_emojis).toBe(true)
    llm.enqueue(text('Certo.'))
    const r2 = await s.testMessage(co, id, null, { text: 'ok' })
    expect(r2.collected).toEqual({ nome: 'Ana' })
    expect(llm.calls.at(-1)!.messages).toHaveLength(3)
    expect(llm.calls.at(-1)!.instructions).toContain('nome (Nome) = já coletado')
    await s.resetTest(co, id, null)
    llm.enqueue(text('Oi.'))
    await s.testMessage(co, id, null, { text: 'de novo' })
    expect(llm.calls.at(-1)!.messages).toHaveLength(1)
  })

  it('validação, agente de outra empresa, sem modelo e sem saldo', async () => {
    const co = await company()
    const id = await agent(co)
    const s = lab(new FakeLlm([]))
    expect((await caught(s.testMessage(co, id, null, { text: '' })))!.code).toBe('validation')
    expect((await caught(s.testMessage(co, id, null, { text: 'x', draft: { personality: 'rude' } })))!.details.fields).toEqual([expect.objectContaining({ path: 'draft.personality' })])
    expect((await caught(s.testMessage(await company(), id, null, { text: 'x' })))!.code).toBe('not_found')
    await db.update(aiAgents).set({ model: null }).where(eq(aiAgents.id, id))
    await db.update(companies).set({ settings: {} }).where(eq(companies.id, co))
    expect((await caught(s.testMessage(co, id, null, { text: 'x' })))!.code).toBe('not_configured')
    await db.update(aiAgents).set({ model: MODEL }).where(eq(aiAgents.id, id))
    noBalance = true
    try {
      expect((await caught(s.testMessage(co, id, null, { text: 'x' })))!.code).toBe('no_balance')
    } finally {
      noBalance = false
    }
    expect((await s.evalUsage(co)).used).toBe(0)
  })
})

describe('AC-T79-02 eval_cap', () => {
  it('limite diário por empresa → eval_cap sem chamar o LLM', async () => {
    const co = await company()
    const id = await agent(co)
    const llm = new FakeLlm([text('a'), text('b')])
    const s = lab(llm, { evalCap: 2 })
    await s.testMessage(co, id, null, { text: '1' })
    await s.testMessage(co, id, 'outro-usuario', { text: '2' })
    const err = await caught(s.testMessage(co, id, null, { text: '3' }))
    expect(err!.code).toBe('eval_cap')
    expect(err!.details).toMatchObject({ limit: 2, used: 2 })
    expect(llm.callCount).toBe(2)
    expect(await s.evalUsage(co)).toEqual({ used: 2, limit: 2 })
  })
})

describe('AC-T79-03 generate-prompt', () => {
  it('salva o prompt dos campos, preserva bloco travado e zera prompt_edited', async () => {
    const co = await company()
    const id = await agent(co, { business_rules: 'Parcelamos em 12x.', prompt_edited: true, generated_prompt: 'editado à mão' })
    const lockedText = 'Nunca peça senha.\n'
    await db.update(aiAgents).set({ lockedBlocks: [{ key: 'safety', title: 'Segurança', text: lockedText }] }).where(eq(aiAgents.id, id))
    const out = await lab(new FakeLlm([])).generatePrompt(co, id)
    expect(out.prompt).toContain('Parcelamos em 12x.')
    expect(out.prompt.endsWith(lockedText)).toBe(true)
    expect(out.blocks.at(-1)).toEqual({ key: 'safety', title: 'Segurança', locked: true, text: lockedText })
    expect(out.agent).toMatchObject({ generated_prompt: out.prompt, last_generated_prompt: out.prompt, prompt_edited: false })
  })
})

describe('AC-T79-04 criação assistida', () => {
  const composed = {
    name: 'Bia',
    role: 'consultora',
    purpose: 'Vende cursos de inglês',
    audience: 'Adultos',
    personality: 'consultative',
    primary_goal: 'sell',
    example_messages: 'Oi!',
    business_rules: 'Parcelamos em 12x.',
    never_talk_about: 'política',
  }

  it('extract → compose → persist com SSE a cada etapa; um run por empresa por vez', async () => {
    const co = await company()
    const events: PublicRun[] = []
    const s = lab(new FakeLlm([output(composed)]), { publisher: { publish: async (_c, _t, d) => void events.push(d.run) } })
    const run = await s.createRun(co, null, { pitch: 'Vendo cursos de inglês para adultos.', site_url: siteUrl })
    expect(run).toMatchObject({ status: 'queued', stage: null })
    const busy = await caught(s.createRun(co, null, { pitch: 'Outro run qualquer aqui' }))
    expect(busy!.code).toBe('create_in_progress')
    expect(busy!.details.run_id).toBe(run.id)
    const done = await s.processRun(run.id)
    expect(done).toMatchObject({ status: 'completed', stage: 'persist', stages_done: ['extract', 'compose', 'persist'], warnings: [], error_message: null })
    expect(events.map((e) => `${e.status}:${e.stage}`)).toEqual(['queued:null', 'running:extract', 'running:compose', 'running:persist', 'completed:persist'])
    const created = await new AiAgentsService({ db }).get(co, done!.agent_id!)
    expect(created).toMatchObject({ name: 'Bia', personality: 'consultative', status: 'draft' })
    expect(created.generated_prompt).toContain('Parcelamos em 12x.')
    const kinds = (await db.select({ kind: aiKnowledgeSources.kind }).from(aiKnowledgeSources).where(eq(aiKnowledgeSources.agentId, created.id))).map((k) => k.kind).sort()
    expect(kinds).toEqual(['site', 'text'])
    expect(commits.at(-1)).toEqual({ feature: 'ai_agent_create', agentId: null })
    // trava liberada
    expect((await s.createRun(co, null, { pitch: 'Mais um run depois do primeiro' })).status).toBe('queued')
  })

  it('avisos site_unread e empty_knowledge; sem saldo → failed no_balance; run de outra empresa → not_found', async () => {
    const co = await company()
    const s = lab(new FakeLlm([output(composed)]))
    const run = await s.createRun(co, null, { site_url: `${siteUrl}nao-existe` })
    const done = await s.processRun(run.id)
    expect(done).toMatchObject({ status: 'completed' })
    expect(done!.warnings.sort()).toEqual(['empty_knowledge', 'site_unread'])
    expect((await caught(s.getRun(await company(), run.id)))!.code).toBe('not_found')

    const co2 = await company()
    noBalance = true
    try {
      const r2 = await s.createRun(co2, null, { pitch: 'Vendo bolos caseiros por encomenda.' })
      expect(await s.processRun(r2.id)).toMatchObject({ status: 'failed', error_message: 'no_balance', agent_id: null })
    } finally {
      noBalance = false
    }
    expect((await caught(s.createRun(co2, null, { pitch: 'curto' })))!.code).toBe('validation')
  })

  it('a trava já não existe no instante em que o status final é publicado (sucesso e falha)', async () => {
    const co = await company()
    const prefix = `t79:${rnd()}`
    const lockKey = `${prefix}:active:${co}`
    const atFinal: { status: string; lock: number; next: string }[] = []
    const ref: { s?: AgentLabService } = {}
    const publisher = {
      publish: async (_c: string, _t: string, d: { run: PublicRun }) => {
        if (d.run.status !== 'completed' && d.run.status !== 'failed') return
        const lock = await redis.exists(lockKey)
        // quem observa o run concluído cria outro na hora: não pode esbarrar na trava
        const next = await ref.s!.createRun(co, null, { pitch: 'Novo run logo depois do anterior' }).then(
          (r) => r.id,
          (e: AgentLabError) => e.code,
        )
        atFinal.push({ status: d.run.status, lock, next })
      },
    }
    const s = (ref.s = lab(new FakeLlm([output(composed)]), { prefix, publisher: publisher as never }))
    const first = await s.createRun(co, null, { pitch: 'Vendo cursos de inglês para adultos.' })
    await s.processRun(first.id)
    expect(atFinal).toHaveLength(1)
    expect(atFinal[0]).toMatchObject({ status: 'completed', lock: 0 })
    expect(atFinal[0]!.next).toMatch(/^[0-9a-f-]{36}$/)

    // o run criado no publish segura a trava; ele falha (sem saldo) e a libera do mesmo jeito
    const second = atFinal[0]!.next
    expect(await redis.get(lockKey)).toBe(second)
    noBalance = true
    try {
      await s.processRun(second)
    } finally {
      noBalance = false
    }
    expect(atFinal[1]).toMatchObject({ status: 'failed', lock: 0 })
  })

  it('a liberação é compare-and-delete: não apaga a trava de outro run', async () => {
    const co = await company()
    const prefix = `t79:${rnd()}`
    const s = lab(new FakeLlm([output(composed)]), { prefix })
    const run = await s.createRun(co, null, { pitch: 'Vendo cursos de inglês para adultos.' })
    await redis.set(`${prefix}:active:${co}`, 'outro-run')
    await s.processRun(run.id)
    expect(await redis.get(`${prefix}:active:${co}`)).toBe('outro-run')
    await redis.del(`${prefix}:active:${co}`)
  })

  it('inline processa sozinho depois do createRun', async () => {
    const co = await company()
    // T126: espera o run terminar pelo evento que o serviço publica a cada gravação (antes: 50 × 20 ms de relógio real,
    // que sob carga acabava com o run ainda `running`). Nenhum processRun manual: o inline roda sozinho.
    let settle!: (status: string) => void
    const finished = new Promise<string>((r) => (settle = r))
    const publisher = {
      publish: async (_co: string, _type: 'ai_agent.run.updated', data: { run: { status: string } }) => {
        if (data.run.status === 'completed' || data.run.status === 'failed') settle(data.run.status)
      },
    }
    const s = lab(new FakeLlm([output(composed)]), { inline: true, publisher })
    const run = await s.createRun(co, null, { pitch: 'Vendo cursos de inglês para adultos.' })
    const timeout = new Promise<string>((_, reject) => setTimeout(() => reject(new Error('timeout: o run inline não terminou em 60 s')), 60_000).unref())
    expect(await Promise.race([finished, timeout])).toBe('completed')
    expect((await s.getRun(co, run.id)).status).toBe('completed')
  }, 90_000)
})
