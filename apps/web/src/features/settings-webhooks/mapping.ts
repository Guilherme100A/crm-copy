// Mapeamento do corpo do webhook (T89 sobre a T81; 09 §3.2): segmentos `literal|path` concatenados por destino.
// `readPath`/`resolveSegments` reproduzem os do processador (notação de ponto, índice de array, prefixo `body.`).
// O aviso de identidade cobre a pendência da T81: `+55` + caminho ausente vira só "+55" no processamento.

export interface Segment {
  kind: 'literal' | 'path'
  value: string
}

export const IDENTITY_TARGETS = ['full_name', 'phone', 'email'] as const
export type IdentityTarget = (typeof IDENTITY_TARGETS)[number]

/** Destino do mapeamento: um campo de identidade ou `custom:<key>`. */
export type Target = IdentityTarget | `custom:${string}`

export interface MappingState {
  field_paths: Partial<Record<IdentityTarget, Segment[]>>
  custom: { field_key: string; segments: Segment[] }[]
}

const FORBIDDEN = new Set(['__proto__', 'constructor', 'prototype'])

export function readPath(root: unknown, path: string): unknown {
  let cur: unknown = root
  const segs = path.split('.').map((s) => s.trim()).filter(Boolean)
  if (segs[0] === 'body' && !(root && typeof root === 'object' && 'body' in (root as object))) segs.shift()
  for (const seg of segs) {
    if (FORBIDDEN.has(seg)) return undefined
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

export const resolveSegments = (body: unknown, segments: readonly Segment[] | undefined): string =>
  (segments ?? []).map((s) => (s.kind === 'literal' ? s.value : asText(readPath(body, s.value)))).join('').trim()

/** Corpo cru → JSON (ou `undefined` se não for JSON). */
export function parseBody(raw: string | null | undefined): unknown {
  if (!raw) return undefined
  try {
    return JSON.parse(raw)
  } catch {
    return undefined
  }
}

/** Corpo formatado para exibição (JSON indentado; texto cru se não for JSON). */
export function prettyBody(raw: string | null | undefined): string {
  const parsed = parseBody(raw)
  return parsed === undefined ? (raw ?? '') : JSON.stringify(parsed, null, 2)
}

const present = (v: unknown) => v !== undefined && v !== null && asText(v).trim() !== ''

/**
 * Aviso de identidade (nome/telefone): há literal e nenhum caminho que exista na amostra atual
 * (literal sozinho, caminho ausente, ou sem amostra para conferir).
 */
export function identityWarning(segments: readonly Segment[] | undefined, sample: unknown): boolean {
  const segs = segments ?? []
  if (!segs.some((s) => s.kind === 'literal' && s.value.trim())) return false
  const paths = segs.filter((s) => s.kind === 'path')
  if (!paths.length || sample === undefined) return true
  return !paths.some((s) => present(readPath(sample, s.value)))
}

const isSegment = (v: unknown): v is Segment =>
  !!v && typeof v === 'object' && ((v as Segment).kind === 'literal' || (v as Segment).kind === 'path') && typeof (v as Segment).value === 'string'

const segmentsOf = (v: unknown): Segment[] => (Array.isArray(v) ? v.filter(isSegment).map((s) => ({ kind: s.kind, value: s.value })) : [])

/** Config salvo → estado do editor. */
export function mappingFromConfig(config: Record<string, unknown> | null | undefined): MappingState {
  const fp = (config?.field_paths ?? {}) as Record<string, unknown>
  const field_paths: MappingState['field_paths'] = {}
  for (const k of IDENTITY_TARGETS) {
    const s = segmentsOf(fp[k])
    if (s.length) field_paths[k] = s
  }
  const custom = Array.isArray(config?.custom_field_mappings)
    ? (config.custom_field_mappings as unknown[])
        .filter((m): m is { field_key: string; segments: unknown } => !!m && typeof m === 'object' && typeof (m as { field_key?: unknown }).field_key === 'string')
        .map((m) => ({ field_key: m.field_key, segments: segmentsOf(m.segments) }))
    : []
  return { field_paths, custom }
}

/** Estado do editor → config (mantém o resto do config: etiquetas, kanban, fluxo, condições). */
export function configWithMapping(config: Record<string, unknown> | null | undefined, m: MappingState): Record<string, unknown> {
  const field_paths: Record<string, Segment[]> = {}
  for (const k of IDENTITY_TARGETS) if (m.field_paths[k]?.length) field_paths[k] = m.field_paths[k]!
  return {
    ...(config ?? {}),
    field_paths,
    custom_field_mappings: m.custom.filter((c) => c.field_key.trim()).map((c) => ({ field_key: c.field_key.trim(), segments: c.segments })),
  }
}

export function segmentsFor(m: MappingState, target: Target): Segment[] {
  if (target.startsWith('custom:')) return m.custom.find((c) => c.field_key === target.slice(7))?.segments ?? []
  return m.field_paths[target as IdentityTarget] ?? []
}

export function setSegments(m: MappingState, target: Target, segments: Segment[]): MappingState {
  if (target.startsWith('custom:')) {
    const key = target.slice(7)
    const exists = m.custom.some((c) => c.field_key === key)
    return { ...m, custom: exists ? m.custom.map((c) => (c.field_key === key ? { ...c, segments } : c)) : [...m.custom, { field_key: key, segments }] }
  }
  return { ...m, field_paths: { ...m.field_paths, [target]: segments } }
}

export const appendSegment = (m: MappingState, target: Target, seg: Segment): MappingState => setSegments(m, target, [...segmentsFor(m, target), seg])

export const removeSegment = (m: MappingState, target: Target, index: number): MappingState =>
  setSegments(
    m,
    target,
    segmentsFor(m, target).filter((_, i) => i !== index),
  )

export function addCustomField(m: MappingState, key: string): MappingState {
  const k = key.trim()
  if (!k || m.custom.some((c) => c.field_key === k)) return m
  return { ...m, custom: [...m.custom, { field_key: k, segments: [] }] }
}

/** Caminho do filho na árvore (`''` = raiz). */
export const childPath = (parent: string, key: string | number) => (parent ? `${parent}.${key}` : String(key))
