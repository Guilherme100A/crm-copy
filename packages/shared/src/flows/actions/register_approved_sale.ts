import { z } from 'zod'
import { requiredText } from './common'

// Venda aprovada (suportada, revisão 1): valores por template a partir do comprovante.
export const registerApprovedSaleConfig = z.object({
  product_public_id: requiredText,
  amount_template: z.string().optional(),
  currency_template: z.string().optional(),
  customer_name_template: z.string().optional(),
  note_issuer_id: z.string().nullish(),
  utmify_integration_id: z.string().nullish(),
  push_title_template: z.string().optional(),
  push_body_template: z.string().optional(),
})
