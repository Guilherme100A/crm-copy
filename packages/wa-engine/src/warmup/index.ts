// Warm-up (T14, fork do ai-manager). Progresso e limite diário como função pura da idade da sessão.
// Cronograma baseado no `WarmUpConfig` do baileys-antiban (defaults: 7 dias, 20 msgs no dia 1,
// crescimento 1.8×/dia → limite do dia d = round(day1Limit · growthFactor^d)).
// O warm-up só limita volume: nunca gera mensagens artificiais (SPEC 1.4 #5).

export interface WarmupSchedule {
  /** Duração do warm-up em dias (default 7). */
  warmUpDays: number
  /** Mensagens permitidas no dia 0 (default 20). */
  day1Limit: number
  /** Fator de crescimento diário do limite (default 1.8). */
  growthFactor: number
}

export const DEFAULT_WARMUP_SCHEDULE: Readonly<WarmupSchedule> = Object.freeze({
  warmUpDays: 7,
  day1Limit: 20,
  growthFactor: 1.8,
})

export const DAY_MS = 24 * 60 * 60 * 1000

export interface WarmupStatus {
  /** 0..100, inteiro (floor). */
  percent: number
  /** Dia do warm-up, 0-based. */
  day: number
  /** Limite de envios do dia; null quando o warm-up terminou (sem limite de warm-up). */
  dailyLimit: number | null
  complete: boolean
}

export interface ComputeWarmupInput {
  startedAt: Date | null
  now: Date
  schedule?: Partial<WarmupSchedule>
}

export function resolveWarmupSchedule(partial: Partial<WarmupSchedule> = {}): WarmupSchedule {
  const s = { ...DEFAULT_WARMUP_SCHEDULE, ...stripUndefined(partial) }
  if (!Number.isFinite(s.warmUpDays) || s.warmUpDays <= 0) throw new RangeError('warmUpDays must be > 0')
  if (!Number.isFinite(s.day1Limit) || s.day1Limit < 0) throw new RangeError('day1Limit must be >= 0')
  if (!Number.isFinite(s.growthFactor) || s.growthFactor < 1) throw new RangeError('growthFactor must be >= 1')
  return s
}

/** Limite diário do dia `day` (0-based) do cronograma; null a partir de `warmUpDays`. */
export function warmupDailyLimit(day: number, schedule: Partial<WarmupSchedule> = {}): number | null {
  const s = resolveWarmupSchedule(schedule)
  if (day >= s.warmUpDays) return null
  return Math.round(s.day1Limit * Math.pow(s.growthFactor, Math.max(0, day)))
}

/** Tabela de limites por dia (útil para UI/docs). */
export function warmupScheduleTable(schedule: Partial<WarmupSchedule> = {}): Array<{ day: number; dailyLimit: number }> {
  const s = resolveWarmupSchedule(schedule)
  const days = Math.ceil(s.warmUpDays)
  return Array.from({ length: days }, (_, day) => ({ day, dailyLimit: warmupDailyLimit(day, s)! }))
}

export function computeWarmup({ startedAt, now, schedule }: ComputeWarmupInput): WarmupStatus {
  const s = resolveWarmupSchedule(schedule)
  if (!startedAt) return { percent: 0, day: 0, dailyLimit: warmupDailyLimit(0, s), complete: false }
  const ageMs = Math.max(0, now.getTime() - startedAt.getTime())
  const totalMs = s.warmUpDays * DAY_MS
  const complete = ageMs >= totalMs
  const day = Math.floor(ageMs / DAY_MS)
  const percent = complete ? 100 : Math.min(99, Math.floor((ageMs / totalMs) * 100))
  return { percent, day, dailyLimit: complete ? null : warmupDailyLimit(day, s), complete }
}

export function isWarmupComplete(startedAt: Date | null, now: Date, schedule?: Partial<WarmupSchedule>): boolean {
  return computeWarmup(schedule ? { startedAt, now, schedule } : { startedAt, now }).complete
}

/** Lê WARMUP_DAYS, WARMUP_DAY1_LIMIT e WARMUP_GROWTH_FACTOR (ausentes → defaults). */
export function warmupScheduleFromEnv(env: Record<string, string | undefined> = process.env): WarmupSchedule {
  const num = (v: string | undefined) => (v === undefined || v.trim() === '' ? undefined : Number(v))
  const partial: Partial<WarmupSchedule> = {}
  const days = num(env.WARMUP_DAYS)
  const day1 = num(env.WARMUP_DAY1_LIMIT)
  const growth = num(env.WARMUP_GROWTH_FACTOR)
  if (days !== undefined) partial.warmUpDays = days
  if (day1 !== undefined) partial.day1Limit = day1
  if (growth !== undefined) partial.growthFactor = growth
  return resolveWarmupSchedule(partial)
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>
}
