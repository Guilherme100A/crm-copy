// AC-T127-01..07 com o sistema montado como produção (worker de startProductionWorker + API de createProductionApiDeps;
// ver setup.ts). Cada cenário entra pelas portas públicas (HTTP, wa-worker fake) e é observado pelos fakes e pelo banco.
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import {
  action,
  activeFlow,
  aiKey,
  chatOf,
  edge,
  keyword,
  llmCallsOf,
  localPhone,
  MODEL,
  node,
  phone,
  postPublic,
  receive,
  requestText,
  textOf,
  salesPixel,
  say,
  sentTexts,
  sleep,
  startSystem,
  tag,
  tenant,
  waitFor,
  wallet,
  XPAG_CLIENT_ID,
  XPAG_CLIENT_SECRET,
  type System,
  type Tenant,
} from './setup'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

let sys: System
let llmText: (text: string, extra?: Any) => Any

beforeAll(async () => {
  sys = await startSystem()
  llmText = ((await import('@crm/ai/testing')) as Any).text
}, 300_000)

afterAll(async () => {
  await sys?.close()
}, 120_000)

// O FakeLlm do processo é um só: passos de roteiro não consumidos por um teste não podem vazar para o próximo.
// Consome as sobras com chamadas de um tenant fictício (fora dos filtros por empresa dos testes).
afterEach(async () => {
  for (let i = 0; sys?.llm && sys.llm.remaining > 0 && i < 20; i++)
    await sys.llm.generate({ model: { provider: 'openai', model: 'drain' }, instructions: '', messages: [], tenantId: 'drain' }).catch(() => {})
})

/** Número da conexão do tenant (preenchido se o transporte fake não informou). */
async function connectionPhone(t: Tenant): Promise<string> {
  const [row] = await sys.q(`SELECT phone_number FROM crm.connections WHERE id = $1`, [t.connectionId])
  if (row?.phone_number) return String(row.phone_number)
  const number = `55${localPhone()}`
  await sys.q(`UPDATE crm.connections SET phone_number = $2 WHERE id = $1`, [t.connectionId, number])
  return number
}

// ---------------------------------------------------------------- AC-T127-01 webhooks de entrada

