import type { ActionConfig, SupportedActionType } from './actions'

// Um config válido por action type: base de testes, defaults do editor e documentação viva (AC-T10-05).
export const ACTION_EXAMPLES: { [T in SupportedActionType]: ActionConfig<T> } = {
  send_message: { message_text: 'Olá {first_name}! Como posso ajudar?', typing_delay_seconds: 2 },
  send_multi_media: { media_type: 'image', media_source: 'url', media_url: 'https://example.com/foto.jpg', messages: [{ caption: 'Nosso catálogo' }] },
  send_file: { file_name: 'catalogo.pdf', file_url: 'https://example.com/catalogo.pdf', media_source: 'url' },
  send_sticker: { sticker_name: 'ola.webp', sticker_url: 'https://example.com/ola.webp', media_source: 'url' },
  send_contact: { contact_name: 'Suporte', contact_phone: '+5511999990000' },
  delay_between_messages: { delay_min_seconds: 2, delay_max_seconds: 8 },
  add_tags: { action: 'add', tags: ['lead'] },
  remove_tags: { action: 'remove', tags: ['frio'] },
  send_pix_button: { pix_key: 'contato@example.com', pix_type: 'EMAIL', merchant_name: 'Loja', amount_reais: '49,90' },
  send_interactive_menu: {
    menuType: 'list',
    message: 'Como posso ajudar?',
    buttonLabel: 'Ver opções',
    options: [
      { id: 'option_1', title: 'Comprar' },
      { id: 'option_2', title: 'Suporte' },
    ],
    timeout_value: 2,
    timeout_unit: 'hours',
  },
  send_option_list: { menuType: 'list', message: 'Escolha', buttonLabel: 'Opções', options: [{ id: 'option_1', title: 'Sim' }] },
  save_user_data: { field_name: 'interesse', save_empty: true },
  send_carousel: {
    text: 'Escolha uma opção abaixo',
    gatilho: { timeout_value: 1, timeout_unit: 'days' },
    carousel: [{ card_id: 'card_1', text: 'Plano Básico', media_kind: 'image', image: 'https://example.com/basico.jpg', buttons: [{ id: 'btn_basico', text: 'Quero', type: 'REPLY' }] }],
  },
  wait_for_response: { timeout_value: 30, timeout_unit: 'minutes' },
  change_chat_status: { chat_status: 'Atendimento' },
  send_notification: { name: 'Equipe', phone: '11999990000', country_code: '55', message: 'Novo lead: {full_name}' },
  evaluate_condition: { ruleType: 'any', conditions: [{ category: 'field', fieldName: 'email', operator: 'has_value' }] },
  distribute_contacts: {
    outputs: [
      { id: 'output_1', name: 'Saída 1', quantity: 0 },
      { id: 'output_2', name: 'Saída 2', quantity: 0 },
    ],
  },
  execute_flow: { target_flow_id: 'flow_1', target_flow_name: 'Pós-venda' },
  send_pixel_event: { pixel_config_id: 'pixel_1', event_type: 'Compra', item_value: '{venda.valor}', currency: 'BRL' },
  smart_interval: {
    schedule_type: 'weekly',
    weekly_schedule: { monday: { enabled: true, start_time: '09:00', end_time: '18:00' } },
  },
  set_department: { department_id: 'dep_1', department_name: 'Vendas' },
  make_http_request: { request_method: 'GET', request_url: 'https://example.com/api?tel={phone_number}', response_mapping: { status: 'data.status' } },
  ai_call: {
    provider: 'gpt',
    model: 'gpt-5.4-mini',
    user_message: '{last_user_message}',
    output_conditions: [{ prompt: 'Cliente quer comprar', output_key: 'compra' }],
    fallback_output_key: 'fallback',
  },
  control_ai_agent: { mode: 'deactivate' },
  create_kanban_card: { crm_id: 'board_1', crm_column_id: 'col_1' },
  remove_kanban_card: { crm_id: 'board_1' },
  set_contact_custom_field: { field_name: 'pontos', operation: 'add', value_type: 'number', value: 10 },
  set_created_at: { operation: 'set_value', value: '15/10/2026 12:00:00' },
  register_approved_sale: { product_public_id: 'prod_1', amount_template: '{comprovante.valor}' },
  create_payment_charge: { gateway: 'zenith', payment_integration_id: 'pi_1', currency: 'BRL', method: 'pix', amount: '100,00', listener_ttl_value: 2, listener_ttl_unit: 'days' },
}
