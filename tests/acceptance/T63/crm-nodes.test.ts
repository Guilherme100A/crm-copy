// AC-T63-01..05: etiquetas, status/departamento do chat, kanban, manipulador, venda aprovada e agente de IA.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { board, chatEvents, chatRow, contactLabels, ofType, runFlow, single, startEnv, world, type Env } from './support'

let env: Env
beforeAll(async () => {
  env = await startEnv()
})
afterAll(async () => {
  await env?.close()
})

const cf = async (contactId: string) => (await env.q(`SELECT custom_fields FROM crm.contacts WHERE id = $1`, [contactId]))[0].custom_fields

describe('AC-T63-01 etiquetas', () => {
  it('AC-T63-01 add_tags cria/atribui por nome (sem caixa), é idempotente e publica contact.updated só quando muda', async () => {
    const w = await world(env)
    await env.q(`INSERT INTO crm.labels (company_id, name, color) VALUES ($1, 'Cliente', 'red')`, [w.companyId])
    const d = single('tags', 'add_tags', { action: 'add', tags: ['cliente', 'Lead Quente'] })
    const first = await runFlow(env, w, d)
    expect(first.status, String(first.error)).toBe('completed')
    expect(await contactLabels(env, w.contactId)).toEqual(['Cliente', 'Lead Quente'])
    const ev = ofType(first, 'contact.updated')
    expect(ev).toHaveLength(1)
    expect(ev[0]!).toMatchObject({ companyId: w.companyId, data: { contact_id: w.contactId } })
    expect((await env.q(`SELECT count(*)::int AS n FROM crm.labels WHERE company_id = $1 AND lower(name) = 'cliente'`, [w.companyId]))[0].n).toBe(1)

    const second = await runFlow(env, w, d)
    expect(second.status).toBe('completed')
    expect(await contactLabels(env, w.contactId)).toEqual(['Cliente', 'Lead Quente'])
    expect(ofType(second, 'contact.updated')).toHaveLength(0)
    expect((await env.q(`SELECT count(*)::int AS n FROM crm.contact_labels WHERE contact_id = $1`, [w.contactId]))[0].n).toBe(2)
  })

  it('AC-T63-01 remove_tags remove por nome, ignora inexistente e é idempotente', async () => {
    const w = await world(env)
    await runFlow(env, w, single('tags', 'add_tags', { tags: ['A', 'B'] }))
    const d = single('tags', 'remove_tags', { action: 'remove', tags: ['a', 'Inexistente'] })
    const r1 = await runFlow(env, w, d)
    expect(r1.status, String(r1.error)).toBe('completed')
    expect(await contactLabels(env, w.contactId)).toEqual(['B'])
    expect(ofType(r1, 'contact.updated')).toHaveLength(1)
    const r2 = await runFlow(env, w, d)
    expect(r2.status).toBe('completed')
    expect(ofType(r2, 'contact.updated')).toHaveLength(0)
    expect((await env.q(`SELECT count(*)::int AS n FROM crm.labels WHERE company_id = $1 AND name = 'Inexistente'`, [w.companyId]))[0].n).toBe(0)
  })
})