describe('T127 — webhook de entrada pelo worker montado', () => {
  it('AC-T127-01 POST na URL pública com fluxo vinculado: o worker processa (processed_at) e inicia o fluxo para o contato do mapeamento', async () => {
    const t = await tenant(sys)
    const text = `Bem-vinda do webhook ${tag()}`
    const flowId = await activeFlow(t, [say('M', text)], [edge('start', 'source', 'M')])
    const connPhone = await connectionPhone(t)
    const wh = await t.c.post('/api/inbound-webhooks', { name: `Webhook ${tag()}` })
    expect(wh.status, wh.text).toBe(201)
    const webhook = wh.body.webhook
    const cfg = await t.c.patch(`/api/inbound-webhooks/${webhook.id}`, {
      config: {
        field_paths: {
          full_name: [{ kind: 'path', value: 'cliente.nome' }],
          phone: [{ kind: 'literal', value: '+55' }, { kind: 'path', value: 'cliente.fone' }],
        },
        trigger_flow: true,
        flow_id: flowId,
        connection_value: connPhone,
      },
    })
    expect(cfg.status, cfg.text).toBe(200)

    const fone = localPhone()
    const res = await postPublic(sys, `/api/hooks/in/${webhook.public_token}`, JSON.stringify({ cliente: { nome: 'Paula Webhook', fone } }))
    expect(res.status, res.text).toBe(202)
    const requestId = res.body.request_id

    const row = await waitFor(
      async () => {
        const [r] = await sys.q(`SELECT processing_status, processed_at, error, steps FROM crm.inbound_webhook_requests WHERE id = $1`, [requestId])
        return r && r.processing_status !== 'pending' ? r : undefined
      },
      60_000,
      'request processado pelo worker',
    )
    expect(row.processing_status, JSON.stringify(row)).toBe('processed')
    expect(row.processed_at).not.toBeNull()

    const [contact] = await sys.q(`SELECT id, name FROM crm.contacts WHERE company_id = $1 AND phone_e164 = $2`, [t.companyId, `+55${fone}`])
    expect(contact, 'contato do mapeamento').toBeTruthy()
    expect(contact.name).toBe('Paula Webhook')
    const runs = await sys.q(`SELECT flow_id, trigger FROM crm.flow_runs WHERE contact_id = $1`, [contact.id])
    expect(runs, JSON.stringify(row.steps)).toHaveLength(1)
    expect(runs[0].flow_id).toBe(flowId)
    expect(runs[0].trigger).toMatchObject({ type: 'inbound_webhook', webhook_id: webhook.id, request_id: requestId })
    // o fluxo andou no worker: o nó de mensagem enviou pelo wa-worker
    await waitFor(async () => (await sentTexts(sys, t)).includes(text), 45_000, 'mensagem do fluxo enviada').catch(async (e) => {
      const st = await sys.q(`SELECT r.status, r.error, r.current_node_key, ch.connection_id FROM crm.flow_runs r LEFT JOIN crm.chats ch ON ch.id = r.chat_id WHERE r.contact_id = $1`, [contact.id])
      throw new Error(`${(e as Error).message}
run: ${JSON.stringify(st)}; enviados: ${JSON.stringify(await sentTexts(sys, t))}`)
    })
  })

  it('AC-T127-01 o agendador da varredura de pendentes fica registrado na fila inbound-webhooks', async () => {
    const core: Any = await import('@crm/core')
    const queue = core.defineQueue(core.INBOUND_WEBHOOKS_QUEUE)
    try {
      const schedulers: Any[] = await waitFor(
        async () => {
          const list = await queue.getJobSchedulers()
          return list.some((s: Any) => (s.key ?? s.id) === 'inbound-webhooks-sweep' || s.name === 'inbound-webhooks-sweep') ? list : undefined
        },
        20_000,
        'scheduler inbound-webhooks-sweep',
      )
      const sweep = schedulers.find((s: Any) => (s.key ?? s.id) === 'inbound-webhooks-sweep' || s.name === 'inbound-webhooks-sweep')
      expect(Number(sweep.every)).toBe(60_000)
    } finally {
      await queue.close()
    }
  })
})

// ---------------------------------------------------------------- AC-T127-02 fontes de venda → Purchase

const MAPPING = {
  external_id: '$.pedido.id',
  status: '$.pedido.situacao',
  amount: '$.pedido.valor',
  currency: '$.pedido.moeda',
  phone: '$.cliente.telefone',
  name: '$.cliente.nome',
}
const order = (id: string, situacao: string, telefone: string) => ({ pedido: { id, situacao, valor: '149.90', moeda: 'BRL' }, cliente: { nome: 'Rita Compradora', telefone } })

async function saleSource(t: Tenant) {
  const r = await t.c.post('/api/sale-sources', { name: `Checkout ${tag()}`, mapping: MAPPING })
  expect(r.status, r.text).toBe(201)
  return r.body.sale_source
}

async function sendSale(src: Any, payload: unknown) {
  const res = await postPublic(sys, `/api/hooks/sales/${src.token}`, JSON.stringify(payload))
  expect(res.status, res.text).toBe(202)
  const ev = await waitFor(
    async () => {
      const [r] = await sys.q(`SELECT status, error FROM crm.inbound_sale_events WHERE id = $1`, [res.body.event_id])
      return r && r.status !== 'pending' ? r : undefined
    },
    60_000,
    'evento da fonte de venda processado pelo worker',
  )
  expect(ev.status, JSON.stringify(ev)).toBe('processed')
}

