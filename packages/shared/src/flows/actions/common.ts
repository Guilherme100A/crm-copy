import { z } from 'zod'

// Peças comuns dos configs de ação (spec/features/06-fluxos.md §3.6). Nomes de campo literais da referência.

export const TIME_UNITS = ['seconds', 'minutes', 'hours', 'days'] as const
export type TimeUnit = (typeof TIME_UNITS)[number]
export const timeUnit = z.enum(TIME_UNITS)

const UNIT_SECONDS: Record<TimeUnit, number> = { seconds: 1, minutes: 60, hours: 3600, days: 86_400 }
/** Prazo máximo de esperas e intervalos: 31 dias (06 §3.6). */
export const MAX_WAIT_SECONDS = 31 * 86_400

export const toSeconds = (value: number, unit: TimeUnit) => value * UNIT_SECONDS[unit]

/** Texto obrigatório (não vazio depois de aparar). */
export const requiredText = z.string().trim().min(1)
export const optionalText = z.string().optional()

/** Número ou texto com variáveis (`{valor}`), como nos campos "aceita variável". */
export const numberOrTemplate = z.union([z.number(), requiredText])

export const mediaSource = z.enum(['file', 'url'])

/** Inteiro >= 0 opcional (delays em segundos). */
export const seconds = z.number().int().min(0)

/** Adiciona erro se `value unit` passar de 31 dias. `minValue` 0 permite "0 = padrão". */
export function checkTimeout(
  ctx: z.RefinementCtx,
  value: number | undefined,
  unit: TimeUnit | undefined,
  path: [string, string] = ['timeout_value', 'timeout_unit'],
) {
  if (value === undefined) return
  if (toSeconds(value, unit ?? 'seconds') > MAX_WAIT_SECONDS) {
    ctx.addIssue({ code: 'custom', message: 'prazo máximo é 31 dias', path: [path[0]] })
  }
}

/** Ids estáveis de opção/saída/botão: únicos dentro da lista. */
export function checkUniqueIds(ctx: z.RefinementCtx, items: readonly { id?: string }[], path: string) {
  const seen = new Set<string>()
  items.forEach((item, i) => {
    if (!item.id) return
    if (seen.has(item.id)) ctx.addIssue({ code: 'custom', message: `id repetido: ${item.id}`, path: [path, i, 'id'] })
    seen.add(item.id)
  })
}

/** Id estável usado em handles (`option:<id>`, `output:<id>`): sem `:` nem espaços. */
export const handleId = z.string().regex(/^[^\s:]+$/, 'id inválido para handle')
