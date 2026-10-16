// Regras puras dos nós de lógica (T41; 06 §3.6): avaliação de condições, próximo instante do intervalo inteligente
// e escolha da saída do distribuidor. Fuso da empresa via `Intl` (helpers da janela de envio da T74).
import { localParts, zonedTime } from '../../../mass-dispatch-runner/window'

export const WEEKDAY_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'] as const

/** `'1,5'`, `'1.234,56'`, `' 10 '`, `3` → número; vazio/inválido → `null`. */
export function parseNumber(raw: unknown): number | null {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null
  if (typeof raw !== 'string') return null
  let s = raw.trim().replace(/\s/g, '')
  if (!s) return null
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.')
  if (!/^[-+]?\d*\.?\d+(e[-+]?\d+)?$/i.test(s)) return null
  const n = Number(s)
  return Number.isFinite(n) ? n : null
}

// ---------------------------------------------------------------- condição

export interface ConditionFacts {
  now: Date
  timeZone: string
  /** Etiquetas do contato e do chat do run. */
  labels: { ids: ReadonlySet<string>; names: ReadonlySet<string> }
  chat: { status: string | null; assignedUserId: string | null } | null
  contact: { name?: string | null; phone?: string | null; email?: string | null; customFields?: Record<string, unknown> | null } | null
  globals: Record<string, unknown>
  /** Tipo da última resposta do contato (`vars.reply.type`). */
  replyType: string | null
  /** Interpola `{variáveis}` do valor da regra. */
  render: (s: string) => string
}

export interface ConditionRule {
  category: string
  systemSubtype?: string
  operator?: string
  tagName?: string
  tagId?: string
  weekday?: string
  time?: number
  timeMinute?: number
  date?: string
  attendanceStatus?: string
  user_ids?: string[]
  fieldName?: string
  value?: string | number
}

const ATTENDANCE: Record<string, string> = { waiting: 'waiting', in_progress: 'attending', attending: 'attending', resolved: 'resolved' }
const NUMERIC = new Set(['greater_than', 'less_than', 'greater_or_equal', 'less_or_equal', 'numeric_equal'])

const text = (v: unknown) => (v === null || v === undefined ? '' : typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'boolean' ? String(v) : JSON.stringify(v))
const norm = (v: unknown) => text(v).trim().toLowerCase()

/** Compara o valor do campo com o da regra pelo operador (texto sem caixa; números com vírgula ou ponto). */
export function compareValues(actual: unknown, operator: string, expected: unknown, replyType: string | null = null): boolean {
  if (operator === 'type') return norm(replyType) === norm(expected)
  if (operator === 'has_value') return text(actual).trim().length > 0
  if (NUMERIC.has(operator)) {
    const a = parseNumber(typeof actual === 'number' ? actual : text(actual))
    const b = parseNumber(typeof expected === 'number' ? expected : text(expected))
    if (a === null || b === null) return false
    switch (operator) {
      case 'greater_than':
        return a > b
      case 'less_than':
        return a < b
      case 'greater_or_equal':
        return a >= b
      case 'less_or_equal':
        return a <= b
      default:
        return a === b
    }
  }
  const a = norm(actual)
  const b = norm(expected)
  switch (operator) {
    case 'equal':
      return a === b
    case 'different':
      return a !== b
    case 'contains':
      return a.includes(b)
    case 'not_contains':
      return !a.includes(b)
    case 'starts_with':
      return a.startsWith(b)
    default:
      return false
  }
}

const FIELD: Record<string, 'name' | 'phone' | 'email'> = { name: 'name', full_name: 'name', phone: 'phone', phone_number: 'phone', email: 'email' }

