// AC-T120-01..05 com o sistema montado como produção (ver setup.ts).
import { randomBytes } from 'node:crypto'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { connectSse, envelopeOf } from '../helpers/sse'
import { chatOf, history, messageFlow, phone, receive, sentTexts, sleep, startSystem, tenant, waitFor, type System, type Tenant } from './setup'

let sys: System

beforeAll(async () => {
  sys = await startSystem()
}, 300_000)

afterAll(async () => {
  await sys?.close()
}, 120_000)

const tag = () => randomBytes(3).toString('hex')

describe('T120 — palavra-chave → fluxo → envio (AC-T120-01)', () => {
  it('AC-T120-01 mensagem que casa a palavra-chave dispara o fluxo; o nó envia 1 vez pelo wa-worker e aparece no chat como sender_type flow', async () => {
    const t = await tenant(sys)
    const text = `Olá! Aqui está o menu ${tag()}`
    const flow = await messageFlow(t, text)
    const cfg = await t.c.put(`/api/connection-flow-configs/${t.connectionId}`, {
      keyword_triggers: [{ flow_id: flow, conditions: [{ keyword: 'menu', match_type: 'equals' }] }],
    })
    expect(cfg.status, cfg.text).toBe(200)

    const from = phone()
    await receive(sys, t, from, 'menu')
    const chatId = await chatOf(sys, t, from)
    await waitFor(async () => (await sentTexts(sys, t)).includes(text), 45_000, 'envio do nó de mensagem no wa-worker')
    const msg = await waitFor(async () => (await history(t, chatId)).find((m: any) => m.body === text || m.text === text), 20_000, 'mensagem no histórico')
    expect(msg.sender_type).toBe('flow')
    await sleep(3000)
    expect((await sentTexts(sys, t)).filter((s) => s === text), 'envio duplicado').toHaveLength(1)
    expect((await history(t, chatId)).filter((m: any) => (m.body ?? m.text) === text), 'mensagem duplicada no histórico').toHaveLength(1)
  })
})

describe('T120 — fora do horário (AC-T120-02)', () => {
  it('AC-T120-02 fora do horário a mensagem automática é enviada e aparece no histórico com sender_type system', async () => {
    const t = await tenant(sys)
    const text = `Estamos fechados agora ${tag()}`
    const put = await t.c.put(`/api/business-hours/${t.connectionId}`, { active: true, action_type: 'message', message_text: text, business_hours: [] })
    expect(put.status, put.text).toBe(200)
    const from = phone()
    await receive(sys, t, from, 'alguém aí?')
    const chatId = await chatOf(sys, t, from)
    await waitFor(async () => (await sentTexts(sys, t)).includes(text), 45_000, 'mensagem fora do horário no wa-worker')
    const msg = await waitFor(async () => (await history(t, chatId)).find((m: any) => (m.body ?? m.text) === text), 20_000, 'mensagem no histórico')
    expect(msg.sender_type).toBe('system')
    expect((await sentTexts(sys, t)).filter((s) => s === text)).toHaveLength(1)
  })
})