describe('T127 — fontes de venda pelo worker montado', () => {
  it('AC-T127-02 evento aprovado cria a venda e gera exatamente 1 Purchase no pixel com auto_send_sales', async () => {
    const t = await tenant(sys)
    const px = await salesPixel(sys, t)
    const src = await saleSource(t)
    const id = `PED-${tag()}`
    await sendSale(src, order(id, 'paid', localPhone()))
    const sales = await sys.q(`SELECT id, status, amount_cents FROM crm.sales WHERE company_id = $1 AND external_id = $2`, [t.companyId, id])
    expect(sales).toHaveLength(1)
    expect(sales[0].status).toBe('approved')
    const ev = await waitFor(() => sys.fakeMeta.capiEventsFor(px.pixelId)[0], 45_000, 'Purchase no FakeMetaGraph')
    expect(ev.event.event_name).toBe('Purchase')
    expect(ev.event.event_id).toBe(`sale-${sales[0].id}`)
    expect(Number(ev.event.custom_data.value)).toBeCloseTo(149.9, 2)
    await sleep(3000)
    expect(sys.fakeMeta.capiEventsFor(px.pixelId), 'mais de um Purchase para a mesma venda').toHaveLength(1)
  })

  it('AC-T127-02 venda que nasce pending não gera Purchase; a mesma venda passando a approved gera exatamente 1', async () => {
    const t = await tenant(sys)
    const px = await salesPixel(sys, t)
    const src = await saleSource(t)
    const id = `PED-${tag()}`
    const tel = localPhone()
    await sendSale(src, order(id, 'pending', tel))
    const [pending] = await sys.q(`SELECT id, status FROM crm.sales WHERE company_id = $1 AND external_id = $2`, [t.companyId, id])
    expect(pending?.status).toBe('pending')
    await sleep(4000)
    expect(sys.fakeMeta.capiEventsFor(px.pixelId), 'Purchase de venda pending').toHaveLength(0)

    await sendSale(src, order(id, 'paid', tel))
    const sales = await sys.q(`SELECT id, status FROM crm.sales WHERE company_id = $1 AND external_id = $2`, [t.companyId, id])
    expect(sales).toHaveLength(1)
    expect(sales[0]).toMatchObject({ id: pending.id, status: 'approved' })
    const ev = await waitFor(() => sys.fakeMeta.capiEventsFor(px.pixelId)[0], 45_000, 'Purchase após approved')
    expect(ev.event.event_id).toBe(`sale-${pending.id}`)
    // repetir o approved não gera outro
    await sendSale(src, order(id, 'paid', tel))
    await sleep(4000)
    expect(sys.fakeMeta.capiEventsFor(px.pixelId), 'mais de um Purchase para a mesma venda').toHaveLength(1)
  })
})

// ---------------------------------------------------------------- AC-T127-03 pagamento

describe('T127 — bloco Pagamento pelo worker montado', () => {
  it('AC-T127-03 o webhook de confirmação do gateway (FakeXPag) retoma o run aguardando pela saída paymentApproved', async () => {
    const t = await tenant(sys)
    const integ = await t.c.post('/api/payment-integrations', { label: `XPag ${tag()}`, gateway: 'xpag', client_id: XPAG_CLIENT_ID, client_secret: XPAG_CLIENT_SECRET })
    expect(integ.status, integ.text).toBe(201)
    const integrationId = integ.body.integration.id
    const config = { gateway: 'xpag', payment_integration_id: integrationId, currency: 'BRL', method: 'PIX', amount: 50, listener_ttl_value: 1, listener_ttl_unit: 'hours' }
    const paidText = `Pagamento confirmado ${tag()}`
    const flowId = await activeFlow(
      t,
      [node('P', 'payment', [action('P-a', 'create_payment_charge', config)]), say('A', `${paidText} {gateway.value}`), say('E', 'erro {gateway.error}')],
      [edge('start', 'source', 'P'), edge('P', 'output:payment_approved', 'A'), edge('P', 'failure', 'E')],
    )
    await keyword(t, flowId, 'pagar')

    const before = sys.xpag.cashins.length
    const from = phone()
    await receive(sys, t, from, 'pagar')
    const chatId = await chatOf(sys, t, from)
    const run = await waitFor(
      async () => {
        const [r] = await sys.q(`SELECT id, status, wait, current_node_key FROM crm.flow_runs WHERE chat_id = $1 AND flow_id = $2`, [chatId, flowId])
        return r && r.status === 'waiting' ? r : undefined
      },
      45_000,
      'run aguardando o pagamento',
    )
    expect(run.current_node_key).toBe('P')
    expect(run.wait?.kind).toBe('payment')
    expect(sys.xpag.cashins.length, 'o nó deveria criar 1 cobrança no FakeXPag').toBe(before + 1)
    const tx = sys.xpag.cashins.at(-1).transaction_id as string
    expect(run.wait.transaction_id).toBe(tx)

    const hook = sys.xpag.webhookFor(tx, { status: 'confirmed' })
    const u = new URL(hook.url)
    const res = await sys.app.request(u.pathname + u.search, { method: 'POST', headers: hook.headers, body: hook.rawBody })
    expect(res.status, await res.text()).toBe(202)

    await waitFor(async () => (await sentTexts(sys, t)).includes(`${paidText} 50.00`), 45_000, 'saída payment_approved no wa-worker')
    await waitFor(
      async () => (await sys.q(`SELECT status FROM crm.flow_runs WHERE id = $1`, [run.id]))[0]?.status === 'completed',
      20_000,
      'run completed',
    )
    const [charge] = await sys.q(`SELECT status FROM crm.payment_charges WHERE flow_run_id = $1`, [run.id])
    expect(charge.status).toBe('approved')
    expect((await sentTexts(sys, t)).some((s) => s.startsWith('erro '))).toBe(false)
  })
})

