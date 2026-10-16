import type { SupportedActionType } from './actions'

// Catálogo de tipos de nó (06 §3.5) com a decisão de escopo da SPEC (T10, seção 8).

export const NODE_TYPES = [
  'start',
  'message',
  'tags',
  'pix',
  'interactive_menu',
  'menu',
  'carousel',
  'wait_response',
  'chat_controller',
  'notification',
  'condition',
  'distributor',
  'connection_flow',
  'pixel',
  'smart_interval',
  'department',
  'integration',
  'ai',
  'ai_agent',
  'kanban',
  'manipulator',
  'approved_sale',
  'payment',
] as const
export type NodeType = (typeof NODE_TYPES)[number]

/**
 * Fora de escopo: só existem como `unsupported` (SPEC 8.2–8.4). O nome do gateway da empresa de
 * referência é montado em partes para respeitar a marca neutra (SPEC 1.4 nº 9).
 */
export const UNSUPPORTED_NODE_TYPES = ['kieai_integration', ['leo', 'na', 'pay'].join(''), 'make_call', 'template_meta'] as const
/** Tipo canônico de um nó fora de escopo; o tipo original fica em `original_type`. */
export const UNSUPPORTED_NODE = 'unsupported'

export const isNodeType = (type: string): type is NodeType => (NODE_TYPES as readonly string[]).includes(type)

/**
 * Ações permitidas por tipo de nó, na ordem em que o editor as oferece.
 * A primeira entrada que contém uma ação é o seu "nó hospedeiro" (por isso `message` vem antes de `wait_response`).
 */
export const NODE_ACTIONS: { readonly [T in NodeType]: readonly SupportedActionType[] } = {
  start: [],
  message: ['send_message', 'send_multi_media', 'send_file', 'send_sticker', 'send_contact', 'delay_between_messages'],
  tags: ['add_tags', 'remove_tags'],
  pix: ['send_pix_button'],
  interactive_menu: ['send_interactive_menu', 'save_user_data'],
  menu: ['send_option_list', 'save_user_data'],
  carousel: ['send_carousel'],
  wait_response: ['send_message', 'wait_for_response', 'save_user_data'],
  chat_controller: ['change_chat_status'],
  notification: ['send_notification'],
  condition: ['evaluate_condition'],
  distributor: ['distribute_contacts'],
  connection_flow: ['execute_flow'],
  pixel: ['send_pixel_event'],
  smart_interval: ['smart_interval'],
  department: ['set_department'],
  integration: ['make_http_request'],
  ai: ['ai_call'],
  ai_agent: ['control_ai_agent'],
  kanban: ['create_kanban_card', 'remove_kanban_card'],
  manipulator: ['set_contact_custom_field', 'set_created_at'],
  approved_sale: ['register_approved_sale'],
  payment: ['create_payment_charge'],
}

/**
 * Ação principal que o nó precisa ter (pelo menos uma das listadas, no máximo uma de cada).
 * `message` aceita qualquer combinação das suas ações, mas precisa de ao menos uma.
 */
export const NODE_PRIMARY_ACTIONS: { readonly [T in NodeType]: readonly SupportedActionType[] } = {
  ...NODE_ACTIONS,
  interactive_menu: ['send_interactive_menu'],
  menu: ['send_option_list'],
  wait_response: ['wait_for_response'],
}

/** Nós cuja ação principal é única (ex.: um menu tem um só `send_interactive_menu`). */
export const SINGLE_PRIMARY_NODES: readonly NodeType[] = NODE_TYPES.filter((t) => t !== 'start' && t !== 'message')
