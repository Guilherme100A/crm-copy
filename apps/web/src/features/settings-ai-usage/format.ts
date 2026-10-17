// Regras puras do consumo de IA na UI (T59): formato do saldo (12 §3.10), destaque baixo/esgotado, evento realtime da
// carteira, período do filtro, início do dia/mês no fuso da empresa e uso das cotas (somado do resumo no cliente,
// porque `GET /api/ai/quotas` só traz os limites).
import type { QuotaDto, SummaryItem, WalletDto, WalletStatus } from './api'

/** ≥ 1M → "1.2M", ≥ 10k → "12k", senão inteiro com separador do idioma (12 §3.10). Negativo mantém o sinal. */
export function formatCredits(value: number, locale = 'pt-BR'): string {
  const sign = value < 0 ? '-' : ''
  const abs = Math.abs(value)
  const compact = (n: number) => n.toLocaleString(locale, { maximumFractionDigits: 1 })
  if (abs >= 1_000_000) return `${sign}${compact(Math.floor(abs / 100_000) / 10)}M`
  if (abs >= 10_000) return `${sign}${Math.floor(abs / 1000).toLocaleString(locale)}k`
  return `${sign}${Math.trunc(abs).toLocaleString(locale)}`
}

/** Custo em micros de dólar → "US$ 1,23" no idioma. */
export function formatMicros(micros: number, locale = 'pt-BR'): string {
  return (micros / 1_000_000).toLocaleString(locale, { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 4 })
}

/**
 * Destaque do chip: esgotado = `exhausted` ou saldo ≤ 0; baixo = `low` ou 0 < saldo ≤ limiar (12 §3.10). O status do
 * servidor vale primeiro; o saldo cobre o intervalo entre o evento e a próxima leitura.
 */
export function walletTone(w: Pick<WalletDto, 'balance_credits' | 'status'> & { low_threshold_credits?: number }): WalletStatus {
  if (w.status === 'exhausted' || w.balance_credits <= 0) return 'exhausted'
  if (w.status === 'low' || (w.low_threshold_credits !== undefined && w.balance_credits <= w.low_threshold_credits)) return 'low'
  return 'ok'
}

export interface WalletEventData {
  balance_credits: number
  status: WalletStatus
  low_threshold_credits?: number
  max_overrun_credits?: number
}

/** `ai_wallet.updated` sobre o cache: saldo e status do evento; o resto (totais, última recarga) fica do cache. */
export function applyWalletEvent(prev: WalletDto | undefined, data: WalletEventData): WalletDto {
  return {
    low_threshold_credits: 0,
    max_overrun_credits: 0,
    lifetime_credited_credits: 0,
    lifetime_spent_credits: 0,
    ...prev,
    balance_credits: data.balance_credits,
    status: data.status,
    ...(data.low_threshold_credits !== undefined ? { low_threshold_credits: data.low_threshold_credits } : {}),
    ...(data.max_overrun_credits !== undefined ? { max_overrun_credits: data.max_overrun_credits } : {}),
  }
}

export const PERIODS = ['7d', '30d', '90d'] as const
export type Period = (typeof PERIODS)[number]

/** Últimos N dias até agora, em ISO (a API aceita `Z`). */
export function periodRange(period: Period, now: Date = new Date()): { from: string; to: string } {
  const days = Number.parseInt(period, 10)
  return { from: new Date(now.getTime() - days * 86_400_000).toISOString(), to: now.toISOString() }
}

/** Diferença (ms) entre o relógio de parede no fuso e o UTC naquele instante. */
export function tzOffsetMs(timeZone: string, at: Date): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(at)
  const n = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0)
  const wall = Date.UTC(n('year'), n('month') - 1, n('day'), n('hour') % 24, n('minute'), n('second'))
  return wall - Math.floor(at.getTime() / 1000) * 1000
}

/** Início do dia ou do mês corrente no fuso da empresa, como instante ISO (UTC). */
export function startOfPeriod(period: 'day' | 'month', timeZone: string, now: Date = new Date()): string {
  const local = new Date(now.getTime() + tzOffsetMs(timeZone, now))
  const guess = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), period === 'day' ? local.getUTCDate() : 1)
  // Duas passadas acertam a virada de horário de verão entre a meia-noite e agora.
  let at = guess - tzOffsetMs(timeZone, new Date(guess))
  at = guess - tzOffsetMs(timeZone, new Date(at))
  return new Date(at).toISOString()
}

export interface Totals {
  count: number
  credits: number
  cost_micros: number
  tokens: number
}

export function sumSummary(items: readonly SummaryItem[] | undefined): Totals {
  const t: Totals = { count: 0, credits: 0, cost_micros: 0, tokens: 0 }
  for (const i of items ?? []) {
    t.count += i.count
    t.credits += i.credits
    t.cost_micros += i.cost_micros
    t.tokens += i.input_tokens + i.output_tokens
  }
  return t
}

export type QuotaMetric = 'credits' | 'cost' | 'tokens'

export interface QuotaBar {
  metric: QuotaMetric
  used: number
  max: number
  /** 0–100 (a barra para em 100; `over` indica que passou). */
  pct: number
  over: boolean
}

/** Uma barra por limite definido da cota (créditos, custo, tokens) com o uso do período. */
export function quotaBars(q: QuotaDto, used: Totals): QuotaBar[] {
  const bars: QuotaBar[] = []
  const push = (metric: QuotaMetric, max: number | null, value: number) => {
    if (max === null || max === undefined) return
    const over = max > 0 ? value >= max : value > 0
    const pct = max > 0 ? Math.min(100, (value / max) * 100) : over ? 100 : 0
    bars.push({ metric, used: value, max, pct, over })
  }
  push('credits', q.max_credits, used.credits)
  push('cost', q.max_cost_micros, used.cost_micros)
  push('tokens', q.max_tokens, used.tokens)
  return bars
}
