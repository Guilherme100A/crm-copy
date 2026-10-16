// Períodos de cota no fuso da empresa (SPEC 3.6: agregações por dia/mês no `companies.time_zone`).
import type { QuotaPeriod } from '@crm/db'

export const QUOTA_PERIOD_LIST: readonly QuotaPeriod[] = ['day', 'month']

/** `YYYY-MM-DD` (day) ou `YYYY-MM` (month) de `at` no fuso `timeZone`. */
export function periodBucket(period: QuotaPeriod, at: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(at)
  const get = (t: string) => parts.find((p) => p.type === t)!.value
  return period === 'day' ? `${get('year')}-${get('month')}-${get('day')}` : `${get('year')}-${get('month')}`
}

/** Formato do `to_char` do Postgres equivalente ao bucket. */
export const BUCKET_SQL_FORMAT: Record<QuotaPeriod, string> = { day: 'YYYY-MM-DD', month: 'YYYY-MM' }

/** TTL do contador quente: sobra além do fim do período. */
export const BUCKET_TTL_SECONDS: Record<QuotaPeriod, number> = { day: 3 * 86_400, month: 40 * 86_400 }
