// Regras do bloco Pagamento (`create_payment_charge`; AC-T114-03; 19 §3.8, §4.6): matriz gateway × moeda × método da
// XPag replicada do core (`XPAG_SUPPORT`/`XPAG_LIMITS`/`validateXPagCharge` em packages/core/src/payments/xpag/gateway.ts;
// a web só importa `@crm/shared`), campos condicionais por método, limpeza ao trocar moeda/método e as regras locais que
// o schema do T10 não cobre. Zenith fora de escopo (SPEC 10.1 nº 13): só a XPag é oferecida.
import {
  defineLocalRules,
  hasVariable,
  parseNumber,
  setField,
  setFields,
  type Config,
  type FieldErrors,
} from '../logic/rules'

export const PAYMENT_ACTION = 'create_payment_charge'

export interface PaymentSupport {
  currency: string
  methods: readonly string[]
  /** Aceita "chave sem valor" (o lead paga o que quiser). */
  open_amount: boolean
}

/** Matriz por gateway oferecido no editor (cópia de `XPAG_SUPPORT`). */
export const GATEWAY_SUPPORT: Record<string, readonly PaymentSupport[]> = {
  xpag: [
    { currency: 'BRL', methods: ['PIX'], open_amount: true },
    { currency: 'MXN', methods: ['SPEI', 'OXXO'], open_amount: true },
    { currency: 'COP', methods: ['NEQUI', 'BREB'], open_amount: false },
    { currency: 'ARS', methods: ['BANK_TRANSFER'], open_amount: false },
  ],
}

export const EDITOR_GATEWAYS = Object.keys(GATEWAY_SUPPORT)
export const DEFAULT_GATEWAY = 'xpag'

/** Limites em unidades da moeda (core em centavos): OXXO MX$10–10.000; COP mínimo COP$10.000. */
export const XPAG_LIMITS = { oxxoMin: 10, oxxoMax: 10_000, copMin: 10_000 } as const

/** Tipos de documento por moeda (19 §4.6; ARS: CUIT opcional na XPag). */
export const DOCUMENT_TYPES: Record<string, readonly string[]> = { ARS: ['CUIT', 'CUIL', 'DNI'] }

/** Campos do pagador mostrados por método (o core monta o corpo do cashin com estes; ver `cashinBody`). */
export type PayerField = 'name' | 'email' | 'phone' | 'document' | 'document_type'
export const PAYER_FIELDS: readonly PayerField[] = ['name', 'email', 'phone', 'document', 'document_type']

export const currenciesOf = (gateway: string): string[] => (GATEWAY_SUPPORT[gateway] ?? []).map((s) => s.currency)
export const supportOf = (gateway: string, currency: string) =>
  (GATEWAY_SUPPORT[gateway] ?? []).find((s) => s.currency === currency)
export const methodsOf = (gateway: string, currency: string): string[] => [
  ...(supportOf(gateway, currency)?.methods ?? []),
]

/** "Chave sem valor" disponível para a combinação (ARS/COP não; OXXO exige valor). */
export function openAmountAllowed(gateway: string, currency: string, method: string): boolean {
  const s = supportOf(gateway, currency)
  if (!s?.open_amount) return false
  return !(gateway === 'xpag' && method === 'OXXO')
}

export function payerFields(gateway: string, currency: string, method: string): PayerField[] {
  if (gateway !== 'xpag') return []
  if (method === 'OXXO') return ['name', 'email']
  if (currency === 'COP') return ['phone']
  if (currency === 'ARS') return ['name', 'document', 'document_type']
  // BRL PIX e MXN SPEI.
  return ['name', 'document']
}

export const PAYER_DEFAULTS: Partial<Record<PayerField, string>> = { name: '{full_name}', phone: '{phone_number}' }

/** Config de um bloco novo (19 §3.8, sem a chave: ela é escolhida na lista do gateway). */
export const defaultPaymentConfig = (): Config => ({
  gateway: DEFAULT_GATEWAY,
  payment_integration_id: '',
  currency: 'BRL',
  method: 'PIX',
  amount: '100,00',
  open_amount: false,
  name: '{full_name}',
  listener_ttl_value: 2,
  listener_ttl_unit: 'days',
})

const s = (c: Config, k: string) => (typeof c[k] === 'string' ? (c[k] as string) : '')