describe('AC-T63-02 status do chat e departamento', () => {
  it('AC-T63-02 change_chat_status aceita o enum interno (e os rótulos do editor), grava e publica chat.updated', async () => {
    const w = await world(env)
    const r = await runFlow(env, w, single('chat_controller', 'change_chat_status', { chat_status: 'resolved' }))
    expect(r.status, String(r.error)).toBe('completed')
    const ch = await chatRow(env, w.chatId)
    expect(ch.status).toBe('resolved')
    expect(ch.resolved_at).toBeTruthy()
    expect(ofType(r, 'chat.updated').map((e) => e.data.chat_id)).toContain(w.chatId)
    expect((await chatEvents(env, w.chatId)).some((e: any) => e.type === 'status_changed' && e.detail?.to === 'resolved')).toBe(true)

    const back = await runFlow(env, w, single('chat_controller', 'change_chat_status', { chat_status: 'Aguardando' }))
    expect(back.status, String(back.error)).toBe('completed')
    expect((await chatRow(env, w.chatId)).status).toBe('waiting')
    const attending = await runFlow(env, w, single('chat_controller', 'change_chat_status', { chat_status: 'attending' }))
    expect(attending.status).toBe('completed')
    expect((await chatRow(env, w.chatId)).status).toBe('attending')
    // mesmo status = no-op (sem evento)
    const same = await runFlow(env, w, single('chat_controller', 'change_chat_status', { chat_status: 'attending' }))
    expect(same.status).toBe('completed')
    expect(ofType(same, 'chat.updated')).toHaveLength(0)
  })

  it('AC-T63-02 valor fora do enum falha (failure; sem aresta o run fica failed) e não muda o chat', async () => {
    const w = await world(env)
    const viaFailure = await runFlow(env, w, single('chat_controller', 'change_chat_status', { chat_status: 'closed' }))
    expect(viaFailure.visited).toEqual(['FAIL'])
    expect((await chatRow(env, w.chatId)).status).toBe('waiting')
    const noEdge = await runFlow(env, w, single('chat_controller', 'change_chat_status', { chat_status: 'in_progress' }, false))
    expect(noEdge.status).toBe('failed')
    expect(String(noEdge.error)).toContain('invalid_chat_status')
    expect(ofType(noEdge, 'chat.updated')).toHaveLength(0)
  })

  it('AC-T63-02 set_department transfere o chat (departamento, evento e chat.updated); de outra empresa falha', async () => {
    const w = await world(env)
    const [dep] = await env.q(`INSERT INTO crm.departments (company_id, name) VALUES ($1, 'Financeiro') RETURNING id`, [w.companyId])
    const r = await runFlow(env, w, single('department', 'set_department', { department_id: dep.id, department_name: 'Financeiro' }))
    expect(r.status, String(r.error)).toBe('completed')
    expect((await chatRow(env, w.chatId)).department_id).toBe(dep.id)
    expect((await chatEvents(env, w.chatId)).some((e: any) => e.type === 'transferred')).toBe(true)
    expect(ofType(r, 'chat.updated').length).toBeGreaterThanOrEqual(1)

    const other = await world(env)
    const [foreign] = await env.q(`INSERT INTO crm.departments (company_id, name) VALUES ($1, 'Alheio') RETURNING id`, [other.companyId])
    const bad = await runFlow(env, w, single('department', 'set_department', { department_id: foreign.id }))
    expect(bad.visited).toEqual(['FAIL'])
    expect((await chatRow(env, w.chatId)).department_id).toBe(dep.id)
  })
})

