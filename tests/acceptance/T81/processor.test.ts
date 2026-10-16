// AC-T81-01..04: processador de webhooks de entrada (passos na ordem de 09#5, dedupe e condições, conexão pelos
// 8 últimos dígitos) e escuta de amostras (webhook.sample_received só para o ouvinte).
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { uuid } from '../helpers/factories'
import {
  baseConfig,
  contactByPhone,
  deliver,
  localPhone,
  newBoard,
  newConnection,
  newFlow,
  newLabel,
  newMember,
  newOwner,
  newWebhook,
  openSse,
  path,
  postHook,
  processAll,
  requestDto,
  requestRow,
  runsOf,
  setConfig,
  sleep,
  startEnv,
  stepOf,
  type Env,
  type User,
} from './setup'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

const ORDER = ['resolve_customer', 'identity_fields', 'custom_fields', 'resolve_connection', 'tags', 'kanban', 'trigger_flow']

let env: Env
let owner: User
beforeAll(async () => {
  env = await startEnv()
  owner = await newOwner(env)
})
afterAll(async () => {
  await env?.close()
})

const body = (fone: string, extra: Record<string, unknown> = {}) => ({
  cliente: { nome: 'Maria Souza', fone, email: `maria.${fone}@exemplo.test`, cpf: '123.456.789-00' },
  ...extra,
})

/** Webhook com conexão aberta, fluxo, etiqueta e kanban configurados. */
async function fullSetup(extra: Record<string, unknown> = {}) {
  const connPhone = `55${localPhone()}`
  const connectionId = await newConnection(env, owner.companyId, connPhone)
  const flowId = await newFlow(env, owner.companyId)
  const labelName = `VIP ${uuid().slice(0, 6)}`
  await newLabel(owner, labelName)
  const board = await newBoard(owner)
  const wh = await newWebhook(owner)
  await setConfig(
    owner,
    wh.id,
    baseConfig({
      custom_field_mappings: [{ field_key: 'cpf', segments: [path('cliente.cpf')] }],
      add_tags: [labelName],
      kanban_actions: [{ action: 'create_kanban_card', crm_id: board.crmId, crm_column_id: board.columns[1], value: 150 }],
      trigger_flow: true,
      flow_id: flowId,
      connection_value: connPhone,
      ...extra,
    }),
  )
  return { wh, connectionId, connPhone, flowId, labelName, board }
}