/** Remove os campos do pagador que a combinação não usa e desliga a "chave sem valor" quando não vale. */
export function cleanPayment(c: Config): Config {
  const gateway = s(c, 'gateway')
  const currency = s(c, 'currency')
  const method = s(c, 'method')
  const keep = new Set(payerFields(gateway, currency, method))
  let next = c
  for (const f of PAYER_FIELDS) if (!keep.has(f) && f in next) next = setField(next, f, undefined)
  // Campo que passa a aparecer começa com a variável padrão do motor (19 §3.8).
  for (const [f, v] of Object.entries(PAYER_DEFAULTS))
    if (keep.has(f as PayerField) && next[f] === undefined) next = setField(next, f, v)
  if (next.open_amount === true && !openAmountAllowed(gateway, currency, method))
    next = setField(next, 'open_amount', false)
  return next
}

/** Troca o gateway: moeda e método voltam ao primeiro suportado e a chave é desmarcada. */
export function withGateway(c: Config, gateway: string): Config {
  const currency = currenciesOf(gateway)[0] ?? ''
  return cleanPayment(
    setFields(c, { gateway, payment_integration_id: '', currency, method: methodsOf(gateway, currency)[0] ?? '' }),
  )
}

/** Troca a moeda: o método vira o primeiro da moeda (se o atual não existir nela). */
export function withCurrency(c: Config, currency: string): Config {
  const methods = methodsOf(s(c, 'gateway'), currency)
  const method = methods.includes(s(c, 'method')) ? s(c, 'method') : (methods[0] ?? '')
  return cleanPayment(setFields(c, { currency, method }))
}

export const withMethod = (c: Config, method: string): Config => cleanPayment(setField(c, 'method', method))

export function withOpenAmount(c: Config, open: boolean): Config {
  return setFields(c, { open_amount: open, amount: open ? undefined : s(c, 'amount') || '100,00' })
}

/** Celular colombiano: 10 dígitos começando com 3 (aceita +57). */
export function isColombianMobile(raw: string): boolean {
  let digits = raw.replace(/\D/g, '')
  if (digits.length === 12 && digits.startsWith('57')) digits = digits.slice(2)
  return /^3\d{9}$/.test(digits)
}

/** Regras da matriz e dos limites (o schema só confere tipos e o valor obrigatório). */
export function paymentLocalErrors(c: Config): FieldErrors {
  const out: FieldErrors = {}
  const gateway = s(c, 'gateway')
  if (!EDITOR_GATEWAYS.includes(gateway)) {
    out.gateway = { key: 'invalid' }
    return out
  }
  const currency = s(c, 'currency')
  const method = s(c, 'method')
  if (!currenciesOf(gateway).includes(currency)) out.currency = { key: 'invalid' }
  else if (!methodsOf(gateway, currency).includes(method)) out.method = { key: 'invalid' }
  const open = c.open_amount === true
  if (open && !openAmountAllowed(gateway, currency, method)) out.open_amount = { key: 'invalid' }
  const raw = c.amount
  if (!open && raw !== undefined && !(typeof raw === 'string' && (!raw.trim() || hasVariable(raw)))) {
    const n = parseNumber(raw)
    if (n === null || n <= 0) out.amount = { key: 'number' }
    else if (gateway === 'xpag' && method === 'OXXO' && n < XPAG_LIMITS.oxxoMin)
      out.amount = { key: 'min', vars: { min: 'MX$10' } }
    else if (gateway === 'xpag' && method === 'OXXO' && n > XPAG_LIMITS.oxxoMax)
      out.amount = { key: 'max', vars: { max: 'MX$10.000' } }
    else if (gateway === 'xpag' && currency === 'COP' && n < XPAG_LIMITS.copMin)
      out.amount = { key: 'min', vars: { min: 'COP$10.000' } }
  }
  const phone = s(c, 'phone')
  if (currency === 'COP' && phone.trim() && !hasVariable(phone) && !isColombianMobile(phone))
    out.phone = { key: 'format' }
  if (gateway === 'xpag' && currency === 'ARS' && !s(c, 'name').trim()) out.name = { key: 'required' }
  const docType = s(c, 'document_type')
  if (docType && DOCUMENT_TYPES[currency] && !DOCUMENT_TYPES[currency]!.includes(docType))
    out.document_type = { key: 'invalid' }
  return out
}

defineLocalRules(PAYMENT_ACTION, paymentLocalErrors)
