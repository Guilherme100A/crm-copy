import { z } from 'zod'

// Condicional: regras E/OU sobre sistema, atendimento, atendente, campos e variáveis (06 §3.6).
export const CONDITION_CATEGORIES = ['system', 'attendance', 'attendant', 'field', 'custom_field', 'global_variable'] as const
export const SYSTEM_SUBTYPES = ['tag', 'weekday', 'time', 'date', 'message_window'] as const
export const WEEKDAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'] as const
export const CONDITION_OPERATORS = [
  'equal',
  'different',
  'before',
  'during',
  'after',
  'open',
  'closed',
  'contains',
  'not_contains',
  'starts_with',
  'has_value',
  'type',
  'greater_than',
  'less_than',
  'greater_or_equal',
  'less_or_equal',
  'numeric_equal',
] as const

const condition = z
  .object({
    category: z.enum(CONDITION_CATEGORIES),
    systemSubtype: z.enum(SYSTEM_SUBTYPES).optional(),
    operator: z.enum(CONDITION_OPERATORS).optional(),
    tagName: z.string().optional(),
    tagId: z.string().optional(),
    weekday: z.enum(WEEKDAYS).optional(),
    time: z.number().int().min(0).max(23).optional(),
    timeMinute: z.number().int().min(0).max(59).optional(),
    date: z.string().optional(),
    attendanceStatus: z.enum(['waiting', 'in_progress', 'resolved']).optional(),
    user_ids: z.array(z.string()).optional(),
    fieldName: z.string().optional(),
    // Aceita variáveis `{...}`; números com vírgula ou ponto.
    value: z.union([z.string(), z.number()]).optional(),
  })
  .superRefine((c, ctx) => {
    const need = (ok: unknown, path: string, message: string) => {
      if (!ok) ctx.addIssue({ code: 'custom', message, path: [path] })
    }
    switch (c.category) {
      case 'system':
        need(c.systemSubtype, 'systemSubtype', 'subtipo obrigatório')
        if (c.systemSubtype === 'tag') need(c.tagName?.trim() || c.tagId, 'tagName', 'etiqueta obrigatória')
        if (c.systemSubtype === 'weekday') need(c.weekday, 'weekday', 'dia da semana obrigatório')
        if (c.systemSubtype === 'time') need(c.time !== undefined, 'time', 'hora obrigatória')
        if (c.systemSubtype === 'date') need(c.date?.trim(), 'date', 'data obrigatória')
        break
      case 'attendance':
        need(c.attendanceStatus, 'attendanceStatus', 'status obrigatório')
        break
      case 'attendant':
        need(c.user_ids?.length, 'user_ids', 'escolha ao menos um atendente')
        break
      default:
        need(c.fieldName?.trim(), 'fieldName', 'campo obrigatório')
        need(c.operator, 'operator', 'operador obrigatório')
    }
  })

export const evaluateConditionConfig = z.object({
  ruleType: z.enum(['all', 'any']),
  conditions: z.array(condition).min(1),
})
