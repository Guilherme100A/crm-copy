import { z } from 'zod'
import { checkTimeout, timeUnit } from './common'

// Aguarda Resposta: prazo ≤ 31 dias, ou indefinido (sem handle `timeout`).
export const waitForResponseConfig = z
  .object({
    wait_indefinitely: z.boolean().optional(),
    timeout_value: z.number().int().min(1).optional(),
    timeout_unit: timeUnit.optional(),
    reply_to_lead_enabled: z.boolean().optional(),
    reply_to_lead_next_messages_count: z.number().int().min(1).max(5).optional(),
    react_to_lead_check_enabled: z.boolean().optional(),
    react_to_lead_reaction_emoji: z.string().optional(),
    buffer_enabled: z.boolean().optional(),
    buffer_value: z.number().int().min(1).max(300).optional(),
  })
  .superRefine((c, ctx) => {
    if (c.wait_indefinitely) return
    checkTimeout(ctx, c.timeout_value, c.timeout_unit)
  })
