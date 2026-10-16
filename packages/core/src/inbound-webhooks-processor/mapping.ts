// Mapeamento do corpo do webhook (T81; 09 §3.2): segmentos `literal|path` concatenados, variáveis `{caminho}` no
// "número que dispara" e nos valores do Kanban, e as condições de disparo (`any`/`all`).
import type { WebhookCondition, WebhookSegment } from '../inbound-webhooks/config'

/** `getPath({ a: { b: [ { c: 1 } ] } }, 'a.b.0.c')` → 1. Aceita prefixo `body.` (o corpo é a raiz). */
export function readPath(root: unknown, path: string): unknown {
  let cur: unknown = root
  const segs = path.split('.').map((s) => s.trim()).filter(Boolean)
  if (segs[0] === 'body' && !(root && typeof root === 'object' && 'body' in (root as object))) segs.shift()
  for (const seg of segs) {
    if (seg === '__proto__' || seg === 'constructor' || seg === 'prototype') return undefined
    if (cur === null || cur === undefined) return undefined
    cur = Array.isArray(cur) && /^\d+$/.test(seg) ? cur[Number(seg)] : (cur as Record<string, unknown>)[seg]
  }
  return cur
}

const asText = (v: unknown): string => {
  if (v === null || v === undefined) return ''
  if (typeof v === 'string') return v
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  return JSON.stringify(v)
}

/** Segmentos → texto (path ausente = vazio). */
export function resolveSegments(body: unknown, segments: readonly WebhookSegment[] | undefined | null): string {
  return (segments ?? []).map((s) => (s.kind === 'literal' ? s.value : asText(readPath(body, s.value)))).join('').trim()
}

/** `{caminho.do.campo}` → valor do corpo; texto sem chaves fica como está. */
export function renderVars(body: unknown, template: string): string {
  return template.replace(/\{([^{}]+)\}/g, (_m, p: string) => asText(readPath(body, p.trim()))).trim()
}

export const digitsOf = (v: string) => v.replace(/\D/g, '')

export interface ConditionSubject {
  name: string
  phone: string
  email: string
  customFields: Record<string, unknown>
  /** Nomes das etiquetas do contato (minúsculas). */
  labels: Set<string>
}

const norm = (v: unknown) => asText(v).trim().toLowerCase()

function compare(op: string, actual: string, expected: string): boolean {
  switch (op) {
    case 'equal':
      return actual === expected
    case 'different':
      return actual !== expected
    case 'contains':
      return actual.includes(expected)
    case 'not_contains':
      return !actual.includes(expected)
    case 'starts_with':
      return actual.startsWith(expected)
    case 'has_value':
      return actual.length > 0
    default:
      return false
  }
}

export function conditionHolds(c: WebhookCondition, s: ConditionSubject): boolean {
  if (c.category === 'system') {
    const has = s.labels.has(norm(c.tagName))
    return c.systemOperator === 'equal' ? has : !has
  }
  const actual = c.category === 'field' ? norm(c.fieldName === 'name' ? s.name : c.fieldName === 'phone' ? s.phone : s.email) : norm(s.customFields[norm(c.fieldName)])
  return compare(c.fieldOperator, actual, norm(c.fieldValue ?? ''))
}

/** Sem regras = dispara sempre. */
export function conditionsMet(rules: { ruleType: 'all' | 'any'; conditions: WebhookCondition[] } | undefined | null, s: ConditionSubject): boolean {
  if (!rules || !rules.conditions.length) return true
  return rules.ruleType === 'any' ? rules.conditions.some((c) => conditionHolds(c, s)) : rules.conditions.every((c) => conditionHolds(c, s))
}
