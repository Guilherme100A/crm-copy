import { z } from 'zod'
import { numberOrTemplate, requiredText } from './common'

// Evento de Pixel (Conversions API, T104). Compra exige valor. Revisão 3: além de Compra e Lead (os do Leona), os
// eventos padrão da Meta InitiateCheckout, AddToCart, CompleteRegistration, Contact, Schedule e Subscribe, com valor e
// moeda opcionais. `Compra` é o nome legado (Leona) do `Purchase`.
export const PIXEL_EVENT_TYPES = ['Compra', 'Lead', 'InitiateCheckout', 'AddToCart', 'CompleteRegistration', 'Contact', 'Schedule', 'Subscribe'] as const
export type PixelEventType = (typeof PIXEL_EVENT_TYPES)[number]

export const sendPixelEventConfig = z
  .object({
    tracking_type: z.string().optional(),
    pixel_config_id: requiredText,
    pixel_config_name: z.string().optional(),
    event_type: z.enum(PIXEL_EVENT_TYPES),
    item_value: numberOrTemplate.optional(),
    // Opcionais (como no Leona): sobrepõem a Página/WABA do pixel no modo business_messaging. Aceitam variável.
    page_id: z.string().optional(),
    whatsapp_business_account_id: z.string().optional(),
    currency: z.string().optional(),
  })
  .superRefine((c, ctx) => {
    if (c.event_type === 'Compra' && c.item_value === undefined) ctx.addIssue({ code: 'custom', message: 'valor obrigatório para Compra', path: ['item_value'] })
  })
