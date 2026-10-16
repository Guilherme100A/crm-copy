// AC-T10-05: cada action_type suportado tem schema e exemplo válido testado.
// Exemplos escritos a partir de spec/features/06-fluxos.md §3.6 (campos literais), independentes da implementação.
import { beforeAll, describe, expect, it } from 'vitest'
import { REF_GATEWAY, edge, flow, fmt, loadFlows, msg, node } from './support'

let F: any
beforeAll(async () => {
  F = await loadFlows()
})

const URL_IMG = 'https://example.test/media/foto.jpg'

/** Exemplo válido por action_type (lista de suportados da SPEC T10 / 06 §3.6, sem os fora de escopo). */
const EXAMPLES: Record<string, Record<string, unknown>> = {
  send_message: { message_text: 'Olá {first_name}, tudo bem?', typing_delay_seconds: 2, vary_text_with_ai: false },
  send_multi_media: { media_type: 'image', media_source: 'url', media_url: URL_IMG, typing_delay_seconds: 1 },
  send_file: { file_name: 'catalogo.pdf', file_url: 'https://example.test/media/catalogo.pdf', media_source: 'url' },
  send_sticker: { sticker_name: 'oi.webp', sticker_url: 'https://example.test/media/oi.webp', media_source: 'url' },
  send_contact: { contact_name: 'Suporte', contact_phone: '+5599900000001' },
  delay_between_messages: { delay_seconds: 5, delay_min_seconds: 2, delay_max_seconds: 10 },
  add_tags: { action: 'add', tags: ['lead-quente'] },
  remove_tags: { action: 'remove', tags: ['lead-frio'] },
  send_pix_button: { pix_key: '123e4567-e89b-42d3-a456-426614174000', pix_type: 'EVP', merchant_name: 'Pix' },
  send_interactive_menu: {
    menuType: 'list',
    message: 'Escolha uma opção',
    buttonLabel: 'Ver opções',
    options: [
      { id: 'option_1', title: 'Comprar' },
      { id: 'option_2', title: 'Suporte', description: 'Falar com a equipe' },
    ],
    timeout_value: 1,
    timeout_unit: 'hours',
  },
  send_option_list: {
    menuType: 'list',
    message: 'Escolha uma opção',
    buttonLabel: 'Ver opções',
    options: [{ id: 'option_1', title: 'Comprar' }],
    timeout_value: 0,
    timeout_unit: 'days',
  },
  save_user_data: { field_name: 'escolha', save_empty: true },
  send_carousel: {
    text: 'Escolha uma opção abaixo',
    delay: 300,
    readchat: true,
    readmessages: true,
    gatilho: { timeout_value: 0, timeout_unit: 'days', fallback_unico: true, desarma_em_bloco_terminal: true },
    carousel: [
      {
        card_id: 'card_1',
        text: 'Produto 1',
        media_kind: 'image',
        media_source: 'url',
        image: URL_IMG,
        buttons: [{ id: 'btn_1', text: 'Quero este', type: 'REPLY', payload: 'quero_1' }],
      },
    ],
  },
  wait_for_response: { wait_indefinitely: false, timeout_value: 1, timeout_unit: 'days' },
  change_chat_status: { chat_status: 'Atendimento' },
  send_notification: { name: 'Equipe de vendas', phone: '99900000001', country_code: '55', message: 'Novo lead: {full_name}' },
  evaluate_condition: { ruleType: 'all', conditions: [{ category: 'system', systemSubtype: 'weekday', weekday: 'monday', operator: 'equal' }] },
  distribute_contacts: {
    outputs: [
      { id: 'output_1', name: 'Saída 1', quantity: 0 },
      { id: 'output_2', name: 'Saída 2', quantity: 0 },
    ],
  },
  execute_flow: { target_flow_id: '7b0c2a4e-1f5d-4c39-9d6e-2a1b3c4d5e6f', target_flow_name: 'Pós-venda' },
  send_pixel_event: { tracking_type: 'Facebook', pixel_config_id: 'pixel_1', event_type: 'Lead', currency: 'BRL' },
  smart_interval: { schedule_type: 'time', interval_value: 2, interval_unit: 'hours' },
  set_department: { department_id: 'dep_1', department_name: 'Vendas' },
  make_http_request: { request_method: 'POST', request_url: 'https://example.test/hook?c={phone_number}', request_headers: { 'x-origem': 'crm' }, response_mapping: { status: 'data.status' } },
  ai_call: {
    provider: 'gpt',
    api_key_source: 'manual',
    api_key: '{g_openai_key}',
    model: 'gpt-5.4-mini',
    user_message: '{last_user_message}',
    system_prompt: 'Responda de forma breve.',
    response_variable: 'ai.response',
    auto_send_response: true,
  },
  control_ai_agent: { mode: 'activate', agent_id: 'agent_1' },
  create_kanban_card: { crm_id: 'board_1', crm_name: 'Vendas', crm_column_id: 'col_1', crm_column_name: 'Novo' },
  remove_kanban_card: { crm_id: 'board_1' },
  set_contact_custom_field: { field_name: 'pontos', operation: 'add', value_type: 'number', value: '10' },
  set_created_at: { operation: 'set_value', value: '2026-10-15T12:00:00Z' },
  register_approved_sale: {
    product_public_id: 'prod_1',
    amount_template: '{comprovante.valor}',
    currency_template: '{comprovante.currency}',
    customer_name_template: '{comprovante.nome_pagador}',
  },
  create_payment_charge: {
    gateway: 'xpag',
    payment_integration_id: 'pi_1',
    currency: 'MXN',
    method: 'SPEI',
    amount: '100,00',
    open_amount: false,
    name: '{full_name}',
    phone: '{phone_number}',
    listener_ttl_value: 2,
    listener_ttl_unit: 'days',
  },
}