describe('AC-T63-03 kanban', () => {
  const cards = async (chatId: string, crmId: string) => env.q(`SELECT id, column_id, value_cents FROM crm.crm_cards WHERE chat_id = $1 AND crm_id = $2`, [chatId, crmId])

  it('AC-T63-03 create_kanban_card cria o card com valor e, se já existir no quadro, move e atualiza', async () => {
    const w = await world(env, { customFields: { valor_pedido: '1.234,56' } })
    const b = await board(env, w.companyId)
    const r = await runFlow(env, w, single('kanban', 'create_kanban_card', { crm_id: b.id, crm_column_id: b.columns[0], value: 150 }))
    expect(r.status, String(r.error)).toBe('completed')
    const [c1] = await cards(w.chatId, b.id)
    expect(c1).toMatchObject({ column_id: b.columns[0] })
    expect(Number(c1.value_cents)).toBe(15_000)
    expect(r.published.some((p) => p.type.startsWith('kanban.card.'))).toBe(true)

    const r2 = await runFlow(env, w, single('kanban', 'create_kanban_card', { crm_id: b.id, crm_column_id: b.columns[2], value: '{valor_pedido}' }))
    expect(r2.status, String(r2.error)).toBe('completed')
    const after = await cards(w.chatId, b.id)
    expect(after).toHaveLength(1)
    expect(after[0]).toMatchObject({ id: c1.id, column_id: b.columns[2] })
    expect(Number(after[0].value_cents)).toBe(123_456)

    // sem valor: só move, mantém o valor
    await runFlow(env, w, single('kanban', 'create_kanban_card', { crm_id: b.id, crm_column_id: b.columns[1] }))
    const moved = await cards(w.chatId, b.id)
    expect(moved[0]).toMatchObject({ column_id: b.columns[1] })
    expect(Number(moved[0].value_cents)).toBe(123_456)
  })

  it('AC-T63-03 remove_kanban_card remove o card do chat no quadro (sem card = no-op)', async () => {
    const w = await world(env)
    const b = await board(env, w.companyId)
    const other = await board(env, w.companyId)
    await runFlow(env, w, single('kanban', 'create_kanban_card', { crm_id: b.id, crm_column_id: b.columns[0] }))
    await runFlow(env, w, single('kanban', 'create_kanban_card', { crm_id: other.id, crm_column_id: other.columns[0] }))
    const r = await runFlow(env, w, single('kanban', 'remove_kanban_card', { crm_id: b.id }))
    expect(r.status, String(r.error)).toBe('completed')
    expect(await cards(w.chatId, b.id)).toHaveLength(0)
    expect(await cards(w.chatId, other.id)).toHaveLength(1) // só o quadro configurado
    const again = await runFlow(env, w, single('kanban', 'remove_kanban_card', { crm_id: b.id }))
    expect(again.status).toBe('completed')
    expect(again.visited).toEqual(['OK'])
  })
})

describe('AC-T63-04 manipulador e data de criação', () => {
  const manip = (operation: string, value: unknown, value_type = 'number', field_name = 'pontos') =>
    single('manipulator', 'set_contact_custom_field', { field_name, operation, value_type, value })

  it('AC-T63-04 set, add, subtract, multiply e divide sobre o campo personalizado (vírgula decimal, ausente = 0)', async () => {
    const w = await world(env, { customFields: { saldo: '10,5' } })
    const steps: Array<[string, unknown, number]> = [
      ['add', 5, 5], // ausente = 0
      ['multiply', '2,5', 12.5],
      ['subtract', '0.5', 12],
      ['divide', 4, 3],
      ['set_value', '7,25', 7.25],
    ]
    for (const [op, v, expected] of steps) {
      const r = await runFlow(env, w, manip(op, v))
      expect(r.status, `${op}: ${String(r.error)}`).toBe('completed')
      expect(Number((await cf(w.contactId)).pontos), op).toBeCloseTo(expected, 6)
    }
    const r = await runFlow(env, w, manip('add', 1, 'number', 'saldo'))
    expect(r.status).toBe('completed')
    expect(Number((await cf(w.contactId)).saldo)).toBeCloseTo(11.5, 6)
    expect(ofType(r, 'contact.updated')).toHaveLength(1)
    // set texto grava string; alias 'set'
    await runFlow(env, w, single('manipulator', 'set_contact_custom_field', { field_name: 'plano', operation: 'set_value', value_type: 'text', value: 'Premium {first_name}' }))
    expect((await cf(w.contactId)).plano).toBe('Premium Maria')
    await runFlow(env, w, single('manipulator', 'set_contact_custom_field', { field_name: 'plano', operation: 'set', value_type: 'text', value: 'Básico' }))
    expect((await cf(w.contactId)).plano).toBe('Básico')
  })

  it('AC-T63-04 divisão por zero → failure (sem aresta: failed division_by_zero) e o campo não muda', async () => {
    const w = await world(env, { customFields: { pontos: 8 } })
    const viaFailure = await runFlow(env, w, manip('divide', '0'))
    expect(viaFailure.visited).toEqual(['FAIL'])
    expect(Number((await cf(w.contactId)).pontos)).toBe(8)
    const noEdge = await runFlow(env, w, single('manipulator', 'set_contact_custom_field', { field_name: 'pontos', operation: 'divide', value_type: 'number', value: 0 }, false))
    expect(noEdge.status).toBe('failed')
    expect(String(noEdge.error)).toContain('division_by_zero')
  })

  it('AC-T63-04 set_created_at aceita dd/MM/aaaa HH:mm:ss (fuso da empresa) e ISO; inválido → failure', async () => {
    const w = await world(env)
    const createdAt = async () => new Date((await env.q(`SELECT created_at FROM crm.contacts WHERE id = $1`, [w.contactId]))[0].created_at).toISOString()
    let r = await runFlow(env, w, single('manipulator', 'set_created_at', { operation: 'set_value', value: '15/03/2026 14:30:00' }))
    expect(r.status, String(r.error)).toBe('completed')
    expect(await createdAt()).toBe('2026-03-15T17:30:00.000Z') // 14:30 em São Paulo (UTC−3)
    r = await runFlow(env, w, single('manipulator', 'set_created_at', { operation: 'set_value', value: '2025-12-01T08:00:00Z' }))
    expect(r.status).toBe('completed')
    expect(await createdAt()).toBe('2025-12-01T08:00:00.000Z')
    const tokyo = await world(env, { timeZone: 'Asia/Tokyo' })
    await runFlow(env, tokyo, single('manipulator', 'set_created_at', { operation: 'set_value', value: '01/01/2026 09:00:00' }))
    expect(new Date((await env.q(`SELECT created_at FROM crm.contacts WHERE id = $1`, [tokyo.contactId]))[0].created_at).toISOString()).toBe('2026-01-01T00:00:00.000Z')
    const bad = await runFlow(env, w, single('manipulator', 'set_created_at', { operation: 'set_value', value: '32/13/2026 99:00:00' }))
    expect(bad.visited).toEqual(['FAIL'])
    expect(await createdAt()).toBe('2025-12-01T08:00:00.000Z')
  })
})

