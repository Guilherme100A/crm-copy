import { z } from 'zod'
import { checkTimeout, requiredText, timeUnit } from './common'

// Pagamento (suportado, revisão 1) pelos gateways XPag e Zenith (T109–T111).
// O gateway próprio da empresa de referência está fora de escopo (SPEC 8.4) e é recusado pelo enum.
export const PAYMENT_GATEWAYS = ['xpag', 'zenith'] as const

export const createPaymentChargeConfig = z
  .object({
    gateway: z.enum(PAYMENT_GATEWAYS),
    payment_integration_id: requiredText,
    currency: z
      .string()
      .regex(/^[A-Z]{3}$/)
      .optional(),
    method: requiredText,
    amount: z.union([z.number().positive(), z.string()]).optional(),
    open_amount: z.boolean().optional(),
    name: z.string().optional(),
    phone: z.string().optional(),
    email: z.string().optional(),
    document: z.string().optional(),
    document_type: z.string().optional(),
    bank_code: z.string().optional(),
    address_street: z.string().optional(),
    address_number: z.string().optional(),
    address_district: z.string().optional(),
    address_city: z.string().optional(),
    address_state: z.string().optional(),
    address_postal_code: z.string().optional(),
    listener_ttl_value: z.number().int().min(1).optional(),
    listener_ttl_unit: timeUnit.optional(),
  })
  .superRefine((c, ctx) => {
    const amount = typeof c.amount === 'string' ? c.amount.trim() : c.amount
    if (!c.open_amount && (amount === undefined || amount === '')) ctx.addIssue({ code: 'custom', message: 'valor obrigatório', path: ['amount'] })
    checkTimeout(ctx, c.listener_ttl_value, c.listener_ttl_unit, ['listener_ttl_value', 'listener_ttl_unit'])
  })