// ---------------------------------------------------------------- AC-T127-04 nó de IA

/** start → A (ai) ─success→ S ("IA: {ai.response}") / ─failure→ F ("falhou: {ai.fail.reason}"), gatilho 'ia'. */
async function aiFlow(t: Tenant, config: Record<string, unknown>) {
  const flowId = await activeFlow(
    t,
    [node('A', 'ai', [action('A-a', 'ai_call', { provider: 'gpt', model: MODEL, user_message: 'resuma o pedido do cliente', ...config })]), say('S', 'IA: {ai.response}'), say('F', 'falhou: {ai.fail.reason}')],
    [edge('start', 'source', 'A'), edge('A', 'success', 'S'), edge('A', 'failure', 'F')],
  )
  await keyword(t, flowId, 'ia')
  return flowId
}

const flowAiUsage = (companyId: string) => sys.q(`SELECT provider, model, status FROM crm.ai_usage WHERE company_id = $1 AND feature = 'flow_ai'`, [companyId])

describe('T127 — nó de IA pelo worker montado', () => {
  it("AC-T127-04 o nó de IA chama o LLM do processo e grava 1 linha em ai_usage com feature 'flow_ai'", async () => {
    expect(sys.llm, 'worker montado sem FakeLlm (AI_MODE=fake)').toBeTruthy()
    const t = await tenant(sys)
    await aiKey(t, 'openai')
    await wallet(sys, t.companyId, 1_000_000_000)
    await aiFlow(t, {})
    const answer = `Resumo da IA ${tag()}`
    sys.llm.enqueue(llmText(answer, { usage: { inputTokens: 1200, outputTokens: 300 } }))
    await receive(sys, t, phone(), 'ia')
    await waitFor(async () => (await sentTexts(sys, t)).includes(`IA: ${answer}`), 45_000, 'saída success do nó de IA')
    expect(llmCallsOf(sys, t.companyId)).toHaveLength(1)
    const rows = await waitFor(async () => ((await flowAiUsage(t.companyId)).length ? flowAiUsage(t.companyId) : undefined), 20_000, "ai_usage 'flow_ai'")
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ provider: 'openai', model: MODEL, status: 'charged' })
  })

  it('AC-T127-04 com ai_integration_id o nó usa a chave daquela integração (provedor da chave, sem chave openai na empresa)', async () => {
    const t = await tenant(sys)
    const keyId = await aiKey(t, 'anthropic')
    await wallet(sys, t.companyId, 1_000_000_000)
    await aiFlow(t, { api_key_source: 'integration', ai_integration_id: keyId })
    const answer = `Resposta pela integração ${tag()}`
    sys.llm.enqueue(llmText(answer))
    await receive(sys, t, phone(), 'ia')
    await waitFor(async () => (await sentTexts(sys, t)).some((s) => s.startsWith('IA: ') || s.startsWith('falhou: ')), 45_000, 'saída do nó de IA')
    const sent = await sentTexts(sys, t)
    expect(sent, JSON.stringify(sent)).toContain(`IA: ${answer}`)
    const calls = llmCallsOf(sys, t.companyId)
    expect(calls).toHaveLength(1)
    expect(calls[0].model.provider).toBe('anthropic')
    const keyed: Any[] = sys.prod?.production?.llm?.keyedCalls ?? sys.prod?.llm?.keyedCalls ?? []
    if (keyed.length) expect(keyed.filter((k: Any) => k.companyId === t.companyId)).toEqual([expect.objectContaining({ keyId, provider: 'anthropic' })])
    const rows = await waitFor(async () => ((await flowAiUsage(t.companyId)).length ? flowAiUsage(t.companyId) : undefined), 20_000, "ai_usage 'flow_ai'")
    expect(rows[0]).toMatchObject({ provider: 'anthropic', status: 'charged' })
  })

  it('AC-T127-04 com a cota esgotada o nó segue a saída de falha sem chamar o LLM', async () => {
    const t = await tenant(sys)
    await aiKey(t, 'openai')
    await wallet(sys, t.companyId, 0)
    await aiFlow(t, {})
    const before = sys.llm.callCount
    await receive(sys, t, phone(), 'ia')
    await waitFor(async () => (await sentTexts(sys, t)).includes('falhou: quota_exceeded'), 45_000, 'saída failure com quota_exceeded')
    expect(llmCallsOf(sys, t.companyId), 'LLM chamado com a cota esgotada').toHaveLength(0)
    expect(sys.llm.callCount).toBe(before)
    expect((await flowAiUsage(t.companyId)).filter((r: Any) => r.status === 'charged')).toHaveLength(0)
  })
})

