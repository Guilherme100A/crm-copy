// Renderização única de variáveis (SPEC T11; 06-fluxos.md §3.9, 17 §3.C, 03-chats F49).
// Sintaxes: `{nome}` (fluxos, respostas rápidas, modelos), `{g_nome}` (variável global), `{{customer.campo}}` /
// `{{global.g_nome}}` (respostas rápidas), dot-path com índice (`{response.data.0.status}`); `\{` escapa.
// Só lê propriedades próprias de objetos simples e arrays: nada é executado, nenhum protótipo é acessado.

export const DEFAULT_TIME_ZONE = 'America/Sao_Paulo'

export interface TemplateContact {
  full_name?: string | null
  first_name?: string | null
  phone_number?: string | null
  email?: string | null
  created_at?: Date | string | null
  /** Campos personalizados, pelo nome. */
  custom_fields?: Record<string, unknown> | null
  [field: string]: unknown
}

export interface TemplateScope {
  contact?: TemplateContact | null
  /** Variáveis globais da empresa; chave com ou sem o prefixo `g_`. */
  globals?: Record<string, unknown> | null
  /** Variáveis do fluxo e do sistema (`response`, `ai`, `gateway`, `attendant_name`, `instance_name`…). */
  vars?: Record<string, unknown> | null
  now?: Date | (() => Date)
}

export interface RenderOptions {
  /** Fuso das variáveis de data/hora (padrão `America/Sao_Paulo`). */
  timeZone?: string
  /** Variável sem valor: `'empty'` (padrão) troca por vazio; `'keep'` mantém o token original. */
  missing?: 'empty' | 'keep'
  /** Relógio (prevalece sobre `scope.now`). */
  now?: Date | (() => Date)
}

const FORBIDDEN = new Set(['__proto__', 'constructor', 'prototype'])

/** `{{ caminho }}` ou `{ caminho }`; só nomes de variável (letras, números, `_`, `.`, `-`, espaço). JSON fica intacto. */
const TOKEN = /\\\{|\{\{\s*([\p{L}\p{N}_.\- ]{1,120}?)\s*\}\}|\{\s*([\p{L}\p{N}_.\- ]{1,120}?)\s*\}/gu

/** Sentinela: caminho proibido (sempre vazio, mesmo com `keep`). */
const BLOCKED = Symbol('blocked')

/**
 * Lê `segments` a partir de `root` só por propriedades PRÓPRIAS DE DADOS: herdadas (protótipo) não existem para o
 * template e getters próprios nunca são executados.
 */
function readPath(root: unknown, segments: string[]): unknown {
  let current = root
  for (const seg of segments) {
    if (FORBIDDEN.has(seg)) return BLOCKED
    if (typeof current !== 'object' || current === null) return undefined
    const desc = Object.getOwnPropertyDescriptor(current, seg)
    if (!desc || !('value' in desc)) return undefined
    current = desc.value
  }
  return current
}

/** Primeiro nome: primeira palavra do nome completo. */
export function firstName(fullName: string | null | undefined): string {
  return (fullName ?? '').trim().split(/\s+/)[0] ?? ''
}

function parts(date: Date, timeZone: string) {
  const fmt = new Intl.DateTimeFormat('pt-BR', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  })
  const p = Object.fromEntries(fmt.formatToParts(date).map((x) => [x.type, x.value]))
  return { year: p.year!, month: p.month!, day: p.day!, hour: p.hour!, minute: p.minute!, second: p.second! }
}

/** "Bom dia" (até 11:59), "Boa tarde" (12:00–17:59), "Boa noite" (18:00 em diante), no fuso dado. */
export function greeting(date: Date, timeZone = DEFAULT_TIME_ZONE): string {
  const hour = Number(parts(date, timeZone).hour)
  return hour < 12 ? 'Bom dia' : hour < 18 ? 'Boa tarde' : 'Boa noite'
}

const toDate = (v: unknown): Date | undefined => {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? undefined : v
  if (typeof v === 'string' || typeof v === 'number') {
    const d = new Date(v)
    return Number.isNaN(d.getTime()) ? undefined : d
  }
  return undefined
}

function systemVar(name: string, ctx: { now: () => Date; timeZone: string }): string | undefined {
  switch (name) {
    case 'saudacao':
      return greeting(ctx.now(), ctx.timeZone)
    case 'hora': {
      const p = parts(ctx.now(), ctx.timeZone)
      return `${p.hour}:${p.minute}`
    }
    case 'data': {
      const p = parts(ctx.now(), ctx.timeZone)
      return `${p.day}/${p.month}`
    }
    case 'dia':
      return new Intl.DateTimeFormat('pt-BR', { timeZone: ctx.timeZone, weekday: 'long' }).format(ctx.now())
    default:
      return undefined
  }
}

