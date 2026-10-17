// Regras das fontes de venda replicadas do servidor (T73, `packages/core/src/sale-sources/{service,mapping}.ts`): campos
// do `SaleEvent`, JSONPath aceito, mapa de status, segredo HMAC gerado no navegador e a assinatura esperada pelo
// recebimento (`x-signature` = HMAC-SHA256 do corpo cru em hex). A web não importa `@crm/core`.

export const SALE_EVENT_FIELDS = [
  'external_id',
  'status',
  'amount',
  'phone',
  'currency',
  'sold_at',
  'name',
  'email',
  'product_id',
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_content',
  'utm_term',
  'ctwa_clid',
  'source_id',
  'source_url',
] as const
export type SaleEventField = (typeof SALE_EVENT_FIELDS)[number]
export const REQUIRED_SALE_EVENT_FIELDS: readonly SaleEventField[] = ['external_id', 'status', 'amount', 'phone']
export const SALE_EVENT_STATUSES = ['approved', 'refunded', 'chargeback', 'pending'] as const
export type SaleEventStatus = (typeof SALE_EVENT_STATUSES)[number]
export const AMOUNT_UNITS = ['decimal', 'cents'] as const
export type AmountUnit = (typeof AMOUNT_UNITS)[number]
/** Status do evento recebido (log, AC-T90-03). */
export const INBOUND_EVENT_STATUSES = ['pending', 'processed', 'failed'] as const
export type InboundEventStatus = (typeof INBOUND_EVENT_STATUSES)[number]

export const SOURCE_NAME_MIN = 2
export const SOURCE_NAME_MAX = 120
export const PATH_MAX = 300
export const STATUS_RAW_MAX = 100
export const SIGNATURE_HEADER = 'x-signature'

/** Mesmo parser do servidor (`parseJsonPath`): `$.a.b`, `$.x[0].y`, `$['a b']` e o primeiro segmento sem `$`. */
export function parseJsonPath(path: string): (string | number)[] | null {
  let s = path.trim()
  if (!s) return null
  if (s.startsWith('$')) s = s.slice(1)
  const out: (string | number)[] = []
  let i = 0
  while (i < s.length) {
    const ch = s[i]!
    if (ch === '.') {
      i++
      const m = /^[^.[\]]+/.exec(s.slice(i))
      if (!m) return null
      out.push(m[0])
      i += m[0].length
    } else if (ch === '[') {
      const rest = s.slice(i)
      const idx = /^\[(\d+)\]/.exec(rest)
      const quoted = /^\[(['"])(.*?)\1\]/.exec(rest)
      if (idx) {
        out.push(Number(idx[1]))
        i += idx[0].length
      } else if (quoted) {
        out.push(quoted[2]!)
        i += quoted[0].length
      } else return null
    } else if (i === 0) {
      const m = /^[^.[\]]+/.exec(s)
      if (!m) return null
      out.push(m[0])
      i += m[0].length
    } else return null
  }
  return out.length ? out : null
}

/** Caminho do filho na árvore da amostra: `$.a`, `$.a[0]`, `$['a b']` (chave fora de `[\w-]`). */
export function childPath(parent: string, key: string | number): string {
  const base = parent || '$'
  if (typeof key === 'number') return `${base}[${key}]`
  return /^[A-Za-z_$][\w$-]*$/.test(key) ? `${base}.${key}` : `${base}['${key.replace(/'/g, '')}']`
}

export type MappingDraft = Partial<Record<SaleEventField, string>>
export type MappingIssue = 'required' | 'invalid'

/** Um problema por campo: obrigatório vazio ou JSONPath fora do aceito. */
export function mappingIssues(mapping: MappingDraft): Partial<Record<SaleEventField, MappingIssue>> {
  const out: Partial<Record<SaleEventField, MappingIssue>> = {}
  for (const f of SALE_EVENT_FIELDS) {
    const v = (mapping[f] ?? '').trim()
    if (!v) {
      if (REQUIRED_SALE_EVENT_FIELDS.includes(f)) out[f] = 'required'
    } else if (v.length > PATH_MAX || !parseJsonPath(v)) out[f] = 'invalid'
  }
  return out
}

/** Só os campos preenchidos (o schema do servidor recusa string vazia). */
export function cleanMapping(mapping: MappingDraft): Record<string, string> {
  const out: Record<string, string> = {}
  for (const f of SALE_EVENT_FIELDS) {
    const v = (mapping[f] ?? '').trim()
    if (v) out[f] = v
  }
  return out
}

export interface StatusRow {
  raw: string
  status: SaleEventStatus
}

export const statusRowsFrom = (map: Record<string, string> | null | undefined): StatusRow[] =>
  Object.entries(map ?? {})
    .filter((e): e is [string, SaleEventStatus] => (SALE_EVENT_STATUSES as readonly string[]).includes(e[1]))
    .map(([raw, status]) => ({ raw, status }))

/** Linhas → `status_map` (valor bruto aparado e em minúsculas, como o servidor grava; linhas vazias saem). */
export function statusMapFrom(rows: readonly StatusRow[]): Record<string, SaleEventStatus> {
  const out: Record<string, SaleEventStatus> = {}
  for (const r of rows) {
    const raw = r.raw.trim().toLowerCase()
    if (raw && raw.length <= STATUS_RAW_MAX) out[raw] = r.status
  }
  return out
}

export const validSourceName = (name: string) => {
  const n = name.trim()
  return n.length >= SOURCE_NAME_MIN && n.length <= SOURCE_NAME_MAX
}

/** Amostra colada → objeto; JSON inválido → `{ ok: false }` (o servidor responde 422 em `sample`). */
export function parseSample(text: string): { ok: true; value: unknown } | { ok: false } {
  if (!text.trim()) return { ok: false }
  try {
    return { ok: true, value: JSON.parse(text) }
  } catch {
    return { ok: false }
  }
}

/** Segredo HMAC forte gerado no navegador (32 bytes aleatórios em hex = 64 caracteres; o servidor aceita até 500). */
export function generateSecret(
  bytes = 32,
  rnd: (a: Uint8Array<ArrayBuffer>) => Uint8Array = (a) => crypto.getRandomValues(a),
): string {
  return Array.from(rnd(new Uint8Array(bytes)), (b) => b.toString(16).padStart(2, '0')).join('')
}

/** Assinatura que o integrador envia em `x-signature` (HMAC-SHA256 do corpo cru em hex), pela Web Crypto. */
export async function signBody(secret: string, body: string): Promise<string> {
  const enc = new TextEncoder()
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
  ])
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(body))
  return Array.from(new Uint8Array(sig), (b) => b.toString(16).padStart(2, '0')).join('')
}

/** Mapeamento inicial de uma fonte nova: caminhos comuns (`$.id`, `$.status`, `$.amount`, `$.customer.phone`). */
export const DEFAULT_MAPPING: MappingDraft = {
  external_id: '$.id',
  status: '$.status',
  amount: '$.amount',
  phone: '$.customer.phone',
}