describe('T120 — agente de IA com chave BYOK (AC-T120-03)', () => {
  it('AC-T120-03 agente ativo responde com o LLM da empresa e grava 1 linha em ai_usage; carteira esgotada → nenhuma chamada ao LLM', async () => {
    const t = await tenant(sys)
    const key = await t.c.post('/api/ai-keys', { provider: 'openai', name: 'Chave da empresa', secret: `sk-test-${tag()}${tag()}${tag()}` })
    expect(key.status, key.text).toBe(201)
    await sys.q(
      `INSERT INTO crm.ai_wallets (company_id, balance_credits, status) VALUES ($1, 1000000000, 'ok')
       ON CONFLICT (company_id) DO UPDATE SET balance_credits = 1000000000, status = 'ok'`,
      [t.companyId],
    )
    // preço vigente do modelo de teste (o UsageGuard da T24 recusa modelo sem preço), como nas suítes T24/T68
    await sys.q(
      `INSERT INTO crm.llm_prices (provider, model, kind, effective_from, input_per_mtok_micros, output_per_mtok_micros)
       SELECT 'openai', 'gpt-teste-t120', 'llm', '2020-01-01T00:00:00Z', 1000000, 2000000
        WHERE NOT EXISTS (SELECT 1 FROM crm.llm_prices WHERE provider = 'openai' AND model = 'gpt-teste-t120')`,
    )
    const agent = await t.c.post('/api/ai-agents', {
      name: `Agente ${tag()}`,
      generated_prompt: 'Você é um atendente cordial.',
      model: { provider: 'openai', model: 'gpt-teste-t120' },
      settings: { buffer_enabled: false, split_messages: false },
      skills: [],
    })
    expect(agent.status, agent.text).toBe(201)
    const agentId = agent.body.agent.id
    expect((await t.c.post(`/api/ai-agents/${agentId}/publish`, {})).status).toBe(200)

    const from = phone()
    await receive(sys, t, from, 'oi')
    const chatId = await chatOf(sys, t, from)
    const link = await t.c.patch(`/api/chats/${chatId}`, { ai_agent_id: agentId })
    expect(link.status, link.text).toBe(200)

    const { text: llmText } = await import('@crm/ai/testing')
    const answer = `Resposta da IA ${tag()}`
    const fakeLlm = sys.prod.production?.fakeLlm ?? sys.prod.fakeLlm
    expect(fakeLlm, 'worker montado sem FakeLlm (AI_MODE=fake)').toBeTruthy()
    fakeLlm.enqueue(llmText(answer))
    const calls0 = fakeLlm.callCount
    const usage0 = (await sys.q(`SELECT count(*)::int AS n FROM crm.ai_usage WHERE company_id = $1`, [t.companyId]))[0].n

    await receive(sys, t, from, 'quero saber dos cursos')
    await waitFor(async () => (await sentTexts(sys, t)).includes(answer), 60_000, 'resposta do agente no wa-worker').catch(async (e) => {
      const chat = (await sys.q(`SELECT status, ai_agent_id FROM crm.chats WHERE id = $1`, [chatId]))[0]
      const st = (await sys.q(`SELECT * FROM crm.ai_conversation_state WHERE chat_id = $1`, [chatId]).catch(() => []))[0]
      throw new Error(
        `${(e as Error).message}\nLLM: ${fakeLlm.callCount - calls0} chamada(s); chat: ${JSON.stringify(chat)}; ai_conversation_state: ${JSON.stringify(st ?? null)}; enviados: ${JSON.stringify(await sentTexts(sys, t))}`,
      )
    })
    expect(fakeLlm.callCount - calls0).toBe(1)
    await waitFor(async () => (await sys.q(`SELECT count(*)::int AS n FROM crm.ai_usage WHERE company_id = $1`, [t.companyId]))[0].n === usage0 + 1, 20_000, '1 linha em ai_usage')

    // carteira esgotada: o UsageGuard recusa antes do LLM
    await sys.q(`UPDATE crm.ai_wallets SET balance_credits = 0, max_overrun_credits = 0, status = 'exhausted' WHERE company_id = $1`, [t.companyId])
    const calls1 = fakeLlm.callCount
    const usage1 = (await sys.q(`SELECT count(*)::int AS n FROM crm.ai_usage WHERE company_id = $1`, [t.companyId]))[0].n
    await receive(sys, t, from, 'e o preço?')
    await sleep(12_000)
    expect(fakeLlm.callCount, 'LLM chamado com a carteira esgotada').toBe(calls1)
    expect((await sys.q(`SELECT count(*)::int AS n FROM crm.ai_usage WHERE company_id = $1`, [t.companyId]))[0].n).toBe(usage1)
  })
})

