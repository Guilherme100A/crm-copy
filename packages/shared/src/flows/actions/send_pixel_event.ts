import { z } from 'zod'
import { numberOrTemplate, requiredText } from './common'

// Evento de Pixel (Conversions API, T104). Compra exige valor.
export const sendPixelEventConfig = z
  .object({
    tracking_type: z.string().optional(),
    pixel_config_id: requiredText,
    pixel_config_name: z.string().optional(),
    event_type: z.enum(['Compra', 'Lead']),
    item_value: numberOrTemplate.optional(),
    page_id: z.string().optional(),
    currency: z.string().optional(),
  })
  .superRefine((c, ctx) => {
    if (c.event_type === 'Compra' && c.item_value === undefined) ctx.addIssue({ code: 'custom', message: 'valor obrigatório para Compra', path: ['item_value'] })
  })
