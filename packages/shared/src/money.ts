// Dinheiro (SPEC 3.6): `amount_cents` inteiro + `currency` ISO 4217; custos de IA em `*_micros` (USD).
// No banco são bigint; no fio são números inteiros seguros (até 2^53 − 1).
import * as z from 'zod'

export const DEFAULT_CURRENCY = 'BRL'

export const currencySchema = z.string().regex(/^[A-Z]{3}$/, 'Moeda deve ser um código ISO 4217 (ex.: BRL)')
export type Currency = z.infer<typeof currencySchema>

export const amountCentsSchema = z.int()
export const microsSchema = z.int()

export const moneySchema = z.object({
  amount_cents: amountCentsSchema,
  currency: currencySchema,
})
export type Money = z.infer<typeof moneySchema>

/** Converte um valor decimal (número ou texto `"1.234,56"` / `"1234.56"`) em centavos, sem erro de ponto flutuante. */
export function toCents(value: number | string): number {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new RangeError('Valor monetário inválido')
    return Math.round(value * 100)
  }
  const text = value.trim().replace(/[^\d,.-]/g, '')
  const negative = text.startsWith('-')
  const body = text.replace(/-/g, '')
  // O último separador ("," ou ".") com 1–2 dígitos depois é o decimal; os demais são de milhar.
  const m = /^(.*?)[.,](\d{1,2})$/.exec(body)
  const intPart = (m ? m[1]! : body).replace(/[.,]/g, '')
  const fracPart = m ? m[2]!.padEnd(2, '0') : '00'
  if (!/^\d*$/.test(intPart) || (intPart === '' && !m)) throw new RangeError('Valor monetário inválido')
  const cents = Number(intPart || '0') * 100 + Number(fracPart)
  if (!Number.isSafeInteger(cents)) throw new RangeError('Valor monetário fora do intervalo')
  return negative ? -cents : cents
}

/** Centavos → valor decimal (para exibição/cálculo; nunca persista o resultado). */
export function fromCents(cents: number): number {
  return cents / 100
}

/** Formata centavos na moeda e no idioma informados (`Intl.NumberFormat`). */
export function formatMoney(cents: number, currency: string = DEFAULT_CURRENCY, locale = 'pt-BR'): string {
  return new Intl.NumberFormat(locale, { style: 'currency', currency }).format(cents / 100)
}

/** Micros de dólar (1 USD = 1_000_000) → dólares. */
export function microsToUsd(micros: number): number {
  return micros / 1_000_000
}

/** Dólares → micros, arredondando para o inteiro mais próximo. */
export function usdToMicros(usd: number): number {
  return Math.round(usd * 1_000_000)
}
