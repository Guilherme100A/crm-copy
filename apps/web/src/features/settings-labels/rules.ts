// Regras puras das etiquetas (replicam `packages/core/src/labels/service.ts`): nome 2–50, cor `#RRGGBB` maiúscula.
import type { LabelDto } from './api'

export const NAME_MIN = 2
export const NAME_MAX = 50
export const COLOR_RE = /^#[0-9A-Fa-f]{6}$/
export const PRESET_COLORS = [
  '#EF4444',
  '#F97316',
  '#EAB308',
  '#22C55E',
  '#14B8A6',
  '#3B82F6',
  '#6366F1',
  '#A855F7',
  '#EC4899',
  '#64748B',
] as const

export type LabelIssue = 'name' | 'color'

export function labelIssue(name: string, color: string): LabelIssue | null {
  const n = name.trim()
  if (n.length < NAME_MIN || n.length > NAME_MAX) return 'name'
  if (!COLOR_RE.test(color.trim())) return 'color'
  return null
}

/** `abc123` ou `#abc123` → `#ABC123`; o que não for hex fica como digitado (a validação acusa). */
export function normalizeColor(raw: string): string {
  const v = raw.trim()
  const hex = v.startsWith('#') ? v : `#${v}`
  return COLOR_RE.test(hex) ? hex.toUpperCase() : v
}

/** Texto legível sobre a cor (preto ou branco pela luminância). */
export function textOn(color: string): '#000000' | '#FFFFFF' {
  if (!COLOR_RE.test(color)) return '#000000'
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(color.slice(i, i + 2), 16) / 255)
  const lum = 0.2126 * r! + 0.7152 * g! + 0.0722 * b!
  return lum > 0.6 ? '#000000' : '#FFFFFF'
}

const fold = (s: string) =>
  s
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()

export function filterLabels(items: readonly LabelDto[], q: string): LabelDto[] {
  const n = fold(q.trim())
  return n ? items.filter((l) => fold(l.name).includes(n)) : [...items]
}
