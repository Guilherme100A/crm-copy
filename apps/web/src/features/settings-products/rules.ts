// Regras dos produtos replicadas do servidor (T34, `packages/core/src/products/service.ts` `validate()`/`resolvePrice`;
// 19 §3.5/§5.7): a web não importa `@crm/core`. Valores digitados com vírgula decimal ("12,50") viram centavos (1250).
// Exportadas para reuso pela T114 ("+ Criar novo produto…" no bloco Venda aprovada).

export const NAME_MIN = 2
export const NAME_MAX = 255
export const DEFAULT_CURRENCY = 'BRL'

export type ProductField = 'name' | 'currency' | 'price_min_cents' | 'price_max_cents' | 'price_fallback_cents'
/** Código do erro por campo; o texto vem do i18n (`errors.<código>`), igual à mensagem do servidor em pt-BR. */
export type ProductIssue = 'name' | 'currency' | 'money' | 'range' | 'fallback'

export interface ProductDraft {
  name: string
  currency: string
  price_min: string
  price_max: string
  price_fallback: string
}

export interface ProductInput {
  name: string
  currency: string
  price_min_cents: number
  price_max_cents: number
  price_fallback_cents: number
}

let currencies: Set<string> | null = null
/** ISO 4217 suportadas pelo runtime (o servidor usa o mesmo `Intl.supportedValuesOf('currency')`). */
export function currencyCodes(): string[] {
  currencies ??= new Set(Intl.supportedValuesOf('currency'))
  return [...currencies]
}

/** `/^[A-Z]{3}$/` + lista do Intl (aceita minúsculas e espaços, como `normalizeCurrency`). */
export function normalizeCurrency(value: string): string | null {
  const code = value.trim().toUpperCase()
  currencies ??= new Set(Intl.supportedValuesOf('currency'))
  return /^[A-Z]{3}$/.test(code) && currencies.has(code) ? code : null
}

/** "BRL · Real brasileiro" (nome no idioma da interface; sem nome conhecido, só o código). */
export function currencyLabel(code: string, locale: string): string {
  try {
    const name = new Intl.DisplayNames([locale], { type: 'currency' }).of(code)
    return name && name !== code ? `${code} · ${name}` : code
  } catch {
    return code
  }
}

/**
 * Valor digitado → centavos. Aceita "12,50", "12", "1.299,90", "1299.9" e "R$ 12,50"; no máximo 2 casas decimais.
 * Vazio, negativo ou inválido → null.
 */
export function parseMoney(input: string): number | null {
  let s = input.replace(/\s|R\$/g, '')
  if (!s || s.startsWith('-')) return null
  if (s.includes(',')) {
    // Vírgula decimal: pontos são milhar.
    if (s.indexOf(',') !== s.lastIndexOf(',')) return null
    s = s.replace(/\./g, '').replace(',', '.')
  } else if ((s.match(/\./g) ?? []).length === 1 && /\.\d{1,2}$/.test(s)) {
    // Um ponto com 1–2 casas: decimal ("1299.9").
  } else {
    s = s.replace(/\./g, '')
  }
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null
  const [int, dec = ''] = s.split('.')
  const cents = Number(int) * 100 + Number(dec.padEnd(2, '0'))
  return Number.isSafeInteger(cents) ? cents : null
}

/** Centavos → "12,50" (vírgula decimal, o formato do campo). */
export function centsToInput(cents: number | null | undefined): string {
  if (typeof cents !== 'number' || !Number.isFinite(cents)) return ''
  const neg = cents < 0 ? '-' : ''
  const abs = Math.abs(Math.trunc(cents))
  return `${neg}${Math.floor(abs / 100)},${String(abs % 100).padStart(2, '0')}`
}

/** Centavos na moeda (exibição na tabela). */
export function formatMoney(cents: number, currency: string, locale: string): string {
  try {
    return new Intl.NumberFormat(locale, { style: 'currency', currency }).format(cents / 100)
  } catch {
    return `${currency} ${centsToInput(cents)}`
  }
}

/** Mesmas regras de `validate()` do servidor, na mesma ordem; um erro por campo. */
export function validateProduct(d: ProductDraft): Partial<Record<ProductField, ProductIssue>> {
  const out: Partial<Record<ProductField, ProductIssue>> = {}
  const name = d.name.trim()
  if (name.length < NAME_MIN || name.length > NAME_MAX) out.name = 'name'
  if (!normalizeCurrency(d.currency || DEFAULT_CURRENCY)) out.currency = 'currency'
  const min = parseMoney(d.price_min)
  const max = parseMoney(d.price_max)
  const fallback = parseMoney(d.price_fallback)
  if (min === null) out.price_min_cents = 'money'
  if (max === null) out.price_max_cents = 'money'
  if (fallback === null) out.price_fallback_cents = 'money'
  if (min !== null && max !== null && max < min) out.price_max_cents = 'range'
  if (fallback !== null && fallback <= 0) out.price_fallback_cents = 'fallback'
  return out
}

export const hasIssues = (issues: Partial<Record<ProductField, ProductIssue>>) => Object.keys(issues).length > 0

/** Corpo do POST/PATCH (só depois de `validateProduct` vazio). */
export function toProductInput(d: ProductDraft): ProductInput {
  return {
    name: d.name.trim(),
    currency: normalizeCurrency(d.currency || DEFAULT_CURRENCY) ?? DEFAULT_CURRENCY,
    price_min_cents: parseMoney(d.price_min) ?? 0,
    price_max_cents: parseMoney(d.price_max) ?? 0,
    price_fallback_cents: parseMoney(d.price_fallback) ?? 0,
  }
}

export function draftFromProduct(p?: Partial<ProductInput> | null): ProductDraft {
  return {
    name: p?.name ?? '',
    currency: p?.currency ?? DEFAULT_CURRENCY,
    price_min: centsToInput(p?.price_min_cents),
    price_max: centsToInput(p?.price_max_cents),
    price_fallback: centsToInput(p?.price_fallback_cents),
  }
}

/** Valor da venda (19 §5.7): dentro de [mín, máx] usa o valor recebido; fora da faixa ou ausente, o padrão. */
export function resolvePrice(
  p: Pick<ProductInput, 'price_min_cents' | 'price_max_cents' | 'price_fallback_cents'>,
  amountCents: number | null | undefined,
): number {
  if (typeof amountCents !== 'number' || !Number.isFinite(amountCents)) return p.price_fallback_cents
  return amountCents >= p.price_min_cents && amountCents <= p.price_max_cents ? amountCents : p.price_fallback_cents
}