describe('AC-T63-05 venda aprovada e agente de IA', () => {
  async function product(companyId: string, o: { min?: number; max?: number; fallback?: number; currency?: string } = {}) {
    const [p] = await env.q(
      `INSERT INTO crm.products (company_id, name, currency, price_min_cents, price_max_cents, price_fallback_cents) VALUES ($1, 'Curso Online', $2, $3, $4, $5) RETURNING id, public_id`,
      [companyId, o.currency ?? 'BRL', o.min ?? 1_000, o.max ?? 100_000, o.fallback ?? 4_990],
    )
    return p
  }
  const saleDef = (cfg: Record<string, unknown>) => single('approved_sale', 'register_approved_sale', cfg)
  const salesOf = (companyId: string) =>
    env.q(`SELECT source, external_id, amount_cents, currency, product_id, contact_id, customer_name, note_issuer_id, utmify_integration_id FROM crm.sales WHERE company_id = $1 ORDER BY created_at`, [companyId])

  it('AC-T63-05 grava a venda (origem flow) com produto, valor, moeda e cliente renderizados, ids de nota/utmify, e push notification.created', async () => {
    const w = await world(env, { customFields: { valor: '197,90', moeda: 'usd', pagador: 'João Pagador' } })
    const p = await product(w.companyId)
    const r = await runFlow(
      env,
      w,
      saleDef({
        product_public_id: p.public_id,
        amount_template: '{valor}',
        currency_template: '{moeda}',
        customer_name_template: '{pagador}',
        note_issuer_id: 'nota-123',
        utmify_integration_id: 'utm-456',
        push_title_template: 'Venda de {produto.nome}',
        push_body_template: '{venda.cliente} pagou {venda.moeda} {venda.valor}',
      }),
    )
    expect(r.status, String(r.error)).toBe('completed')
    const sales = await salesOf(w.companyId)
    expect(sales).toHaveLength(1)
    expect(sales[0]).toMatchObject({ source: 'flow', currency: 'USD', product_id: p.id, contact_id: w.contactId, customer_name: 'João Pagador', note_issuer_id: 'nota-123', utmify_integration_id: 'utm-456' })
    expect(Number(sales[0].amount_cents)).toBe(19_790)
    const push = ofType(r, 'notification.created')
    expect(push).toHaveLength(1)
    expect(push[0]!.companyId).toBe(w.companyId)
    expect(push[0]!.data).toMatchObject({ title: 'Venda de Curso Online', body: 'João Pagador pagou USD 197,90', kind: 'approved_sale' })
  })

  it('AC-T63-05 valor fora da faixa usa o fallback; moeda vazia usa a do produto; cliente vazio usa o contato; sem push sem template', async () => {
    const w = await world(env, { contactName: 'Ana Contato', customFields: { valor: '5,00' } })
    const p = await product(w.companyId, { min: 1_000, max: 50_000, fallback: 4_990, currency: 'BRL' })
    const r = await runFlow(env, w, saleDef({ product_public_id: p.public_id, amount_template: '{valor}', currency_template: '', customer_name_template: '' }))
    expect(r.status, String(r.error)).toBe('completed')
    const [s] = await salesOf(w.companyId)
    expect(Number(s.amount_cents)).toBe(4_990)
    expect(s).toMatchObject({ currency: 'BRL', customer_name: 'Ana Contato', note_issuer_id: null, utmify_integration_id: null })
    expect(ofType(r, 'notification.created')).toHaveLength(0)
    // valor inválido também cai no fallback
    const w2 = await world(env, { customFields: { valor: 'abc' } })
    const p2 = await product(w2.companyId)
    await runFlow(env, w2, saleDef({ product_public_id: p2.public_id, amount_template: '{valor}' }))
    expect(Number((await salesOf(w2.companyId))[0].amount_cents)).toBe(4_990)
    // produto de outra empresa → failure, nada gravado
    const w3 = await world(env)
    const bad = await runFlow(env, w3, saleDef({ product_public_id: p.public_id, amount_template: '100' }))
    expect(bad.visited).toEqual(['FAIL'])
    expect(await salesOf(w3.companyId)).toHaveLength(0)
  })

  it('AC-T63-05 control_ai_agent liga e desliga o agente no chat', async () => {
    const w = await world(env)
    const [agent] = await env.q(`INSERT INTO crm.ai_agents (company_id, name) VALUES ($1, 'Agente Vendas') RETURNING id`, [w.companyId])
    const on = await runFlow(env, w, single('ai_agent', 'control_ai_agent', { mode: 'activate', agent_id: agent.id }))
    expect(on.status, String(on.error)).toBe('completed')
    expect((await chatRow(env, w.chatId)).ai_agent_id).toBe(agent.id)
    expect(ofType(on, 'chat.updated').length).toBeGreaterThanOrEqual(1)
    const off = await runFlow(env, w, single('ai_agent', 'control_ai_agent', { mode: 'deactivate' }))
    expect(off.status, String(off.error)).toBe('completed')
    expect((await chatRow(env, w.chatId)).ai_agent_id).toBeNull()
    // agente de outra empresa → failure
    const other = await world(env)
    const [foreign] = await env.q(`INSERT INTO crm.ai_agents (company_id, name) VALUES ($1, 'Alheio') RETURNING id`, [other.companyId])
    const bad = await runFlow(env, w, single('ai_agent', 'control_ai_agent', { mode: 'activate', agent_id: foreign.id }))
    expect(bad.visited).toEqual(['FAIL'])
    expect((await chatRow(env, w.chatId)).ai_agent_id).toBeNull()
  })

  it('AC-T63-05 sem chat no run os nós de chat falham (no_chat)', async () => {
    const w = await world(env)
    const r = await runFlow(env, w, single('ai_agent', 'control_ai_agent', { mode: 'deactivate' }, false), { chatId: null })
    expect(r.status).toBe('failed')
    expect(String(r.error)).toContain('no_chat')
  })
})

