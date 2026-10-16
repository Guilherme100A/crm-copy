import { z } from 'zod'
import { numberOrTemplate, requiredText } from './common'

// No clone o Pix vai como texto com chave copia-e-cola (SPEC 8.3); `pix_body`/`header_image_url` são da API oficial.
export const PIX_TYPES = ['EVP', 'CPF', 'CNPJ', 'PHONE', 'EMAIL'] as const

const FORMATS: Record<(typeof PIX_TYPES)[number], RegExp> = {
  EVP: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  CPF: /^\d{3}\.?\d{3}\.?\d{3}-?\d{2}$/,
  CNPJ: /^\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2}$/,
  PHONE: /^\+?\d{10,14}$/,
  EMAIL: /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
}

export const sendPixButtonConfig = z
  .object({
    pix_key: requiredText,
    pix_type: z.enum(PIX_TYPES).optional(),
    merchant_name: z.string().optional(),
    amount_reais: numberOrTemplate.optional(),
  })
  .superRefine((c, ctx) => {
    const key = c.pix_key.trim()
    // Chave com variável (`{g_pix}`) só é conferida em tempo de execução.
    if (key.includes('{')) return
    if (!FORMATS[c.pix_type ?? 'EVP'].test(key)) ctx.addIssue({ code: 'custom', message: 'chave Pix fora do formato do tipo', path: ['pix_key'] })
  })