function contactField(contact: TemplateContact | null | undefined, field: string, timeZone: string): unknown {
  if (!contact || FORBIDDEN.has(field)) return FORBIDDEN.has(field) ? BLOCKED : undefined
  if (field === 'first_name') {
    const own = readPath(contact, ['first_name'])
    const full = readPath(contact, ['full_name'])
    return (typeof own === 'string' && own) || firstName(typeof full === 'string' ? full : '') || undefined
  }
  if (field === 'created_at') {
    const d = toDate(readPath(contact, ['created_at']))
    if (!d) return undefined
    const p = parts(d, timeZone)
    return `${p.day}/${p.month}/${p.year} ${p.hour}:${p.minute}:${p.second}`
  }
  if (field === 'custom_fields') return undefined
  const direct = readPath(contact, [field])
  if (direct !== undefined) return direct
  const custom = readPath(readPath(contact, ['custom_fields']), [field])
  // T123: `{{customer.name}}` / `{name}` (referência) = nome completo, só quando nada mais resolve (`name` do
  // contato ou campo personalizado `name` continuam valendo como antes).
  if (custom === undefined && field === 'name') {
    const full = readPath(contact, ['full_name'])
    return typeof full === 'string' && full ? full : undefined
  }
  return custom
}

function globalVar(globals: Record<string, unknown> | null | undefined, name: string): unknown {
  if (!globals) return undefined
  const bare = name.startsWith('g_') ? name.slice(2) : name
  const withPrefix = readPath(globals, [`g_${bare}`])
  return withPrefix !== undefined ? withPrefix : readPath(globals, [bare])
}

function resolve(path: string, doubleBrace: boolean, scope: TemplateScope, ctx: { now: () => Date; timeZone: string }): unknown {
  const segments = path.split('.').map((s) => s.trim())
  if (segments.some((s) => FORBIDDEN.has(s))) return BLOCKED
  const [head, ...rest] = segments as [string, ...string[]]

  if (doubleBrace && (head === 'customer' || head === 'contact') && rest.length) {
    const field = contactField(scope.contact, rest[0]!, ctx.timeZone)
    return rest.length > 1 ? readPath(field, rest.slice(1)) : field
  }
  if (doubleBrace && head === 'global' && rest.length) return globalVar(scope.globals, rest.join('.'))
  if (head.startsWith('g_') && rest.length === 0) return globalVar(scope.globals, head)

  const fromVars = readPath(scope.vars ?? undefined, segments)
  if (fromVars !== undefined) return fromVars
  if (rest.length === 0) {
    const fromContact = contactField(scope.contact, head, ctx.timeZone)
    if (fromContact !== undefined) return fromContact
    return systemVar(head, ctx)
  }
  return undefined
}

function stringify(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value)
  if (value instanceof Date) return value.toISOString()
  if (typeof value === 'function' || typeof value === 'symbol') return ''
  try {
    return JSON.stringify(value)
  } catch {
    return ''
  }
}

/** Interpola as variáveis do template. Nunca lança por variável ausente ou valor estranho. */
export function render(template: string, scope: TemplateScope = {}, opts: RenderOptions = {}): string {
  if (!template) return ''
  const clock = opts.now ?? scope.now
  const now = typeof clock === 'function' ? clock : clock ? () => clock : () => new Date()
  const ctx = { now, timeZone: opts.timeZone ?? DEFAULT_TIME_ZONE }
  const keep = opts.missing === 'keep'
  return template.replace(TOKEN, (token, double: string | undefined, single: string | undefined) => {
    if (token === '\\{') return '{'
    const value = resolve((double ?? single)!, double !== undefined, scope, ctx)
    if (value === BLOCKED) return ''
    const out = stringify(value)
    if (out === undefined) return keep ? token : ''
    return out
  })
}

/** Nomes/caminhos de variável referenciados no template (sem duplicatas, na ordem). */
export function extractVariables(template: string): string[] {
  const seen = new Set<string>()
  for (const m of (template ?? '').matchAll(TOKEN)) {
    const path = m[1] ?? m[2]
    if (path) seen.add(path.trim())
  }
  return [...seen]
}
