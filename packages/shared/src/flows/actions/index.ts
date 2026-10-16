import type { z } from 'zod'
import { addTagsConfig } from './add_tags'
import { aiCallConfig } from './ai_call'
import { changeChatStatusConfig } from './change_chat_status'
import { controlAiAgentConfig } from './control_ai_agent'
import { createKanbanCardConfig } from './create_kanban_card'
import { createPaymentChargeConfig } from './create_payment_charge'
import { delayBetweenMessagesConfig } from './delay_between_messages'
import { distributeContactsConfig } from './distribute_contacts'
import { evaluateConditionConfig } from './evaluate_condition'
import { executeFlowConfig } from './execute_flow'
import { makeHttpRequestConfig } from './make_http_request'
import { registerApprovedSaleConfig } from './register_approved_sale'
import { removeKanbanCardConfig } from './remove_kanban_card'
import { removeTagsConfig } from './remove_tags'
import { saveUserDataConfig } from './save_user_data'
import { sendCarouselConfig } from './send_carousel'
import { sendContactConfig } from './send_contact'
import { sendFileConfig } from './send_file'
import { sendInteractiveMenuConfig } from './send_interactive_menu'
import { sendMessageConfig } from './send_message'
import { sendMultiMediaConfig } from './send_multi_media'
import { sendNotificationConfig } from './send_notification'
import { sendOptionListConfig } from './send_option_list'
import { sendPixButtonConfig } from './send_pix_button'
import { sendPixelEventConfig } from './send_pixel_event'
import { sendStickerConfig } from './send_sticker'
import { setContactCustomFieldConfig } from './set_contact_custom_field'
import { setCreatedAtConfig } from './set_created_at'
import { setDepartmentConfig } from './set_department'
import { smartIntervalConfig } from './smart_interval'
import { waitForResponseConfig } from './wait_for_response'

// Um schema zod por `action_type` suportado (SPEC T10; 06 §3.6, sem os itens fora de escopo da SPEC 8).
export const ACTION_CONFIG_SCHEMAS = {
  send_message: sendMessageConfig,
  send_multi_media: sendMultiMediaConfig,
  send_file: sendFileConfig,
  send_sticker: sendStickerConfig,
  send_contact: sendContactConfig,
  delay_between_messages: delayBetweenMessagesConfig,
  add_tags: addTagsConfig,
  remove_tags: removeTagsConfig,
  send_pix_button: sendPixButtonConfig,
  send_interactive_menu: sendInteractiveMenuConfig,
  send_option_list: sendOptionListConfig,
  save_user_data: saveUserDataConfig,
  send_carousel: sendCarouselConfig,
  wait_for_response: waitForResponseConfig,
  change_chat_status: changeChatStatusConfig,
  send_notification: sendNotificationConfig,
  evaluate_condition: evaluateConditionConfig,
  distribute_contacts: distributeContactsConfig,
  execute_flow: executeFlowConfig,
  send_pixel_event: sendPixelEventConfig,
  smart_interval: smartIntervalConfig,
  set_department: setDepartmentConfig,
  make_http_request: makeHttpRequestConfig,
  ai_call: aiCallConfig,
  control_ai_agent: controlAiAgentConfig,
  create_kanban_card: createKanbanCardConfig,
  remove_kanban_card: removeKanbanCardConfig,
  set_contact_custom_field: setContactCustomFieldConfig,
  set_created_at: setCreatedAtConfig,
  register_approved_sale: registerApprovedSaleConfig,
  create_payment_charge: createPaymentChargeConfig,
} as const satisfies Record<string, z.ZodType>

export type SupportedActionType = keyof typeof ACTION_CONFIG_SCHEMAS
export type ActionConfig<T extends SupportedActionType> = z.infer<(typeof ACTION_CONFIG_SCHEMAS)[T]>

export const SUPPORTED_ACTION_TYPES = Object.keys(ACTION_CONFIG_SCHEMAS) as SupportedActionType[]

/** Fora de escopo (SPEC 8.2–8.4): só aparecem dentro de nós `unsupported`. */
export const UNSUPPORTED_ACTION_TYPES = ['kieai_generate', 'make_call', 'send_template'] as const

export const isSupportedActionType = (type: string): type is SupportedActionType => Object.hasOwn(ACTION_CONFIG_SCHEMAS, type)

export function getActionSchema(type: string): z.ZodType | undefined {
  return isSupportedActionType(type) ? ACTION_CONFIG_SCHEMAS[type] : undefined
}

export * from './common'
export { PIX_TYPES } from './send_pix_button'
export { MENU_TYPES } from './menu-options'
export { CHAT_STATUS_VALUES } from './change_chat_status'
export { CONDITION_CATEGORIES, CONDITION_OPERATORS, SYSTEM_SUBTYPES, WEEKDAYS } from './evaluate_condition'
export { MAX_MESSAGE_DELAY_SECONDS } from './delay_between_messages'
export { MAX_CAROUSEL_BUTTONS, MAX_CAROUSEL_CARDS } from './send_carousel'
export { AI_CALL_PROVIDERS, MAX_AI_OUTPUT_CONDITIONS } from './ai_call'
export { PAYMENT_GATEWAYS } from './create_payment_charge'