describe('T120 — importação e exportação no worker montado (AC-T120-04)', () => {
  it('AC-T120-04 importação CSV termina completed no worker montado', async () => {
    const t = await tenant(sys)
    const p1 = phone()
    const p2 = phone()
    const csv = `nome,telefone\nAna T120,${p1}\nBruno T120,${p2}\n`
    const form = new FormData()
    form.append('file', new Blob([new TextEncoder().encode(csv)], { type: 'text/csv' }), 'contatos.csv')
    form.append('mode', 'upsert')
    const res = await sys.app.request('/api/contacts/imports', {
      method: 'POST',
      headers: { cookie: `crm_session=${t.token}`, 'x-company-id': t.companyId, 'x-requested-with': 'crm' },
      body: form,
    })
    const body: any = await res.json().catch(() => ({}))
    expect(res.status, JSON.stringify(body)).toBe(201)
    const jobId = body.job.id
    const done = await waitFor(async () => {
      const j = (await t.c.get(`/api/jobs/${jobId}`)).body?.job
      return j?.status === 'completed' || j?.status === 'failed' ? j : undefined
    }, 60_000, 'importação completed')
    expect(done.status).toBe('completed')
    const n = (await sys.q(`SELECT count(*)::int AS n FROM crm.contacts WHERE company_id = $1 AND phone_e164 = ANY($2)`, [t.companyId, [p1, p2]]))[0].n
    expect(n).toBe(2)
  })

  it('AC-T120-04 exportação (kind registrado no teste) termina completed com o arquivo no STORAGE_DIR compartilhado e baixável pela API', async () => {
    const t = await tenant(sys)
    const core: any = await import('@crm/core')
    const kind = `t120_export_${tag()}`
    const unregister = core.registerExportKind(kind, {
      permission: 'contacts.view',
      columns: [
        { key: 'id', header: 'ID' },
        { key: 'name', header: 'Nome' },
      ],
      count: async () => 3,
      async *query() {
        for (let i = 1; i <= 3; i++) yield { id: i, name: `Linha ${i} T120` }
      },
    })
    try {
      const before = new Set(listFiles(sys.storageDir))
      const created = await t.c.post('/api/jobs', { kind })
      expect(created.status, created.text).toBe(201)
      const jobId = created.body.job.id
      const done = await waitFor(async () => {
        const j = (await t.c.get(`/api/jobs/${jobId}`)).body?.job
        return j?.status === 'completed' || j?.status === 'failed' ? j : undefined
      }, 60_000, 'exportação completed')
      expect(done.status).toBe('completed')
      const fresh = listFiles(sys.storageDir).filter((f) => !before.has(f))
      expect(fresh.length, 'arquivo da exportação não apareceu no STORAGE_DIR').toBeGreaterThan(0)
      const file = await sys.app.request(`/api/jobs/${jobId}/file`, { headers: { cookie: `crm_session=${t.token}`, 'x-company-id': t.companyId } })
      expect(file.status).toBe(200)
      const content = await file.text()
      expect(content).toContain('Linha 1 T120')
      expect(content).toContain('Linha 3 T120')
    } finally {
      unregister?.()
    }
  })
})

describe('T120 — atendimento finalizado e flow_run.updated (AC-T120-05)', () => {
  it('AC-T120-05 resolver o chat dispara o fluxo de atendimento finalizado; a mudança de estado do run sai como flow_run.updated no SSE', async () => {
    const t = await tenant(sys)
    const text = `Obrigado pelo contato! ${tag()}`
    const flow = await messageFlow(t, text)
    const cfg = await t.c.put(`/api/connection-flow-configs/${t.connectionId}`, { finished_attendance_flow_id: flow })
    expect(cfg.status, cfg.text).toBe(200)
    const from = phone()
    await receive(sys, t, from, 'preciso de ajuda')
    const chatId = await chatOf(sys, t, from)

    const sse = await connectSse((path, init) => sys.app.request(path, init), `/api/events?company_id=${t.companyId}`, { cookie: `crm_session=${t.token}` })
    try {
      const resolved = await t.c.post(`/api/chats/${chatId}/resolve`, {})
      expect(resolved.status, resolved.text).toBeLessThan(300)
      await waitFor(async () => (await sentTexts(sys, t)).includes(text), 45_000, 'mensagem do fluxo de atendimento finalizado')
      const ev = await waitFor(
        () => sse.messages.find((m: any) => m.event === 'flow_run.updated' && envelopeOf(m).company_id === t.companyId),
        30_000,
        'flow_run.updated no SSE',
      )
      expect(envelopeOf(ev).type).toBe('flow_run.updated')
    } finally {
      await sse.close?.()
    }
  })
})

function listFiles(dir: string): string[] {
  if (!existsSync(dir)) return []
  const out: string[] = []
  for (const n of readdirSync(dir)) {
    const p = join(dir, n)
    if (statSync(p).isDirectory()) out.push(...listFiles(p))
    else out.push(p)
  }
  return out
}
