// Regras puras dos disparos em massa (T60; 10 §3.1): validação do formulário, período da cota e capacidade de
// warm-up das conexões (mesmo cronograma padrão do engine: 7 dias, 20 no dia 0, ×1,8 por dia).

export const MAX_INTERVAL_SECONDS = 120
export const DEFAULT_WINDOW = { start: '08:00', end: '18:00' } as const
export const DEFAULT_INTERVAL = { min: 5, max: 30 } as const

export class MassDispatchError extends Error {
  constructor(
    readonly code: 'invalid' | 'not_found' | 'session_not_connected' | 'quota_exceeded' | 'invalid_transition',
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message)
    this.name = 'MassDispatchError'
  }
}

export const fieldError = (path: string, message: string) => new MassDispatchError('invalid', message, { fields: [{ path, message }] })

export interface ScheduleInput {
  weekdays?: unknown
  window_start?: unknown
  window_end?: unknown
  time_zone?: unknown
  interval_min_seconds?: unknown
  interval_max_seconds?: unknown
  daily_limit?: unknown
  starts_scheduling_at?: unknown
}

export interface Schedule {
  weekdays: number[]
  windowStart: string
  windowEnd: string
  timeZone: string
  intervalMinSeconds: number
  intervalMaxSeconds: number
  dailyLimit: number | null
  startsSchedulingAt: Date
}

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/

function int(raw: unknown, path: string, def?: number): number | undefined {
  if (raw === undefined || raw === null || raw === '') return def
  const n = typeof raw === 'number' ? raw : Number(String(raw).trim())
  if (!Number.isInteger(n)) throw fieldError(path, 'número inteiro esperado')
  return n
}

/** `[1,2]`, `'1,2'`, `'[1,2]'` ou `['1','2']` → dias 0–6 sem repetição. */
export function parseWeekdays(raw: unknown): number[] {
  let list: unknown[]
  if (Array.isArray(raw)) list = raw
  else if (typeof raw === 'string' && raw.trim().startsWith('[')) {
    try {
      list = JSON.parse(raw) as unknown[]
    } catch {
      throw fieldError('weekdays', 'lista inválida')
    }
  } else if (raw === undefined || raw === null || raw === '') list = []
  else list = String(raw).split(',')
  const days = new Set<number>()
  for (const v of list) {
    const s = String(v).trim()
    if (!s) continue
    const d = Number(s)
    if (!Number.isInteger(d) || d < 0 || d > 6) throw fieldError('weekdays', `dia inválido: ${s}`)
    days.add(d)
  }
  return [...days].sort((a, b) => a - b)
}

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz })
    return true
  } catch {
    return false
  }
}

/** Formulário → agenda validada (janela vazia, sem dias ou intervalo invertido → erro de validação). */
export function parseSchedule(input: ScheduleInput, defaults: { timeZone: string; now: Date }): Schedule {
  const weekdays = parseWeekdays(input.weekdays)
  if (!weekdays.length) throw fieldError('weekdays', 'Selecione ao menos um dia da semana')
  const windowStart = input.window_start === undefined || input.window_start === '' ? DEFAULT_WINDOW.start : String(input.window_start).trim()
  const windowEnd = input.window_end === undefined || input.window_end === '' ? DEFAULT_WINDOW.end : String(input.window_end).trim()
  if (!HHMM.test(windowStart)) throw fieldError('window_start', 'Horário inválido (HH:MM)')
  if (!HHMM.test(windowEnd)) throw fieldError('window_end', 'Horário inválido (HH:MM)')
  if (windowStart >= windowEnd) throw fieldError('window_end', 'A janela de envio está vazia: o fim deve ser depois do início')
  const timeZone = input.time_zone === undefined || input.time_zone === '' ? defaults.timeZone : String(input.time_zone).trim()
  if (!isValidTimeZone(timeZone)) throw fieldError('time_zone', 'Fuso horário inválido')
  const min = int(input.interval_min_seconds, 'interval_min_seconds', DEFAULT_INTERVAL.min)!
  const max = int(input.interval_max_seconds, 'interval_max_seconds', Math.max(DEFAULT_INTERVAL.max, min))!
  for (const [path, v] of [
    ['interval_min_seconds', min],
    ['interval_max_seconds', max],
  ] as const)
    if (v < 0 || v > MAX_INTERVAL_SECONDS) throw fieldError(path, `Use de 0 a ${MAX_INTERVAL_SECONDS} segundos`)
  if (max < min) throw fieldError('interval_max_seconds', 'O intervalo máximo deve ser maior ou igual ao mínimo')
  const dailyLimit = int(input.daily_limit, 'daily_limit') ?? null
  if (dailyLimit !== null && dailyLimit < 1) throw fieldError('daily_limit', 'O limite diário deve ser maior que zero')
  let startsSchedulingAt = defaults.now
  if (input.starts_scheduling_at !== undefined && input.starts_scheduling_at !== null && input.starts_scheduling_at !== '') {
    const d = new Date(String(input.starts_scheduling_at))
    if (Number.isNaN(d.getTime())) throw fieldError('starts_scheduling_at', 'Data inválida (ISO 8601)')
    startsSchedulingAt = d
  }
  return { weekdays, windowStart, windowEnd, timeZone, intervalMinSeconds: min, intervalMaxSeconds: max, dailyLimit, startsSchedulingAt }
}

/** Período da cota: mês corrente no fuso (`YYYY-MM`). */
export function quotaPeriod(now: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit' }).formatToParts(now)
  const y = parts.find((p) => p.type === 'year')!.value
  const m = parts.find((p) => p.type === 'month')!.value
  return `${y}-${m}`
}

export const WARMUP_DAYS = 7
export const WARMUP_DAY1_LIMIT = 20
export const WARMUP_GROWTH = 1.8
const DAY_MS = 86_400_000

/** Capacidade diária de warm-up da sessão hoje; `null` = warm-up concluído (sem limite de warm-up). */
export function warmupCapacity(warmupStartedAt: string | Date | null | undefined, now: Date): number | null {
  const started = warmupStartedAt ? new Date(warmupStartedAt) : null
  const day = started && !Number.isNaN(started.getTime()) ? Math.max(0, Math.floor((now.getTime() - started.getTime()) / DAY_MS)) : 0
  if (day >= WARMUP_DAYS) return null
  return Math.round(WARMUP_DAY1_LIMIT * Math.pow(WARMUP_GROWTH, day))
}