/** Configs claramente inválidas (campo obrigatório ausente/vazio ou valor fora do domínio), por 06 §3.6. */
const INVALID: Record<string, Record<string, unknown>> = {
  send_message: { message_text: '' },
  send_file: { file_url: 'https://example.test/x.pdf', media_source: 'url' },
  send_sticker: { sticker_url: 'https://example.test/x.webp', media_source: 'url' },
  send_contact: { contact_name: 'Suporte' },
  delay_between_messages: { delay_min_seconds: 10, delay_max_seconds: 500 },
  add_tags: { action: 'add', tags: [] },
  remove_tags: { action: 'remove', tags: [] },
  send_pix_button: { pix_type: 'EVP' },
  send_interactive_menu: { menuType: 'list', message: 'Escolha', buttonLabel: 'Ver', options: [] },
  send_option_list: { menuType: 'list', message: '', buttonLabel: 'Ver', options: [{ id: 'o1', title: 'A' }] },
  send_carousel: { text: 'Escolha', carousel: [] },
  wait_for_response: { wait_indefinitely: false, timeout_value: 32, timeout_unit: 'days' },
  change_chat_status: { chat_status: 'Arquivado' },
  send_notification: { name: 'Equipe', phone: '99900000001', country_code: '55' },
  evaluate_condition: { ruleType: 'talvez', conditions: [] },
  distribute_contacts: { outputs: [{ id: 'output_1', name: 'Saída 1', quantity: 0 }] },
  execute_flow: { target_flow_name: 'Sem destino' },
  send_pixel_event: { tracking_type: 'Facebook', event_type: 'Lead' },
  smart_interval: { schedule_type: 'time', interval_value: 0, interval_unit: 'hours' },
  set_department: { department_name: 'Vendas' },
  make_http_request: { request_method: 'POST' },
  control_ai_agent: { mode: 'activate' },
  create_kanban_card: { crm_id: 'board_1' },
  remove_kanban_card: {},
  set_contact_custom_field: { operation: 'add', value_type: 'number', value: '1' },
  register_approved_sale: { amount_template: '{comprovante.valor}' },
  // gateway da empresa de referência: fora de escopo (SPEC 8.4)
  create_payment_charge: { gateway: REF_GATEWAY, payment_integration_id: 'pi_1', currency: 'BRL', method: 'PIX', amount: '100,00' },
}

const SUPPORTED = Object.keys(EXAMPLES)

const schemaOf = (type: string) => {
  const s = F.getActionSchema(type)
  expect(s, `sem schema para ${type}`).toBeTruthy()
  expect(typeof s.safeParse, `schema de ${type} não é zod`).toBe('function')
  return s
}

