import { z } from 'zod'
import { checkTimeout, checkUniqueIds, handleId, requiredText, timeUnit, type TimeUnit } from './common'

// Estrutura compartilhada por `send_interactive_menu` e o legado `send_option_list` (06 §3.6).
// No clone o menu é enviado como texto numerado (SPEC 3.8 / 8.3); `menuType` só orienta o editor.
export const MENU_TYPES = ['list', 'button', 'url', 'call'] as const

export const menuOption = z.object({
  // `id` estável: o handle é `option:<id>` e não muda ao reordenar. Legado sem id é completado pelo `migrate`.
  id: handleId.optional(),
  title: requiredText,
  description: z.string().optional(),
  type: z.enum(['REPLY', 'URL', 'COPY', 'CALL']).optional(),
})

export const menuConfigShape = {
  menuType: z.enum(MENU_TYPES),
  message: requiredText,
  buttonLabel: z.string().optional(),
  footerText: z.string().optional(),
  imageButtonEnabled: z.boolean().optional(),
  imageButtonSource: z.string().optional(),
  imageButton: z.string().optional(),
  options: z.array(menuOption).min(1),
  // 0 = padrão de 2 dias.
  timeout_value: z.number().int().min(0).optional(),
  timeout_unit: timeUnit.optional(),
}

interface MenuLike {
  menuType: (typeof MENU_TYPES)[number]
  buttonLabel?: string
  options: { id?: string }[]
  timeout_value?: number
  timeout_unit?: TimeUnit
}

export function checkMenu(c: MenuLike, ctx: z.RefinementCtx) {
  if (c.menuType === 'list' && !c.buttonLabel?.trim()) ctx.addIssue({ code: 'custom', message: 'texto do botão obrigatório', path: ['buttonLabel'] })
  checkUniqueIds(ctx, c.options, 'options')
  checkTimeout(ctx, c.timeout_value, c.timeout_unit)
}
