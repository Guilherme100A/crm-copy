import { z } from 'zod'
import { checkTimeout, checkUniqueIds, handleId, requiredText, timeUnit } from './common'

// No clone o carrossel vira imagens com legenda + menu numerado (SPEC 8.3); botões REPLY geram `option:<id>`.
export const MAX_CAROUSEL_CARDS = 10
export const MAX_CAROUSEL_BUTTONS = 3

const button = z.object({
  id: handleId,
  text: requiredText,
  type: z.enum(['REPLY', 'URL', 'COPY', 'CALL']),
  payload: z.string().optional(),
})

const card = z
  .object({
    card_id: z.string().optional(),
    text: requiredText,
    // Só imagem é válida (vídeo/documento dão erro na referência).
    media_kind: z.literal('image').optional(),
    media_source: z.enum(['file', 'url']).optional(),
    image: z.string().optional(),
    filename: z.string().optional(),
    buttons: z.array(button).max(MAX_CAROUSEL_BUTTONS).optional(),
  })
  .superRefine((c, ctx) => {
    if (!c.image?.trim()) ctx.addIssue({ code: 'custom', message: 'cada cartão precisa de imagem', path: ['image'] })
  })

export const sendCarouselConfig = z
  .object({
    text: requiredText,
    delay: z.number().int().min(0).optional(),
    readchat: z.boolean().optional(),
    readmessages: z.boolean().optional(),
    gatilho: z
      .object({
        timeout_value: z.number().int().min(0).optional(),
        timeout_unit: timeUnit.optional(),
        ttl_horas: z.number().int().min(1).max(720).optional(),
        fallback_unico: z.boolean().optional(),
        desarma_em_bloco_terminal: z.boolean().optional(),
      })
      .optional(),
    carousel: z.array(card).min(1).max(MAX_CAROUSEL_CARDS),
  })
  .superRefine((c, ctx) => {
    if (c.gatilho) checkTimeout(ctx, c.gatilho.timeout_value, c.gatilho.timeout_unit, ['gatilho', 'timeout_unit'])
    const buttons = c.carousel.flatMap((k) => k.buttons ?? [])
    checkUniqueIds(ctx, buttons, 'carousel')
    const replyTitles = buttons.filter((b) => b.type === 'REPLY').map((b) => b.text.trim().toLowerCase())
    if (new Set(replyTitles).size !== replyTitles.length) ctx.addIssue({ code: 'custom', message: 'títulos REPLY repetidos', path: ['carousel'] })
  })