// ---------------------------------------------------------------- AC-T127-05 base de conhecimento

describe('T127 — base de conhecimento pelo worker montado', () => {
  it('AC-T127-05 documento enviado fica pronto pelo job ai-knowledge e o turno do agente recebe o trecho buscado', async () => {
    const t = await tenant(sys)
    await aiKey(t, 'openai')
    await wallet(sys, t.companyId, 1_000_000_000)
    const agent = await t.c.post('/api/ai-agents', {
      name: `Agente ${tag()}`,
      generated_prompt: 'Você é um atendente cordial.',
      model: { provider: 'openai', model: MODEL },
      settings: { buffer_enabled: false, split_messages: false },
      skills: [],
    })
    expect(agent.status, agent.text).toBe(201)
    const agentId = agent.body.agent.id
    const secret = `CODIGO${tag().toUpperCase()}`
    const doc = await t.c.post(`/api/ai-agents/${agentId}/knowledge-sources`, {
      kind: 'text',
      title: 'Garantia',
      body: `A garantia estendida da loja cobre vinte e quatro meses de uso. Protocolo ${secret}.`,
    })
    expect(doc.status, doc.text).toBe(201)
    const sourceId = doc.body.source.id
    const ready = await waitFor(
      async () => {
        const r = await t.c.get(`/api/ai-agents/${agentId}/knowledge-sources/${sourceId}`)
        return r.status === 200 && r.body.source.status !== 'pending' && r.body.source.status !== 'processing' ? r.body.source : undefined
      },
      60_000,
      'fonte processada pelo job ai-knowledge',
    )
    expect(ready.status, JSON.stringify(ready)).toBe('ready')
    expect((await t.c.post(`/api/ai-agents/${agentId}/publish`, {})).status).toBe(200)

    const from = phone()
    await receive(sys, t, from, 'oi')
    const chatId = await chatOf(sys, t, from)
    const link = await t.c.patch(`/api/chats/${chatId}`, { ai_agent_id: agentId })
    expect(link.status, link.text).toBe(200)
    // o agente pode responder antes ao "oi" pendente: roteiro para os dois turnos; vale o turno da pergunta
    const answer = `A garantia é de 24 meses ${tag()}`
    sys.llm.enqueue(llmText(`Olá! ${tag()}`), llmText(answer))
    const question = 'qual a garantia estendida da loja?'
    await receive(sys, t, from, question)
    const turn = await waitFor(
      async () => llmCallsOf(sys, t.companyId).find((c: Any) => (c.messages ?? []).map(textOf).join('\n').includes(question)),
      60_000,
      'turno do agente com a pergunta',
    ).catch((e) => {
      throw new Error(`${(e as Error).message}: ${JSON.stringify(llmCallsOf(sys, t.companyId).map((c: Any) => (c.messages ?? []).map(textOf)))}`)
    })
    expect(requestText(turn), `o turno não recebeu o trecho da base: ${turn.instructions}`).toContain(secret)
  })
})

