// Horário de atendimento (T31; 16 §3.3): função pura, no fuso da empresa. Intervalos `[início, fim)`:
// o minuto final já é fechado. `24:00` vale como fim do dia; intervalo que cruza a meia-noite não existe.

export interface BusinessHourInterval {
  /** 0 = domingo … 6 = sábado. */
  day_of_week: number
  /** `HH:MM`. */
  start_time: string
  /** `HH:MM` (> início; `24:00` = fim do dia). */
  end_time: string
  active?: boolean
}

export interface BusinessHoursConfigLike {
  active: boolean
  business_hours: readonly BusinessHourInterval[]
}

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$|^24:00$/

/** Minutos desde 00:00 (`24:00` → 1440); `null` se inválido. */
export function parseTime(value: string): number | null {
  if (typeof value !== 'string' || !TIME_RE.test(value)) return null
  const [h, m] = value.split(':').map(Number) as [number, number]
  return h * 60 + m
}

const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }

/** Dia da semana (0–6) e minuto do dia de `at` no fuso `timeZone`. */
export function localDayMinute(at: Date, timeZone: string): { day: number; minute: number } {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(at)
  const get = (t: string) => parts.find((p) => p.type === t)!.value
  return { day: WEEKDAYS[get('weekday')]!, minute: Number(get('hour')) * 60 + Number(get('minute')) }
}

/**
 * Aberto agora? Config inativa = sempre aberto (o sistema de horários está desligado).
 * Intervalos inativos ou inválidos são ignorados.
 */
export function isOpen(config: BusinessHoursConfigLike, now: Date, timeZone: string): boolean {
  if (!config.active) return true
  const { day, minute } = localDayMinute(now, timeZone)
  for (const h of config.business_hours) {
    if (h.active === false || h.day_of_week !== day) continue
    const start = parseTime(h.start_time)
    const end = parseTime(h.end_time)
    if (start === null || end === null || end <= start) continue
    if (minute >= start && minute < end) return true
  }
  return false
}

/** Erros de um intervalo (`{ campo: mensagem }`), vazio se válido. */
export function intervalErrors(h: Partial<BusinessHourInterval>): Partial<Record<keyof BusinessHourInterval, string>> {
  const errors: Partial<Record<keyof BusinessHourInterval, string>> = {}
  if (!Number.isInteger(h.day_of_week) || (h.day_of_week as number) < 0 || (h.day_of_week as number) > 6) errors.day_of_week = 'Dia da semana de 0 (domingo) a 6 (sábado)'
  const start = parseTime(h.start_time as string)
  const end = parseTime(h.end_time as string)
  if (start === null || start === 1440) errors.start_time = 'Horário inválido (HH:MM)'
  if (end === null) errors.end_time = 'Horário inválido (HH:MM)'
  else if (start !== null && end <= start) errors.end_time = 'O fim precisa ser depois do início'
  return errors
}
