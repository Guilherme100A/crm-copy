// WebhookConfig dos webhooks de entrada (09-webhooks-entrada.md §3.2). Tudo opcional: o webhook nasce com `{}` e
// o mapeamento chega depois da escuta de exemplo. O processador (T81) é quem exige nome/telefone na hora de processar.
import { z } from 'zod'

const text = (max: number) => z.string().max(max)

export const webhookSegmentSchema = z.object({
  kind: z.enum(['literal', 'path'], 'Segmento inválido'),
  value: text(500),
})
export type WebhookSegment = z.infer<typeof webhookSegmentSchema>

const segments = z.array(webhookSegmentSchema).max(50)

export const CONDITION_OPERATORS = ['equal', 'different', 'contains', 'not_contains', 'starts_with', 'has_value'] as const

export const webhookConditionSchema = z.discriminatedUnion('category', [
  z.object({
    category: z.literal('system'),
    systemSubtype: z.literal('tag'),
    systemOperator: z.enum(['equal', 'different']),
    tagName: text(200).trim().min(1, 'Informe a etiqueta'),
  }),
  z.object({
    category: z.literal('field'),
    fieldName: z.enum(['name', 'phone', 'email']),
    fieldOperator: z.enum(CONDITION_OPERATORS),
    fieldValue: text(500).optional(),
  }),
  z.object({
    category: z.literal('custom_field'),
    fieldName: text(200).trim().min(1, 'Informe o campo'),
    fieldOperator: z.enum(CONDITION_OPERATORS),
    fieldValue: text(500).optional(),
  }),
])
export type WebhookCondition = z.infer<typeof webhookConditionSchema>

export const webhookKanbanActionSchema = z
  .object({
    action: z.enum(['create_kanban_card', 'remove_kanban_card']),
    crm_id: z.uuid('Kanban inválido'),
    crm_column_id: z.uuid('Etapa inválida').nullish(),
    /** Número ou variável `{caminho}`. */
    value: z.union([z.number(), text(200)]).nullish(),
  })
  .superRefine((a, ctx) => {
    if (a.action === 'create_kanban_card' && !a.crm_column_id) ctx.addIssue({ code: 'custom', path: ['crm_column_id'], message: 'Escolha a etapa' })
  })

export const inboundWebhookConfigSchema = z
  .object({
    field_paths: z
      .object({
        full_name: segments.optional(),
        phone: segments.optional(),
        email: segments.optional(),
      })
      .optional(),
    custom_field_mappings: z
      .array(z.object({ field_key: text(100).trim().min(1, 'Informe o campo'), segments }))
      .max(100)
      .optional(),
    add_tags: z.array(text(100).trim().min(1)).max(100).optional(),
    remove_tags: z.array(text(100).trim().min(1)).max(100).optional(),
    kanban_actions: z.array(webhookKanbanActionSchema).max(20).optional(),
    trigger_flow: z.boolean().optional(),
    flow_id: z.uuid('Fluxo inválido').nullish(),
    /** Número (8 últimos dígitos) ou variável `{caminho.do.campo}`. */
    connection_value: text(200).nullish(),
    /** Legado: `payload` + caminho equivale a `{caminho}`. */
    connection_source: text(50).nullish(),
    connection_path: text(500).nullish(),
    trigger_conditions: z
      .object({
        ruleType: z.enum(['all', 'any']),
        conditions: z.array(webhookConditionSchema).max(50),
      })
      .optional(),
  })
  .superRefine((c, ctx) => {
    if (!c.trigger_flow) return
    if (!c.flow_id) ctx.addIssue({ code: 'custom', path: ['flow_id'], message: 'Escolha o fluxo' })
    const legacy = c.connection_source === 'payload' && c.connection_path?.trim()
    if (!c.connection_value?.trim() && !legacy)
      ctx.addIssue({ code: 'custom', path: ['connection_value'], message: 'Informe o número da instância ou uma variável' })
  })
export type InboundWebhookConfig = z.infer<typeof inboundWebhookConfigSchema>