const issues = (r: any) => JSON.stringify(r.error?.issues ?? r.error, null, 1)

/** Nó mínimo que hospeda a ação, usando o mapa NODE_ACTIONS (ações permitidas por tipo de nó). */
function hostNodeType(action: string): string {
  const map: Record<string, readonly string[]> = F.NODE_ACTIONS
  const entry = Object.entries(map).find(([nodeType, actions]) => nodeType !== 'unsupported' && actions.includes(action))
  if (!entry) throw new Error(`NODE_ACTIONS não tem nó que aceite ${action}`)
  return entry[0]
}

describe('catálogo de action types', () => {
  it('AC-T10-05 SUPPORTED_ACTION_TYPES contém todos os tipos suportados da SPEC e nenhum fora de escopo', () => {
    expect([...F.SUPPORTED_ACTION_TYPES].sort()).toEqual([...SUPPORTED].sort())
  })

  it('AC-T10-05 todo action type suportado tem schema zod (getActionSchema e ACTION_CONFIG_SCHEMAS)', () => {
    for (const t of F.SUPPORTED_ACTION_TYPES as string[]) {
      schemaOf(t)
      expect(F.ACTION_CONFIG_SCHEMAS?.[t], `ACTION_CONFIG_SCHEMAS.${t}`).toBeTruthy()
    }
  })

  it('AC-T10-05 o exemplo exportado (ACTION_EXAMPLES) de cada tipo passa no próprio schema', () => {
    for (const t of F.SUPPORTED_ACTION_TYPES as string[]) {
      const ex = F.ACTION_EXAMPLES?.[t]
      expect(ex, `ACTION_EXAMPLES.${t} ausente`).toBeTruthy()
      const r = schemaOf(t).safeParse(ex)
      expect(r.success, `${t}: ${issues(r)}`).toBe(true)
    }
  })
})

describe('schema por action type', () => {
  for (const type of SUPPORTED) {
    it(`AC-T10-05 ${type}: exemplo válido da spec passa no schema`, () => {
      const r = schemaOf(type).safeParse(EXAMPLES[type])
      expect(r.success, `${type}: ${issues(r)}`).toBe(true)
    })

    it(`AC-T10-05 ${type}: config que não é objeto é recusada${INVALID[type] ? ' e config inválida da spec também' : ''}`, () => {
      const s = schemaOf(type)
      for (const bad of ['texto', 42, null, []]) expect(s.safeParse(bad).success, `${type} aceitou ${JSON.stringify(bad)}`).toBe(false)
      if (INVALID[type]) expect(s.safeParse(INVALID[type]).success, `${type} aceitou config inválida ${JSON.stringify(INVALID[type])}`).toBe(false)
    })
  }

  it('AC-T10-05 cada exemplo da spec é aceito dentro de um fluxo (validate sem erros)', () => {
    for (const type of SUPPORTED) {
      const nodeType = hostNodeType(type)
      const actions: Array<[string, Record<string, unknown>]> =
        type === 'save_user_data' ? [['send_interactive_menu', EXAMPLES.send_interactive_menu!], [type, EXAMPLES[type]!]] : [[type, EXAMPLES[type]!]]
      const host = type === 'save_user_data' ? 'interactive_menu' : nodeType
      const def = flow([node('start', 'start'), msg('m1'), node('x', host, actions)], [edge('start', 'source', 'm1'), edge('m1', 'source', 'x')])
      const errors = F.validate(def)
      expect(errors, `${type} em nó ${host}: ${fmt(errors)}`).toEqual([])
    }
  })

  it('AC-T10-05 config inválida dentro do fluxo vira invalid_action_config no nó', () => {
    for (const type of Object.keys(INVALID)) {
      const host = hostNodeType(type)
      const def = flow([node('start', 'start'), msg('m1'), node('x', host, [[type, INVALID[type]!]])], [edge('start', 'source', 'm1'), edge('m1', 'source', 'x')])
      const errors = F.validate(def)
      expect(
        errors.some((e: any) => e.code === 'invalid_action_config' && e.nodeId === 'x'),
        `${type} em nó ${host}: ${fmt(errors)}`,
      ).toBe(true)
    }
  })
})