/** Avalia UMA regra contra os fatos. */
export function evaluateCondition(rule: ConditionRule, facts: ConditionFacts): boolean {
  const op = rule.operator ?? 'equal'
  const negate = op === 'different'
  const value = () => (typeof rule.value === 'string' ? facts.render(rule.value) : rule.value)
  switch (rule.category) {
    case 'system': {
      const local = localParts(facts.now, facts.timeZone)
      switch (rule.systemSubtype) {
        case 'message_window':
          // Sem janela de 24 h no Baileys (SPEC 8.2): sempre aberta.
          return true
        case 'tag': {
          const has = (!!rule.tagId && facts.labels.ids.has(rule.tagId)) || (!!rule.tagName?.trim() && facts.labels.names.has(rule.tagName.trim().toLowerCase()))
          return negate ? !has : has
        }
        case 'weekday': {
          const same = WEEKDAY_NAMES[local.weekday] === rule.weekday
          return negate ? !same : same
        }
        case 'time': {
          const nowMin = local.hour * 60 + local.minute
          const at = (rule.time ?? 0) * 60 + (rule.timeMinute ?? 0)
          if (op === 'before') return nowMin < at
          if (op === 'after') return nowMin > at
          return local.hour === (rule.time ?? -1)
        }
        case 'date': {
          const d = localDateOf(rule.date ?? '', facts.timeZone)
          if (!d) return false
          const today = `${local.year}-${String(local.month).padStart(2, '0')}-${String(local.day).padStart(2, '0')}`
          if (op === 'before') return today < d
          if (op === 'after') return today > d
          return op === 'different' ? today !== d : today === d
        }
        default:
          return false
      }
    }
    case 'attendance': {
      const want = ATTENDANCE[rule.attendanceStatus ?? '']
      const same = !!facts.chat && !!want && facts.chat.status === want
      return negate ? !same : same
    }
    case 'attendant': {
      const inList = !!facts.chat?.assignedUserId && (rule.user_ids ?? []).includes(facts.chat.assignedUserId)
      return negate ? !inList : inList
    }
    case 'field': {
      const key = FIELD[(rule.fieldName ?? '').trim().toLowerCase()]
      const actual = key ? facts.contact?.[key] : undefined
      return compareValues(actual, op, value(), facts.replyType)
    }
    case 'custom_field': {
      const key = (rule.fieldName ?? '').trim()
      const fields = facts.contact?.customFields ?? {}
      const actual = fields[key] ?? fields[key.toLowerCase()]
      return compareValues(actual, op, value(), facts.replyType)
    }
    case 'global_variable': {
      const raw = (rule.fieldName ?? '').trim()
      const key = raw.startsWith('g_') ? raw : `g_${raw}`
      return compareValues(facts.globals[key] ?? facts.globals[raw], op, value(), facts.replyType)
    }
    default:
      return false
  }
}

/** `all` = todas; `any` = ao menos uma. */
export function evaluateRules(ruleType: string, rules: readonly ConditionRule[], facts: ConditionFacts): boolean {
  if (!rules.length) return false
  return ruleType === 'any' ? rules.some((r) => evaluateCondition(r, facts)) : rules.every((r) => evaluateCondition(r, facts))
}

