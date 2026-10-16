// Validação dos horários no cliente, igual à do servidor (`intervalErrors`/`parseTime` em
// `packages/core/src/business-hours/is-open.ts` e `BusinessHoursService.put`; a web não importa `@crm/core`).
// Os erros saem com os mesmos paths do 422 (`business_hours.<i>.<campo>`, `message_text`, `flow_id`).

export const MAX_INTERVALS = 70
export const DEFAULT_START = '09:00'
export const DEFAULT_END = '18:00'
export const DAYS = [0, 1, 2, 3, 4, 5, 6] as const

export type ActionType = 'message' | 'flow'

export interface Interval {
  day_of_week: number
  start_time: string
  end_time: string
  active: boolean
}

export interface HoursForm {
  active: boolean
  action_type: ActionType
  message_text: string
  flow_id: string
  business_hours: Interval[]
}

/** Código do erro → chave i18n (`errors.<código>`). */
export type HoursError = 'day' | 'time' | 'endBeforeStart' | 'messageRequired' | 'flowRequired' | 'tooMany'

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$|^24:00$/

/** Minutos desde 00:00 (`24:00` → 1440); `null` se inválido. */
export function parseTime(value: string): number | null {
  if (typeof value !== 'string' || !TIME_RE.test(value)) return null
  const [h, m] = value.split(':').map(Number) as [number, number]
  return h * 60 + m
}

export function intervalErrors(
  h: Partial<Interval>,
): Partial<Record<'day_of_week' | 'start_time' | 'end_time', HoursError>> {
  const errors: Partial<Record<'day_of_week' | 'start_time' | 'end_time', HoursError>> = {}
  if (!Number.isInteger(h.day_of_week) || (h.day_of_week as number) < 0 || (h.day_of_week as number) > 6)
    errors.day_of_week = 'day'
  const start = parseTime(h.start_time as string)
  const end = parseTime(h.end_time as string)
  if (start === null || start === 1440) errors.start_time = 'time'
  if (end === null) errors.end_time = 'time'
  else if (start !== null && end <= start) errors.end_time = 'endBeforeStart'
  return errors
}

/** Todos os erros do formulário, por path do fio. Vazio = pode salvar. */
export function hoursErrors(f: HoursForm): Record<string, HoursError> {
  const out: Record<string, HoursError> = {}
  if (f.active && f.action_type === 'message' && !f.message_text.trim()) out.message_text = 'messageRequired'
  if (f.active && f.action_type === 'flow' && !f.flow_id) out.flow_id = 'flowRequired'
  if (f.business_hours.length > MAX_INTERVALS) out.business_hours = 'tooMany'
  f.business_hours.forEach((h, i) => {
    for (const [field, code] of Object.entries(intervalErrors(h))) out[`business_hours.${i}.${field}`] = code
  })
  return out
}

/** Novo intervalo do dia: padrão 09:00–18:00 (16 §3.3). */
export const newInterval = (day: number): Interval => ({
  day_of_week: day,
  start_time: DEFAULT_START,
  end_time: DEFAULT_END,
  active: true,
})

/** Acrescenta logo depois do último intervalo do dia, mantendo a lista agrupada por dia. */
export function addInterval(list: readonly Interval[], day: number): Interval[] {
  if (list.length >= MAX_INTERVALS) return [...list]
  let at = list.length
  for (let i = list.length - 1; i >= 0; i--) {
    if (list[i]!.day_of_week <= day) {
      at = i + 1
      break
    }
    at = i
  }
  return [...list.slice(0, at), newInterval(day), ...list.slice(at)]
}

/** Liga/desliga todos os intervalos do dia (toggle do dia). */
export const setDayActive = (list: readonly Interval[], day: number, active: boolean): Interval[] =>
  list.map((h) => (h.day_of_week === day ? { ...h, active } : h))

/** Corpo do `PUT /api/business-hours/:connectionId`. */
export function hoursPayload(f: HoursForm) {
  return {
    active: f.active,
    action_type: f.action_type,
    message_text: f.message_text.trim() ? f.message_text : null,
    flow_id: f.flow_id || null,
    business_hours: f.business_hours.map((h) => ({
      day_of_week: h.day_of_week,
      start_time: h.start_time,
      end_time: h.end_time,
      active: h.active,
    })),
  }
}

/** Ordem do servidor (posição) agrupada por dia, para a grade semanal. */
export const sortByDay = (list: readonly Interval[]): Interval[] =>
  [...list]
    .map((h, i) => ({ h, i }))
    .sort((a, b) => a.h.day_of_week - b.h.day_of_week || a.i - b.i)
    .map((x) => x.h)
