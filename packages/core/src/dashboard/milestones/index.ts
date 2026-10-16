// Marcos de faturamento acumulado (T55; spec de marcos, feature 15 §3.2 e §4). Os limiares seguem a referência;
// nomes e descrições são próprios do produto (nada do texto de referência), com i18n pt-BR / en-US / es-ES.

export type MilestoneLocale = 'pt-BR' | 'en-US' | 'es-ES'

interface MilestoneDef {
  level: number
  key: string
  min_cents: number
  text: Record<MilestoneLocale, { name: string; description: string }>
}

const DEFS: readonly MilestoneDef[] = [
  {
    level: 1,
    key: 'first_mark',
    min_cents: 5_000_000,
    text: {
      'pt-BR': { name: 'Primeira Marca', description: 'Os primeiros R$ 50 mil vendidos pelo CRM.' },
      'en-US': { name: 'First Mark', description: 'Your first R$ 50k in sales through the CRM.' },
      'es-ES': { name: 'Primera Marca', description: 'Los primeros R$ 50 mil vendidos con el CRM.' },
    },
  },
  {
    level: 2,
    key: 'traction',
    min_cents: 10_000_000,
    text: {
      'pt-BR': { name: 'Tração', description: 'R$ 100 mil: a operação ganhou ritmo constante.' },
      'en-US': { name: 'Traction', description: 'R$ 100k: the operation has a steady pace.' },
      'es-ES': { name: 'Tracción', description: 'R$ 100 mil: la operación ganó un ritmo constante.' },
    },
  },
  {
    level: 3,
    key: 'scale',
    min_cents: 25_000_000,
    text: {
      'pt-BR': { name: 'Escala', description: 'R$ 250 mil: processos que se repetem e crescem.' },
      'en-US': { name: 'Scale', description: 'R$ 250k: repeatable processes that keep growing.' },
      'es-ES': { name: 'Escala', description: 'R$ 250 mil: procesos que se repiten y crecen.' },
    },
  },
  {
    level: 4,
    key: 'expansion',
    min_cents: 50_000_000,
    text: {
      'pt-BR': { name: 'Expansão', description: 'R$ 500 mil: hora de abrir novas frentes.' },
      'en-US': { name: 'Expansion', description: 'R$ 500k: time to open new fronts.' },
      'es-ES': { name: 'Expansión', description: 'R$ 500 mil: momento de abrir nuevos frentes.' },
    },
  },
  {
    level: 5,
    key: 'million_club',
    min_cents: 100_000_000,
    text: {
      'pt-BR': { name: 'Clube do Milhão', description: 'R$ 1 milhão em vendas acumuladas.' },
      'en-US': { name: 'Million Club', description: 'R$ 1 million in accumulated sales.' },
      'es-ES': { name: 'Club del Millón', description: 'R$ 1 millón en ventas acumuladas.' },
    },
  },
  {
    level: 6,
    key: 'market_reference',
    min_cents: 200_000_000,
    text: {
      'pt-BR': { name: 'Referência no Mercado', description: 'R$ 2 milhões: uma operação que serve de exemplo.' },
      'en-US': { name: 'Market Reference', description: 'R$ 2 million: an operation others look up to.' },
      'es-ES': { name: 'Referencia en el Mercado', description: 'R$ 2 millones: una operación que sirve de ejemplo.' },
    },
  },
]

export interface Milestone {
  level: number
  key: string
  name: string
  description: string
  min_cents: number
}

export interface MilestoneResult {
  /** 0 = sem selo. */
  level: number
  current: Milestone | null
  next: Milestone | null
  /** 0–100 até o próximo nível (100 no máximo). */
  progress_pct: number
  remaining_cents: number
  max_reached: boolean
}

const pick = (locale: string): MilestoneLocale => (locale === 'en-US' || locale === 'es-ES' ? locale : 'pt-BR')
const toMilestone = (d: MilestoneDef, locale: MilestoneLocale): Milestone => ({ level: d.level, key: d.key, min_cents: d.min_cents, ...d.text[locale] })

/** Os 6 níveis no idioma pedido (default pt-BR). */
export function milestones(locale: string = 'pt-BR'): Milestone[] {
  const l = pick(locale)
  return DEFS.map((d) => toMilestone(d, l))
}

export const MILESTONES: readonly Milestone[] = milestones('pt-BR')

/** Nível atual, próximo e progresso para um faturamento acumulado em centavos. */
export function computeMilestone(revenueCents: number, locale: string = 'pt-BR'): MilestoneResult {
  const l = pick(locale)
  const revenue = Number.isFinite(revenueCents) ? Math.max(0, revenueCents) : 0
  let current: MilestoneDef | null = null
  for (const d of DEFS) {
    if (d.min_cents <= revenue) current = d
    else break
  }
  const next = DEFS.find((d) => revenue < d.min_cents) ?? null
  const base = current?.min_cents ?? 0
  const progress = next ? Math.min(100, Math.max(0, ((revenue - base) / (next.min_cents - base)) * 100)) : 100
  return {
    level: current?.level ?? 0,
    current: current ? toMilestone(current, l) : null,
    next: next ? toMilestone(next, l) : null,
    progress_pct: Math.round(progress * 100) / 100,
    remaining_cents: next ? Math.max(0, next.min_cents - revenue) : 0,
    max_reached: next === null,
  }
}
