import { z } from 'zod'
import { handleId } from './common'

// Bloco de IA (06 §3.6). `platform` = créditos de IA da empresa (no lugar do provedor próprio da referência).
export const AI_CALL_PROVIDERS = ['gpt', 'gemini', 'openrouter', 'platform'] as const
export const MAX_AI_OUTPUT_CONDITIONS = 10
export const MAX_EXPECTED_RECEIPT_VALUES = 5
export const MAX_AI_CONTEXT_INTERACTIONS = 20

export const aiCallConfig = z
  .object({
    provider: z.enum(AI_CALL_PROVIDERS).optional(),
    api_key_source: z.enum(['manual', 'integration']).optional(),
    api_key: z.string().optional(),
    ai_integration_id: z.string().nullish(),
    model: z.string().optional(),
    user_message: z.string().optional(),
    system_prompt: z.string().optional(),
    response_variable: z.string().optional(),
    fail_reason_variable: z.string().optional(),
    auto_send_response: z.boolean().optional(),
    maintain_context: z.boolean().optional(),
    context_interactions: z.number().int().min(1).max(MAX_AI_CONTEXT_INTERACTIONS).optional(),
    understand_audio: z.boolean().optional(),
    understand_image: z.boolean().optional(),
    understand_pdf: z.boolean().optional(),
    understand_receipt: z.boolean().optional(),
    validate_receipt_pix_key: z.boolean().optional(),
    expected_pix_keys: z.array(z.string()).max(MAX_EXPECTED_RECEIPT_VALUES).optional(),
    validate_receipt_recipient: z.boolean().optional(),
    expected_recipient_names: z.array(z.string()).max(MAX_EXPECTED_RECEIPT_VALUES).optional(),
    output_conditions: z
      .array(z.object({ prompt: z.string().trim().min(1).max(200), output_key: handleId }))
      .max(MAX_AI_OUTPUT_CONDITIONS)
      .optional(),
    fallback_output_key: handleId.optional(),
  })
  .superRefine((c, ctx) => {
    if (c.api_key_source === 'integration' && !c.ai_integration_id) ctx.addIssue({ code: 'custom', message: 'escolha a integração', path: ['ai_integration_id'] })
    if (c.output_conditions?.length && !c.fallback_output_key) ctx.addIssue({ code: 'custom', message: 'saída padrão obrigatória', path: ['fallback_output_key'] })
    const keys = (c.output_conditions ?? []).map((o) => o.output_key)
    if (c.fallback_output_key) keys.push(c.fallback_output_key)
    if (new Set(keys).size !== keys.length) ctx.addIssue({ code: 'custom', message: 'nomes de saída repetidos', path: ['output_conditions'] })
  })