describe('T81 processador', () => {
  it('AC-T81-01 passos na ordem de 09#5, todos ok: contato, identidade, campos, etiquetas, kanban e fluxo disparado', async () => {
    const s = await fullSetup()
    const fone = localPhone()
    const { requestId, result, row } = await deliver(env, s.wh.public_token, body(fone))

    expect(row.processing_status).toBe('processed')
    expect(row.processed_at).not.toBeNull()
    expect(row.error).toBeNull()
    expect(row.steps.map((x: Any) => x.step)).toEqual(ORDER)
    for (const name of ['resolve_customer', 'custom_fields', 'resolve_connection', 'tags', 'kanban', 'trigger_flow'])
      expect(stepOf(row.steps, name), name).toMatchObject({ status: 'ok' })
    for (const st of row.steps) expect(['ok', 'failed', 'skipped']).toContain(st.status)
    expect(result).toMatchObject({ status: 'processed' })
    expect(result.steps.map((x: Any) => x.step)).toEqual(ORDER)

    // efeitos de cada passo
    const contact = await contactByPhone(env, owner.companyId, fone)
    expect(contact).toBeTruthy()
    expect(contact.name).toBe('Maria Souza')
    expect(contact.email).toBe(`maria.${fone}@exemplo.test`)
    expect(contact.custom_fields).toMatchObject({ cpf: '123.456.789-00' })
    const labels = await env.q(`SELECT l.name FROM crm.contact_labels cl JOIN crm.labels l ON l.id = cl.label_id WHERE cl.contact_id = $1`, [contact.id])
    expect(labels.map((l: Any) => l.name)).toEqual([s.labelName])
    const runs = await runsOf(env, contact.id)
    expect(runs).toHaveLength(1)
    expect(runs[0]).toMatchObject({ flow_id: s.flowId, connection_id: s.connectionId })
    expect(runs[0].trigger).toMatchObject({ type: 'inbound_webhook', webhook_id: s.wh.id, request_id: requestId })
    const cards = await env.q(`SELECT column_id FROM crm.crm_cards WHERE chat_id = $1`, [runs[0].chat_id])
    expect(cards).toEqual([{ column_id: s.board.columns[1] }])

    // o histórico pela API mostra os mesmos passos
    const dto = await requestDto(owner, s.wh.id, requestId)
    expect(dto).toMatchObject({ processing_status: 'processed' })
    expect(dto.steps.map((x: Any) => x.step)).toEqual(ORDER)
    expect(dto.processed_at).toBeTruthy()
  })

  it('AC-T81-01 passos não configurados ficam skipped com motivo; contato existente é atualizado', async () => {
    const wh = await newWebhook(owner)
    await setConfig(owner, wh.id, baseConfig())
    const fone = localPhone()
    const first = await deliver(env, wh.public_token, body(fone))
    expect(first.row.processing_status).toBe('processed')
    expect(first.row.steps.map((x: Any) => x.step)).toEqual(ORDER)
    expect(stepOf(first.row.steps, 'resolve_customer').status).toBe('ok')
    for (const name of ['custom_fields', 'resolve_connection', 'tags', 'kanban', 'trigger_flow']) {
      const st = stepOf(first.row.steps, name)
      expect(st.status, name).toBe('skipped')
      expect(st.reason, `${name} sem motivo`).toBeTruthy()
    }
    expect(stepOf(first.row.steps, 'custom_fields').reason).toBe('not_configured')
    expect(stepOf(first.row.steps, 'resolve_connection').reason).toBe('no_connection')

    // mesmo telefone, nome novo: atualiza o mesmo contato (não cria outro)
    const second = await deliver(env, wh.public_token, { cliente: { nome: 'Maria S. Lima', fone, email: `maria.${fone}@exemplo.test` } })
    expect(second.row.processing_status).toBe('processed')
    const rows = await env.q(`SELECT name FROM crm.contacts WHERE company_id = $1 AND phone_e164 LIKE '%' || $2`, [owner.companyId, fone])
    expect(rows).toEqual([{ name: 'Maria S. Lima' }])
  })

  it('AC-T81-01 sem nome ou telefone: resolve_customer failed (missing_required_fields) e os demais skipped', async () => {
    // telefone mapeado só pelo caminho (sem literal), para que "ausente" seja segmentos vazios
    const wh = await newWebhook(owner)
    await setConfig(owner, wh.id, { field_paths: { full_name: [path('cliente.nome')], phone: [path('cliente.fone')] } })
    for (const payload of [{ cliente: { nome: 'Sem Telefone' } }, { cliente: { fone: `55${localPhone()}` } }]) {
      const { row } = await deliver(env, wh.public_token, payload)
      const label = JSON.stringify(payload)
      expect(row.processing_status, label).toBe('failed')
      expect(row.error, label).toBe('missing_required_fields')
      expect(row.processed_at, label).not.toBeNull()
      expect(row.steps.map((x: Any) => x.step), label).toEqual(ORDER)
      expect(stepOf(row.steps, 'resolve_customer'), label).toMatchObject({ status: 'failed', reason: 'missing_required_fields' })
      for (const name of ORDER.slice(1)) expect(stepOf(row.steps, name), `${label} ${name}`).toMatchObject({ status: 'skipped', reason: 'customer_not_resolved' })
    }
  })

  it('AC-T81-01 telefone de um contato com e-mail de outro: resolve_customer failed com unique_constraint', async () => {
    const wh = await newWebhook(owner)
    await setConfig(owner, wh.id, baseConfig())
    const a = localPhone()
    const b = localPhone()
    await deliver(env, wh.public_token, body(a))
    await deliver(env, wh.public_token, body(b))
    const { row } = await deliver(env, wh.public_token, { cliente: { nome: 'Conflito', fone: a, email: `maria.${b}@exemplo.test` } })
    expect(row.processing_status).toBe('failed')
    expect(row.error).toBe('step_failed')
    expect(row.reason).toBe('unique_constraint')
    expect(stepOf(row.steps, 'resolve_customer')).toMatchObject({ status: 'failed', reason: 'unique_constraint' })
    // nenhum dos dois contatos foi alterado
    expect((await contactByPhone(env, owner.companyId, a)).email).toBe(`maria.${a}@exemplo.test`)
    expect((await contactByPhone(env, owner.companyId, b)).email).toBe(`maria.${b}@exemplo.test`)
  })

  it('AC-T81-01 etiqueta inexistente: tags failed labels_not_found:<nome> e as existentes ainda são aplicadas', async () => {
    const s = await fullSetup()
    await setConfig(owner, s.wh.id, { ...s.wh.config, ...baseConfig(), add_tags: [`  ${s.labelName.toUpperCase()} `, 'Nao Existe'], connection_value: s.connPhone })
    const fone = localPhone()
    const { row } = await deliver(env, s.wh.public_token, body(fone))
    expect(row.processing_status).toBe('failed')
    expect(stepOf(row.steps, 'tags')).toMatchObject({ status: 'failed', reason: 'labels_not_found:Nao Existe' })
    const contact = await contactByPhone(env, owner.companyId, fone)
    const labels = await env.q(`SELECT l.name FROM crm.contact_labels cl JOIN crm.labels l ON l.id = cl.label_id WHERE cl.contact_id = $1`, [contact.id])
    expect(labels.map((l: Any) => l.name)).toEqual([s.labelName])
  })

  it('AC-T81-01 conexão desconectada: resolve_connection ok e etiquetas/kanban/fluxo skipped (skipped_due_to_disconnected_connection)', async () => {
    const s = await fullSetup()
    await env.q(`UPDATE crm.connections SET connection_state = 'close' WHERE id = $1`, [s.connectionId])
    const fone = localPhone()
    const { row } = await deliver(env, s.wh.public_token, body(fone))
    expect(row.processing_status).toBe('processed')
    expect(stepOf(row.steps, 'resolve_connection').status).toBe('ok')
    for (const name of ['tags', 'kanban', 'trigger_flow'])
      expect(stepOf(row.steps, name), name).toMatchObject({ status: 'skipped', reason: 'skipped_due_to_disconnected_connection' })
    const contact = await contactByPhone(env, owner.companyId, fone)
    expect(await runsOf(env, contact.id)).toEqual([])
  })

  it('AC-T81-01 disparar fluxo cancela o fluxo em andamento do lead e inicia o novo', async () => {
    const s = await fullSetup({ add_tags: [], kanban_actions: [] })
    const fone = localPhone()
    await deliver(env, s.wh.public_token, body(fone))
    const contact = await contactByPhone(env, owner.companyId, fone)
    // o 1º run ainda não executou (os passos ficam na fila capturada): está ativo
    const before = await env.q(`SELECT id, status FROM crm.flow_runs WHERE contact_id = $1`, [contact.id])
    expect(before).toHaveLength(1)
    await deliver(env, s.wh.public_token, body(fone, { pedido: 2 }))
    const after = await env.q(`SELECT id, status FROM crm.flow_runs WHERE contact_id = $1 ORDER BY started_at`, [contact.id])
    expect(after).toHaveLength(2)
    expect(after[0]).toMatchObject({ id: before[0].id, status: 'cancelled' })
    expect(after[1].status).not.toBe('cancelled')
  })

  it('AC-T81-01 varredura reenfileira requests pending cujo enqueue falhou (mesmo jobId, sem duplicar)', async () => {
    const wh = await newWebhook(owner)
    await setConfig(owner, wh.id, baseConfig())
    const res = await postHook(env, wh.public_token, body(localPhone()))
    expect(res.status).toBe(202)
    env.enqueued.length = 0 // simula o enqueue que falhou: o job nunca chegou à fila
    await env.q(`UPDATE crm.inbound_webhook_requests SET created_at = now() - interval '5 minutes' WHERE id = $1`, [res.body.request_id])
    const swept: Any[] = []
    await env.processor.sweepPending({ olderThanMs: 60_000, limit: 100 }, async (data: Any, opts?: Any) => void swept.push({ data, opts }))
    const mine = swept.filter((j) => j.data.requestId === res.body.request_id)
    expect(mine).toHaveLength(1)
    expect(mine[0].data).toMatchObject({ requestId: res.body.request_id, webhookId: wh.id, companyId: owner.companyId })
    const r = await env.processor.process(mine[0].data)
    expect(r.status).toBe('processed')
    expect((await requestRow(env, res.body.request_id)).processing_status).toBe('processed')
    // processado não é varrido de novo
    const again: Any[] = []
    await env.processor.sweepPending({ olderThanMs: 60_000, limit: 100 }, async (data: Any) => void again.push(data))
    expect(again.filter((d) => d.requestId === res.body.request_id)).toEqual([])
  })

  it('AC-T81-01 o log de acesso de /api/hooks/** não contém o token público', async () => {
    const wh = await newWebhook(owner)
    const before = env.logs.length
    expect((await postHook(env, wh.public_token, { a: 1 })).status).toBe(202)
    expect((await postHook(env, `${wh.public_token}x`, { a: 1 })).status).toBe(404)
    await processAll(env)
    const lines = env.logs.slice(before)
    expect(lines.filter((l) => l.includes(wh.public_token))).toEqual([])
    const access = lines.map((l) => JSON.parse(l)).filter((l) => typeof l.path === 'string' && l.path.startsWith('/api/hooks/in'))
    expect(access.length).toBeGreaterThanOrEqual(2)
    for (const l of access) expect(l.path).toBe('/api/hooks/in/***')
  })

  it('AC-T81-02 corpo repetido em até 10 min vira skipped (duplicate_payload) sem repetir efeitos', async () => {
    const s = await fullSetup({ kanban_actions: [] })
    const fone = localPhone()
    const payload = body(fone)
    const first = await deliver(env, s.wh.public_token, payload)
    const second = await deliver(env, s.wh.public_token, payload)
    expect(first.row.processing_status).toBe('processed')
    expect(second.row).toMatchObject({ processing_status: 'skipped', error: 'duplicate_payload', reason: 'duplicate_payload' })
    expect(second.row.steps).toEqual([])
    expect(second.row.processed_at).not.toBeNull()
    const contact = await contactByPhone(env, owner.companyId, fone)
    expect(await runsOf(env, contact.id)).toHaveLength(1)
    // corpo diferente no mesmo webhook processa normalmente
    const other = await deliver(env, s.wh.public_token, body(fone, { pedido: 99 }))
    expect(other.row.processing_status).toBe('processed')
  })

  it('AC-T81-02 o mesmo corpo depois de 10 min ou em outro webhook não é duplicado', async () => {
    const a = await newWebhook(owner)
    const b = await newWebhook(owner)
    await setConfig(owner, a.id, baseConfig())
    await setConfig(owner, b.id, baseConfig())
    const payload = body(localPhone())
    const first = await deliver(env, a.public_token, payload)
    expect((await deliver(env, b.public_token, payload)).row.processing_status).toBe('processed')
    await env.q(`UPDATE crm.inbound_webhook_requests SET created_at = created_at - interval '11 minutes' WHERE id = $1`, [first.requestId])
    expect((await deliver(env, a.public_token, payload)).row.processing_status).toBe('processed')
  })

  it('AC-T81-02 condições all/any não satisfeitas não disparam o fluxo (conditions_not_met)', async () => {
    const s = await fullSetup({ add_tags: [], kanban_actions: [] })
    const cond = (fieldValue: string) => ({ category: 'field', fieldName: 'name', fieldOperator: 'contains', fieldValue })
    const cases: Array<[string, Any[], boolean]> = [
      ['all', [cond('Maria'), cond('Pedro')], false],
      ['any', [cond('Pedro'), cond('Joao')], false],
      ['all', [cond('Maria'), cond('Souza')], true],
      ['any', [cond('Pedro'), cond('Souza')], true],
    ]
    for (const [ruleType, conditions, fires] of cases) {
      await setConfig(owner, s.wh.id, baseConfig({ trigger_flow: true, flow_id: s.flowId, connection_value: s.connPhone, trigger_conditions: { ruleType, conditions } }))
      const fone = localPhone()
      const { row } = await deliver(env, s.wh.public_token, body(fone))
      const contact = await contactByPhone(env, owner.companyId, fone)
      const label = `${ruleType} ${conditions.map((c) => c.fieldValue).join('/')}`
      expect(row.processing_status, label).toBe('processed')
      if (fires) {
        expect(stepOf(row.steps, 'trigger_flow').status, label).toBe('ok')
        expect(await runsOf(env, contact.id), label).toHaveLength(1)
      } else {
        expect(stepOf(row.steps, 'trigger_flow'), label).toMatchObject({ status: 'skipped', reason: 'conditions_not_met' })
        expect(row.reason, label).toBe('conditions_not_met')
        expect(await runsOf(env, contact.id), label).toEqual([])
      }
    }
  })

  it('AC-T81-02 condição não satisfeita não cancela o fluxo em andamento do lead', async () => {
    const s = await fullSetup({ add_tags: [], kanban_actions: [] })
    const fone = localPhone()
    await deliver(env, s.wh.public_token, body(fone))
    const contact = await contactByPhone(env, owner.companyId, fone)
    await setConfig(
      owner,
      s.wh.id,
      baseConfig({
        trigger_flow: true,
        flow_id: s.flowId,
        connection_value: s.connPhone,
        trigger_conditions: { ruleType: 'all', conditions: [{ category: 'field', fieldName: 'name', fieldOperator: 'equal', fieldValue: 'Ninguém' }] },
      }),
    )
    await deliver(env, s.wh.public_token, body(fone, { pedido: 3 }))
    const runs = await env.q(`SELECT status FROM crm.flow_runs WHERE contact_id = $1`, [contact.id])
    expect(runs).toHaveLength(1)
    expect(runs[0].status).not.toBe('cancelled')
  })

  it('AC-T81-03 número que dispara casa os 8 últimos dígitos, ignorando formatação (fixo e por variável)', async () => {
    const connPhone = `55${localPhone()}`
    const connectionId = await newConnection(env, owner.companyId, connPhone)
    const flowId = await newFlow(env, owner.companyId)
    const last8 = connPhone.slice(-8)
    const formatted = `+55 (11) 9${last8.slice(0, 4)}-${last8.slice(4)}`
    for (const [value, extra] of [
      [formatted, {}],
      [`0${last8.slice(0, 4)}/${last8.slice(4)}`, {}],
      ['{instancia.numero}', { instancia: { numero: `9${last8}` } }],
    ] as Array<[string, Record<string, unknown>]>) {
      const wh = await newWebhook(owner)
      await setConfig(owner, wh.id, baseConfig({ trigger_flow: true, flow_id: flowId, connection_value: value }))
      const fone = localPhone()
      const { row } = await deliver(env, wh.public_token, body(fone, extra))
      expect(stepOf(row.steps, 'resolve_connection'), value).toMatchObject({ status: 'ok' })
      expect(stepOf(row.steps, 'trigger_flow'), value).toMatchObject({ status: 'ok' })
      const contact = await contactByPhone(env, owner.companyId, fone)
      const runs = await runsOf(env, contact.id)
      expect(runs, value).toHaveLength(1)
      expect(runs[0].connection_id, value).toBe(connectionId)
    }
  })

  it('AC-T81-03 conexão ambígua, inexistente ou número curto não dispara e registra o motivo', async () => {
    const shared = localPhone().slice(-8)
    await newConnection(env, owner.companyId, `55119${shared}`)
    await newConnection(env, owner.companyId, `55219${shared}`)
    // conexão de outra empresa com os mesmos 8 dígitos não conta
    const other = await newOwner(env)
    const lonely = localPhone().slice(-8)
    await newConnection(env, other.companyId, `5511${lonely}`)
    const flowId = await newFlow(env, owner.companyId)
    for (const [value, reason] of [
      [`(31) 9${shared}`, 'connection_not_resolved:ambiguous'],
      [`5511${lonely}`, 'connection_not_resolved:not_found'],
      ['12345', 'connection_not_resolved:too_short'],
      ['{nao.existe}', null],
    ] as Array<[string, string | null]>) {
      const wh = await newWebhook(owner)
      await setConfig(owner, wh.id, baseConfig({ trigger_flow: true, flow_id: flowId, connection_value: value }))
      const fone = localPhone()
      const { row } = await deliver(env, wh.public_token, body(fone))
      const rc = stepOf(row.steps, 'resolve_connection')
      expect(rc.status, value).toBe('skipped')
      if (reason) expect(rc.reason, value).toBe(reason)
      else expect(String(rc.reason), value).toMatch(/^connection_not_resolved/)
      expect(stepOf(row.steps, 'trigger_flow'), value).toMatchObject({ status: 'skipped', reason: rc.reason })
      expect(row.reason, value).toBe(rc.reason)
      const contact = await contactByPhone(env, owner.companyId, fone)
      expect(await runsOf(env, contact.id), value).toEqual([])
    }
  })

  it('AC-T81-04 durante a escuta, o request publica webhook.sample_received só para o ouvinte daquele webhook (uma vez)', async () => {
    const listener = await newMember(env, owner.companyId, ['webhooks.view'])
    const bystander = await newMember(env, owner.companyId, ['webhooks.view'])
    const wh = await newWebhook(owner)
    const otherWh = await newWebhook(owner)
    const sl = await openSse(env, listener)
    const sb = await openSse(env, bystander)
    const so = await openSse(env, owner)
    try {
      const listen = await listener.c.post(`/api/inbound-webhooks/${wh.id}/sample-listen`)
      expect(listen.status, listen.text).toBe(200)
      expect(listen.body).toMatchObject({ listening: true })
      const ttl = new Date(listen.body.expires_at).getTime() - Date.now()
      expect(ttl).toBeGreaterThan(80_000)
      expect(ttl).toBeLessThanOrEqual(91_000)

      // request de outro webhook não chega ao ouvinte
      await deliver(env, otherWh.public_token, { outro: true })
      const raw = JSON.stringify({ pedido: 123, cliente: { nome: 'Amostra' } })
      const { requestId } = await deliver(env, wh.public_token, raw)
      const m = await sl.waitFor((x) => x.event === 'webhook.sample_received', 10_000)
      const data = JSON.parse(m.data)
      const payload = data.data ?? data
      expect(payload).toMatchObject({ webhook_id: wh.id, request_id: requestId, request: { raw_body: raw, raw_body_truncated: false } })

      // a escuta dispara uma vez: o próximo request não gera outra amostra
      await deliver(env, wh.public_token, { pedido: 124 })
      await sleep(500)
      expect(sl.events('webhook.sample_received')).toHaveLength(1)
      expect(sb.events('webhook.sample_received')).toEqual([])
      expect(so.events('webhook.sample_received')).toEqual([])
    } finally {
      await Promise.all([sl.close(), sb.close(), so.close()])
    }
  })

  it('AC-T81-04 escuta cancelada não recebe; webhook de outra empresa → 404; um duplicado também vira amostra', async () => {
    const wh = await newWebhook(owner)
    await setConfig(owner, wh.id, baseConfig())
    const stranger = await newOwner(env)
    expect((await stranger.c.post(`/api/inbound-webhooks/${wh.id}/sample-listen`)).status).toBe(404)

    const s = await openSse(env, owner)
    try {
      expect((await owner.c.post(`/api/inbound-webhooks/${wh.id}/sample-listen`)).status).toBe(200)
      const del = await owner.c.delete(`/api/inbound-webhooks/${wh.id}/sample-listen`)
      expect(del.status, del.text).toBeLessThan(300)
      const payload = body(localPhone())
      await deliver(env, wh.public_token, payload)
      await sleep(500)
      expect(s.events('webhook.sample_received')).toEqual([])

      // nova escuta: o mesmo corpo (duplicado) também é entregue como amostra
      expect((await owner.c.post(`/api/inbound-webhooks/${wh.id}/sample-listen`)).status).toBe(200)
      const dup = await deliver(env, wh.public_token, payload)
      expect(dup.row.processing_status).toBe('skipped')
      const m = await s.waitFor((x) => x.event === 'webhook.sample_received', 10_000)
      const data = JSON.parse(m.data)
      expect(data.data ?? data).toMatchObject({ webhook_id: wh.id, request_id: dup.requestId })
    } finally {
      await s.close()
    }
  })
})