// ---------------------------------------------------------------- AC-T127-06 lab do agente

describe('T127 — lab do agente pelo worker montado', () => {
  it("AC-T127-06 o job ai-agent-lab usa o LLM do processo (FakeLlm registra a chamada) e mede o consumo pelo UsageGuard (ai_usage 'ai_agent_create')", async () => {
    const t = await tenant(sys)
    await aiKey(t, 'openai')
    await wallet(sys, t.companyId, 1_000_000_000)
    const output = ((await import('@crm/ai/testing')) as Any).output
    const composed = {
      name: `Clara ${tag()}`,
      role: 'Atendente de vendas',
      purpose: 'Vender bolos e doces por encomenda',
      audience: 'Pessoas que querem bolo para festas',
      personality: 'seller',
      primary_goal: 'sell',
      example_messages: 'Oi! Quer ver o cardápio de bolos?',
      business_rules: 'Encomendas com 48 h de antecedência.',
      never_talk_about: 'Concorrentes.',
    }
    sys.llm.enqueue(output(composed, { usage: { inputTokens: 900, outputTokens: 400 } }))
    const pitch = `Doceria Aurora ${tag()}: bolos e doces por encomenda para festas em São Paulo, entrega em toda a capital.`
    const res = await t.c.post('/api/ai-agents/runs', { pitch })
    expect(res.status, res.text).toBe(202)
    const run = await waitFor(
      async () => {
        const r = await t.c.get(`/api/ai-agents/runs/${res.body.run.id}`)
        return r.status === 200 && ['completed', 'failed'].includes(r.body.run.status) ? r.body.run : undefined
      },
      60_000,
      'run da criação assistida processado pelo worker',
    )
    expect(run.status, JSON.stringify(run)).toBe('completed')
    const calls = llmCallsOf(sys, t.companyId)
    expect(calls.length, 'o FakeLlm do processo não registrou a chamada').toBeGreaterThanOrEqual(1)
    expect(calls.map(requestText).join('\n')).toContain('Doceria Aurora')
    const usage = await waitFor(
      async () => {
        const rows = await sys.q(`SELECT status FROM crm.ai_usage WHERE company_id = $1 AND feature = 'ai_agent_create'`, [t.companyId])
        return rows.length ? rows : undefined
      },
      20_000,
      "ai_usage 'ai_agent_create'",
    )
    expect(usage.length).toBeGreaterThanOrEqual(1)
    const agent = await t.c.get(`/api/ai-agents/${run.agent_id}`)
    expect(agent.status, agent.text).toBe(200)
    expect(agent.body.agent.name).toBe(composed.name)
  })
})

// ---------------------------------------------------------------- AC-T127-07 exportação sem processor

describe('T127 — job de exportação sem processor', () => {
  it("AC-T127-07 job de exportação com kind sem processor termina failed com a mensagem do erro em crm.background_jobs", async () => {
    const t = await tenant(sys)
    const kind = `kind_inexistente_${tag()}`
    const [job] = await sys.q(`INSERT INTO crm.background_jobs (company_id, kind, type, status) VALUES ($1, $2, 'export', 'queued') RETURNING id`, [t.companyId, kind])
    const core: Any = await import('@crm/core')
    const queue = core.defineQueue(core.EXPORTS_QUEUE)
    try {
      await queue.add(core.EXPORTS_QUEUE, { jobId: job.id }, { jobId: `t127-${job.id}` })
    } finally {
      await queue.close()
    }
    const row = await waitFor(
      async () => {
        const [r] = await sys.q(`SELECT status, error, finished_at FROM crm.background_jobs WHERE id = $1`, [job.id])
        return r && ['failed', 'completed', 'canceled', 'cancelled'].includes(r.status) ? r : undefined
      },
      30_000,
      'job terminar (failed/completed)',
    )
    expect(row.status).toBe('failed')
    expect(row.error).toContain(`tipo de exportação não registrado: ${kind}`)
  })
})
