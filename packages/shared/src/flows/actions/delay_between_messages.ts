import { z } from 'zod'

/** Atraso máximo entre mensagens: 120 s (06 §3.6). */
export const MAX_MESSAGE_DELAY_SECONDS = 120
const delay = z.number().int().min(0).max(MAX_MESSAGE_DELAY_SECONDS)

// Atraso fixo (`delay_seconds`) ou aleatório entre mínimo e máximo.
export const delayBetweenMessagesConfig = z
  .object({
    delay_seconds: delay.optional(),
    delay_min_seconds: delay.optional(),
    delay_max_seconds: delay.optional(),
  })
  .superRefine((c, ctx) => {
    if (c.delay_seconds === undefined && c.delay_min_seconds === undefined && c.delay_max_seconds === undefined) {
      ctx.addIssue({ code: 'custom', message: 'informe o atraso', path: ['delay_seconds'] })
    }
    if (c.delay_min_seconds !== undefined && c.delay_max_seconds !== undefined && c.delay_min_seconds > c.delay_max_seconds) {
      ctx.addIssue({ code: 'custom', message: 'mínimo maior que o máximo', path: ['delay_min_seconds'] })
    }
  })
