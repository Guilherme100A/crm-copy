// Regras puras dos nós de CRM (T63): status interno do chat, contas do manipulador, data de criação e valores de venda.
import { zonedTime } from '../../../mass-dispatch-runner/window'
import { parseNumber } from '../logic/rules'

export const CHAT_STATUS_INTERNAL = ['waiting', 'attending', 'resolved'] as const
export type ChatStatusInternal = (typeof CHAT_STATUS_INTERNAL)[number]

/** Rótulos da referência que o editor grava (`Aguardando`…) → enum interno. */
const LEGACY_STATUS: Record<string, ChatStatusInternal> = { aguardando: 'waiting', atendimento: 'attending', resolvidos: 'resolved', resolvido: 'resolved' }

/** Status do chat do nó: enum interno; os rótulos do editor são traduzidos; o resto → `null` (inválido). */
export function chatStatusOf(raw: unknown): ChatStatusInternal | null {
  if (typeof raw !== 'string') return null
  const v = raw.trim()
  if ((CHAT_STATUS_INTERNAL as readonly string[]).includes(v)) return v as ChatStatusInternal
  return LEGACY_STATUS[v.toLowerCase()] ?? null
}

export const MANIPULATOR_OPERATIONS = ['set_value', 'set', 'add', 'subtract', 'multiply', 'divide'] as const

export class ManipulatorError extends Error {
  constructor(
    readonly code: 'division_by_zero' | 'not_a_number' | 'invalid_operation',
    message: string,
  ) {
    super(`${code}: ${message}`)
    this.name = 'ManipulatorError'
  }
}

/** Resultado da operação sobre o valor atual (atual ausente/não numérico = 0 nas contas). */
export function manipulate(current: unknown, operation: string, value: unknown, valueType?: string): unknown {
  if (operation === 'set_value' || operation === 'set') {
    if (valueType === 'number') {
      const n = parseNumber(value)
      if (n === null) throw new ManipulatorError('not_a_number', `valor não numérico: ${String(value)}`)
      return n
    }
    return typeof value === 'number' ? value : String(value ?? '')
  }
  const operand = parseNumber(value)
  if (operand === null) throw new ManipulatorError('not_a_number', `valor não numérico: ${String(value)}`)
  const base = parseNumber(current) ?? 0
  let out: number
  switch (operation) {
    case 'add':
      out = base + operand
      break
    case 'subtract':
      out = base - operand
      break
    case 'multiply':
      out = base * operand
      break
    case 'divide':
      if (operand === 0) throw new ManipulatorError('division_by_zero', 'divisão por zero')
      out = base / operand
      break
    default:
      throw new ManipulatorError('invalid_operation', `operação desconhecida: ${operation}`)
  }
  // Evita ruído de ponto flutuante (0.1 + 0.2).
  return Math.round(out * 1e10) / 1e10
}

/** `dd/MM/aaaa[ HH:mm[:ss]]` no fuso da empresa ou ISO 8601 → instante; inválido → `null`. */
export function parseCreatedAt(raw: string, timeZone: string): Date | null {
  const s = raw.trim()
  const br = /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(s)
  if (br) {
    const [day, month, year, h, mi, sec] = [Number(br[1]), Number(br[2]), Number(br[3]), Number(br[4] ?? 0), Number(br[5] ?? 0), Number(br[6] ?? 0)]
    if (month < 1 || month > 12 || day < 1 || day > 31 || h > 23 || mi > 59 || sec > 59) return null
    const at = new Date(zonedTime(year, month, day, h, mi, timeZone).getTime() + sec * 1000)
    // Rejeita datas inexistentes (31/02): o dia local tem de bater.
    const check = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at)
    return check === `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}` ? at : null
  }
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) {
    const d = new Date(s)
    return Number.isNaN(d.getTime()) ? null : d
  }
  return null
}

/** Valor da venda (reais com vírgula ou ponto) → centavos; fora da faixa do produto ou inválido → fallback. */
export function saleAmountCents(raw: string, product: { priceMinCents: number; priceMaxCents: number; priceFallbackCents: number }): { cents: number; fallback: boolean } {
  const n = parseNumber(raw)
  const cents = n === null ? null : Math.round(n * 100)
  if (cents === null || cents <= 0 || cents < product.priceMinCents || cents > product.priceMaxCents) return { cents: product.priceFallbackCents, fallback: true }
  return { cents, fallback: false }
}

/** Valor em reais do card (número ou texto já renderizado) → centavos; vazio/inválido → `undefined`. */
export function cardValueCents(raw: unknown): number | undefined {
  const n = parseNumber(typeof raw === 'number' ? raw : String(raw ?? ''))
  return n === null || n < 0 ? undefined : Math.round(n * 100)
}

/** `1234.5` centavos → `"12,35"` (pt-BR, sem símbolo). */
export function formatMoney(cents: number): string {
  return (cents / 100).toFixed(2).replace('.', ',').replace(/\B(?=(\d{3})+(?!\d))/g, '.')
}
