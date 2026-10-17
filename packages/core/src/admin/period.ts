// Período das estatísticas do admin (20 §3.12): `start_date`/`end_date` (YYYY-MM-DD, inclusivos) no fuso da
// plataforma; padrão = últimos 7 dias. Datas inválidas, invertidas ou janela acima do máximo → erro de validação.
import { adminInvalid } from './errors'

export const STATS_DEFAULT_DAYS = 7
export const STATS_MAX_DAYS = 366

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

/** Dia civil (YYYY-MM-DD) de `date` no fuso. */
export function statsDayIn(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date)
}

const toUtc = (day: string) => Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10)))

function isRealDay(day: string): boolean {
  if (!DATE_RE.test(day)) return false
  return new Date(toUtc(day)).toISOString().slice(0, 10) === day
}

export function addStatsDays(day: string, n: number): string {
  return new Date(toUtc(day) + n * 86_400_000).toISOString().slice(0, 10)
}

/** Dias de `start` a `end`, inclusivos. */
export function statsDays(start: string, end: string): string[] {
  const out: string[] = []
  for (let d = start; d <= end; d = addStatsDays(d, 1)) out.push(d)
  return out
}

export function resolveStatsPeriod(
  input: { start_date?: string; end_date?: string },
  now: Date,
  timeZone: string,
): { startDate: string; endDate: string } {
  for (const k of ['start_date', 'end_date'] as const) {
    const v = input[k]
    if (v !== undefined && !isRealDay(v)) throw adminInvalid(k, 'Use uma data válida no formato AAAA-MM-DD')
  }
  const endDate =
    input.end_date ??
    (input.start_date ? addStatsDays(input.start_date, STATS_DEFAULT_DAYS - 1) : statsDayIn(now, timeZone))
  const startDate = input.start_date ?? addStatsDays(endDate, -(STATS_DEFAULT_DAYS - 1))
  if (startDate > endDate) throw adminInvalid('start_date', 'A data inicial deve ser anterior ou igual à final')
  if ((toUtc(endDate) - toUtc(startDate)) / 86_400_000 + 1 > STATS_MAX_DAYS)
    throw adminInvalid('end_date', `Período máximo de ${STATS_MAX_DAYS} dias`)
  return { startDate, endDate }
}