/** `'2026-10-19'` ou ISO completo → data local `YYYY-MM-DD` no fuso. */
function localDateOf(raw: string, timeZone: string): string | null {
  const s = raw.trim()
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s
  const d = new Date(s)
  if (Number.isNaN(d.getTime())) return null
  const p = localParts(d, timeZone)
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`
}

// ---------------------------------------------------------------- intervalo inteligente

export interface SmartIntervalConfig {
  schedule_type: 'time' | 'date' | 'weekly' | string
  interval_value?: number
  interval_unit?: 'minutes' | 'hours' | 'days' | string
  scheduled_date?: string
  weekly_schedule?: Partial<Record<string, { enabled?: boolean; start_time?: string; end_time?: string }>>
}

const UNIT_MS: Record<string, number> = { minutes: 60_000, hours: 3_600_000, days: 86_400_000 }
const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/

/** Data/hora local `YYYY-MM-DDTHH:MM[:SS]` (no fuso) ou ISO com Z/offset → instante. */
export function parseLocalDateTime(raw: string, timeZone: string): Date | null {
  const s = raw.trim()
  if (/[zZ]$|[+-]\d{2}:?\d{2}$/.test(s)) {
    const d = new Date(s)
    return Number.isNaN(d.getTime()) ? null : d
  }
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::\d{2})?)?$/.exec(s)
  if (!m) return null
  return zonedTime(Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4] ?? 0), Number(m[5] ?? 0), timeZone)
}

/**
 * Próximo instante do intervalo inteligente. `at = null` / `delayMs = 0`: segue agora (já passou, ou está dentro de
 * uma faixa semanal ativa).
 */
export function nextSmartInterval(config: SmartIntervalConfig, now: Date, timeZone: string): { at: Date | null; delayMs: number } {
  const done = { at: null, delayMs: 0 }
  if (config.schedule_type === 'time') {
    const ms = Math.max(0, Math.round((config.interval_value ?? 0) * (UNIT_MS[config.interval_unit ?? 'minutes'] ?? UNIT_MS.minutes!)))
    return ms > 0 ? { at: new Date(now.getTime() + ms), delayMs: ms } : done
  }
  if (config.schedule_type === 'date') {
    const at = config.scheduled_date ? parseLocalDateTime(config.scheduled_date, timeZone) : null
    if (!at || at.getTime() <= now.getTime()) return done
    return { at, delayMs: at.getTime() - now.getTime() }
  }
  if (config.schedule_type === 'weekly') {
    const days = config.weekly_schedule ?? {}
    const local = localParts(now, timeZone)
    const minutes = (hhmm: string) => {
      const m = HHMM.exec(hhmm)
      return m ? Number(m[1]) * 60 + Number(m[2]) : null
    }
    // Dentro de uma faixa ativa de hoje: segue agora.
    const today = days[WEEKDAY_NAMES[local.weekday]!]
    const nowMin = local.hour * 60 + local.minute
    if (today?.enabled) {
      const s = minutes(today.start_time ?? '')
      const e = minutes(today.end_time ?? '')
      if (s !== null && e !== null && nowMin >= s && nowMin < e) return done
    }
    // Próximo início ativo: hoje mais tarde ou nos 7 dias seguintes (meio-dia evita erro no horário de verão).
    const noon = zonedTime(local.year, local.month, local.day, 12, 0, timeZone)
    for (let offset = 0; offset <= 7; offset++) {
      const day = localParts(new Date(noon.getTime() + offset * 86_400_000), timeZone)
      const slot = days[WEEKDAY_NAMES[day.weekday]!]
      const s = slot?.enabled ? minutes(slot.start_time ?? '') : null
      if (s === null) continue
      const at = zonedTime(day.year, day.month, day.day, Math.floor(s / 60), s % 60, timeZone)
      if (at.getTime() > now.getTime()) return { at, delayMs: at.getTime() - now.getTime() }
    }
    return done
  }
  return done
}

// ---------------------------------------------------------------- distribuidor

export interface DistributorOutput {
  id: string
  name?: string
  quantity?: number
}

/**
 * Saída do próximo contato. Proporcional: menor `(count + 1) / quantity` (round-robin ponderado e suave; empate pela
 * ordem; quantity ausente = 1, 0 = nunca, todas 0 = iguais). `alwaysNext`: a saída seguinte à `lastId`.
 */
export function pickDistributorOutput(
  outputs: readonly DistributorOutput[],
  counts: Readonly<Record<string, number>>,
  opts: { alwaysNext?: boolean; lastId?: string | null } = {},
): string | null {
  if (!outputs.length) return null
  if (opts.alwaysNext) {
    const i = opts.lastId ? outputs.findIndex((o) => o.id === opts.lastId) : -1
    return outputs[(i + 1) % outputs.length]!.id
  }
  const weights = outputs.map((o) => (o.quantity === undefined || o.quantity === null ? 1 : Math.max(0, o.quantity)))
  const w = weights.some((x) => x > 0) ? weights : weights.map(() => 1)
  let best: string | null = null
  let score = Number.POSITIVE_INFINITY
  outputs.forEach((o, i) => {
    if (w[i]! <= 0) return
    const s = ((counts[o.id] ?? 0) + 1) / w[i]!
    if (s < score) {
      score = s
      best = o.id
    }
  })
  return best
}
