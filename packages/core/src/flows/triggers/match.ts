// Casamento de palavras-chave (T61; 17 §3.F): seis tipos de condição combinados por `any` (OU) ou `all` (E).
// Comparação sem diferença de caixa, acentos e espaços nas pontas (o lead digita "Olá", "ola", " OLA ").
import type { KeywordCondition, KeywordMatchType, KeywordRuleType } from '@crm/db'

/** Minúsculas, sem acentos, espaços internos colapsados e sem espaços nas pontas. */
export function normalizeKeywordText(value: string | null | undefined): string {
  return (value ?? '')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
}

export function matchCondition(text: string, keyword: string, matchType: KeywordMatchType): boolean {
  const t = normalizeKeywordText(text)
  const k = normalizeKeywordText(keyword)
  if (!k) return false
  switch (matchType) {
    case 'equals':
      return t === k
    case 'contains':
      return t.includes(k)
    case 'different':
      return t !== k
    case 'excludes':
      return !t.includes(k)
    case 'starts_with':
      return t.startsWith(k)
    case 'ends_with':
      return t.endsWith(k)
  }
}

/** `any`: alguma condição casa; `all`: todas casam. Sem condições não casa. */
export function matchKeywordRule(text: string | null | undefined, rule: { rule_type: KeywordRuleType; conditions: readonly KeywordCondition[] }): boolean {
  if (rule.conditions.length === 0) return false
  const value = text ?? ''
  return rule.rule_type === 'all'
    ? rule.conditions.every((c) => matchCondition(value, c.keyword, c.match_type))
    : rule.conditions.some((c) => matchCondition(value, c.keyword, c.match_type))
}
