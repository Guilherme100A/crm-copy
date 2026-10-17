// Regras puras dos editores de nó da T56 (06 §3.6): configs padrão, validação pelo schema do T10 (`@crm/shared/flows`)
// com o erro levado ao campo, ordem das ações, inserção de variável e a prévia do Pix (réplica de
// `packages/core/src/flows/nodes/messaging/pix.ts`, que a web não importa).
import { getActionSchema, NODE_ACTIONS, type FlowAction } from '@crm/shared/flows'
import { newId } from '../../canvas/model'

type Config = Record<string, unknown>

/** Ações do nó Mensagem, na ordem do editor. */
export const MESSAGE_ACTION_TYPES = NODE_ACTIONS.message

/** Referência de mídia enviada pelo `POST /api/media` (T49): o wa-worker troca `blob:<sha256>` pelos bytes. */
export const blobRef = (sha256: string) => `blob:${sha256}`
export const isBlobRef = (url: unknown): url is string => typeof url === 'string' && url.startsWith('blob:')

/** Config inicial de cada ação (textos padrão vêm do i18n). */
export function defaultConfig(type: string, texts: { buttonLabel?: string; carouselText?: string } = {}): Config {
  switch (type) {
    case 'send_message':
      return { message_text: '' }
    case 'send_multi_media':
      return { media_type: 'image', media_source: 'file' }
    case 'send_file':
      return { media_source: 'file', file_name: '' }
    case 'send_sticker':
      return { media_source: 'file', sticker_name: '' }
    case 'send_contact':
      return { contact_name: '', contact_phone: '' }
    case 'delay_between_messages':
      return { delay_seconds: 3 }
    case 'send_pix_button':
      return { pix_type: 'EVP', pix_key: '' }
    case 'send_notification':
      return { name: '', country_code: '55', phone: '', message: '' }
    case 'save_user_data':
      return { field_name: '', save_empty: true }
    case 'wait_for_response':
      return { timeout_value: 1, timeout_unit: 'days' }
    case 'send_interactive_menu':
    case 'send_option_list':
      return { menuType: 'list', message: '', buttonLabel: texts.buttonLabel ?? '', options: [], timeout_value: 0, timeout_unit: 'days' }
    case 'send_carousel':
      return { text: texts.carouselText ?? '', gatilho: { timeout_value: 0, timeout_unit: 'days' }, carousel: [] }
    default:
      return {}
  }
}

export const newAction = (type: string, config: Config, random?: () => number): FlowAction => ({ id: newId('a', random), type, order: 0, config })

/** `order` = posição na lista (o motor executa por `order`). */
export const withOrder = (actions: readonly FlowAction[]): FlowAction[] => actions.map((a, i) => (a.order === i ? a : { ...a, order: i }))

export function moveItem<T>(items: readonly T[], from: number, to: number): T[] {
  if (from === to || from < 0 || to < 0 || from >= items.length || to >= items.length) return [...items]
  const next = [...items]
  const [item] = next.splice(from, 1)
  next.splice(to, 0, item as T)
  return next
}

/** Troca um campo; `undefined` (ou texto vazio em campo opcional) remove a chave, para o schema não ver `''`. */
export function setField(config: Config, key: string, value: unknown): Config {
  const next = { ...config }
  if (value === undefined) delete next[key]
  else next[key] = value
  return next
}

/** Texto digitado em campo opcional: vazio vira ausente. */
export const optional = (value: string): string | undefined => (value.trim() ? value : undefined)

/** Inteiro digitado (vazio/inválido → `undefined`). */
export function intOf(raw: string): number | undefined {
  if (!raw.trim()) return undefined
  const n = Number(raw)
  return Number.isFinite(n) ? Math.trunc(n) : undefined
}

// ---------------------------------------------------------------- validação

export interface FieldError {
  /** Chave i18n em `node-editors-messaging:errors.*`. */
  key: string
  vars?: Record<string, string | number>
}

/** Erros por caminho do campo (`message_text`, `options.0.title`), o primeiro de cada um. */
export type FieldErrors = Record<string, FieldError>

interface IssueLike {
  code?: string
  path: PropertyKey[]
  message: string
  origin?: string
  minimum?: number | bigint
  maximum?: number | bigint
}

// Mensagens próprias dos schemas do T10 (em pt) → chaves traduzidas.
const CUSTOM: Array<[RegExp, string]> = [
  [/31 dias/, 'maxWait'],
  [/texto do botão/, 'required'],
  [/informe a mídia/, 'media'],
  [/informe o atraso/, 'required'],
  [/mínimo maior/, 'minMax'],
  [/chave Pix/, 'pixKey'],
  [/imagem/, 'image'],
  [/REPLY repetidos/, 'duplicateReply'],
  [/id repetido/, 'duplicateId'],
  [/telefone/, 'phone'],
  [/handle/, 'handle'],
  [/IA/, 'aiAudio'],
]

/** Mensagem de um issue do zod como chave de i18n. */
export function issueError(issue: IssueLike): FieldError {
  switch (issue.code) {
    case 'invalid_type':
      return { key: 'required' }
    case 'too_small':
      if (issue.origin === 'string') return { key: 'required' }
      if (issue.origin === 'array') return { key: 'minItems', vars: { min: Number(issue.minimum) } }
      return { key: 'min', vars: { min: Number(issue.minimum) } }
    case 'too_big':
      if (issue.origin === 'array') return { key: 'maxItems', vars: { max: Number(issue.maximum) } }
      return { key: 'max', vars: { max: Number(issue.maximum) } }
    case 'invalid_format':
      return { key: /telefone/.test(issue.message) ? 'phone' : /handle/.test(issue.message) ? 'handle' : 'format' }
    case 'invalid_value':
      return { key: 'format' }
    default: {
      const hit = CUSTOM.find(([re]) => re.test(issue.message))
      return hit ? { key: hit[1] } : { key: 'invalid' }
    }
  }
}

export const pathKey = (path: readonly PropertyKey[]) => path.filter((p) => typeof p !== 'symbol').join('.')

/** Valida a config pelo schema do T10; `{}` = válida. Ação sem schema (fora da T10) não bloqueia. */
export function validateConfig(type: string, config: Config): FieldErrors {
  const result = getActionSchema(type)?.safeParse(config)
  if (!result || result.success) return {}
  const out: FieldErrors = {}
  for (const issue of result.error.issues as IssueLike[]) {
    const key = pathKey(issue.path)
    if (!(key in out)) out[key] = issueError(issue)
  }
  return out
}

/** Erros por id de ação (só as ações com erro). */
export function validateActions(actions: readonly FlowAction[]): Record<string, FieldErrors> {
  const out: Record<string, FieldErrors> = {}
  for (const a of actions) {
    const errs = validateConfig(a.type, a.config)
    if (Object.keys(errs).length) out[a.id] = errs
  }
  return out
}

export const hasErrors = (errors: Record<string, FieldErrors>) => Object.keys(errors).length > 0

/** Erros que começam por `prefix.` (ex.: os da opção `options.2`), com o caminho relativo. */
export function errorsUnder(errors: FieldErrors | undefined, prefix: string): FieldErrors {
  const out: FieldErrors = {}
  for (const [k, v] of Object.entries(errors ?? {})) if (k.startsWith(`${prefix}.`)) out[k.slice(prefix.length + 1)] = v
  return out
}

// ---------------------------------------------------------------- variáveis

/** Variáveis de 06 §3.9 oferecidas no seletor (contato e sistema); globais e campos vêm da API. */
export const CONTACT_VARIABLES = ['full_name', 'first_name', 'phone_number', 'email', 'created_at'] as const
export const SYSTEM_VARIABLES = ['attendant_name', 'user_email', 'instance_number', 'instance_name', 'hora', 'data', 'dia', 'saudacao', 'last_user_message'] as const

/** Grupos do seletor sem repetir nome (os campos do sistema também vêm de `/api/custom-fields`); grupo vazio sai. */
export function variableGroups<G extends { names: readonly string[] }>(groups: G[]): G[] {
  const seen = new Set<string>()
  return groups
    .map((g) => ({ ...g, names: g.names.filter((n) => !seen.has(n) && !!seen.add(n)) }))
    .filter((g) => g.names.length > 0)
}

/** Insere `{nome}` no texto entre `start` e `end` (seleção); devolve o texto e a posição do cursor. */
export function insertVariable(value: string, name: string, start = value.length, end = start): { value: string; caret: number } {
  const token = `{${name}}`
  const a = Math.max(0, Math.min(start, value.length))
  const b = Math.max(a, Math.min(end, value.length))
  return { value: value.slice(0, a) + token + value.slice(b), caret: a + token.length }
}

// ---------------------------------------------------------------- mídia

export type MultiMediaType = 'image' | 'video' | 'audio'

/** Tipo de `send_multi_media` pelo mime do arquivo (documento → `null`). */
export function mediaTypeOf(mime: string): MultiMediaType | null {
  const m = mime.toLowerCase()
  if (m.startsWith('image/')) return 'image'
  if (m.startsWith('video/')) return 'video'
  if (m.startsWith('audio/')) return 'audio'
  return null
}

/** URL exibível na prévia: http(s), ou a mídia enviada (`media_id`) servida por `GET /api/media/:id`. */
export function previewUrl(url: unknown, mediaId: unknown): string | null {
  if (typeof mediaId === 'string' && mediaId) return `/api/media/${encodeURIComponent(mediaId)}`
  if (typeof url === 'string' && /^https?:\/\//i.test(url.trim())) return url.trim()
  return null
}

// ---------------------------------------------------------------- Pix (réplica do core)

export const PIX_KEY_TYPES = ['EVP', 'CPF', 'CNPJ', 'PHONE', 'EMAIL'] as const
export type PixKeyType = (typeof PIX_KEY_TYPES)[number]

const utf8 = (s: string) => new TextEncoder().encode(s)

/** CRC16-CCITT-FALSE em 4 hex maiúsculos (campo 63 do BR Code). */
export function crc16ccitt(payload: string): string {
  let crc = 0xffff
  for (const byte of utf8(payload)) {
    crc ^= byte << 8
    for (let i = 0; i < 8; i++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff
  }
  return crc.toString(16).toUpperCase().padStart(4, '0')
}

const emvField = (id: string, value: string) => {
  const len = utf8(value).length
  if (len > 99) throw new Error(`campo EMV ${id} com mais de 99 bytes`)
  return `${id}${String(len).padStart(2, '0')}${value}`
}

function ascii(value: string, max: number): string {
  return value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9 .,\-@/&]/g, '')
    .trim()
    .slice(0, max)
}

/** `"10,50"`, `"1.234,56"`, `10.5` → `"10.50"`; vazio, inválido ou ≤ 0 → `null`. */
export function pixAmount(amount: unknown): string | null {
  if (amount === null || amount === undefined) return null
  let raw: number
  if (typeof amount === 'number') raw = amount
  else {
    let s = String(amount).trim().replace(/\s|R\$/g, '')
    if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.')
    raw = s ? Number(s) : Number.NaN
  }
  if (!Number.isFinite(raw) || raw <= 0) return null
  return raw.toFixed(2)
}

export function normalizePixKey(key: string, type?: PixKeyType | null): string {
  const k = key.trim()
  const digits = k.replace(/\D/g, '')
  const kind: PixKeyType =
    type ??
    (k.includes('@') ? 'EMAIL' : k.startsWith('+') ? 'PHONE' : /^[\d./-]+$/.test(k) && digits.length === 11 ? 'CPF' : /^[\d./-]+$/.test(k) && digits.length === 14 ? 'CNPJ' : 'EVP')
  switch (kind) {
    case 'CPF':
    case 'CNPJ':
      return digits
    case 'PHONE':
      return digits.length <= 11 ? `+55${digits}` : `+${digits}`
    default:
      return k.toLowerCase()
  }
}

export interface PixInput {
  key: string
  type?: PixKeyType | null
  merchantName?: string | null
  amount?: unknown
}

/** Payload "copia e cola" estático com CRC16 (cidade `BRASIL` e txid `***`, como o motor). */
export function pixEmv(input: PixInput): string {
  const key = normalizePixKey(input.key, input.type)
  if (!key) throw new Error('chave Pix obrigatória')
  const amount = pixAmount(input.amount)
  const payload =
    emvField('00', '01') +
    emvField('26', emvField('00', 'br.gov.bcb.pix') + emvField('01', key)) +
    emvField('52', '0000') +
    emvField('53', '986') +
    (amount ? emvField('54', amount) : '') +
    emvField('58', 'BR') +
    emvField('59', ascii(input.merchantName?.trim() || 'Pix', 25) || 'Pix') +
    emvField('60', 'BRASIL') +
    emvField('62', emvField('05', '***')) +
    '6304'
  return payload + crc16ccitt(payload)
}

/**
 * Texto que o nó Pix envia (`pixMessage` do motor). Com variável na chave ou no valor, o código depende do contato:
 * `emv` é `null` e a prévia mostra o aviso de "gerado no envio".
 */
export function pixPreview(config: Config): { text: string; emv: string | null } {
  const key = typeof config.pix_key === 'string' ? config.pix_key.trim() : ''
  const merchant = typeof config.merchant_name === 'string' ? config.merchant_name.trim() : ''
  const rawAmount = config.amount_reais
  const dynamicAmount = typeof rawAmount === 'string' && rawAmount.includes('{')
  const amount = dynamicAmount ? null : pixAmount(rawAmount)
  const lines = [`Chave Pix: ${key}`]
  if (merchant) lines.push(`Recebedor: ${merchant}`)
  if (dynamicAmount) lines.push(`Valor: R$ ${String(rawAmount).trim()}`)
  else if (amount) lines.push(`Valor: R$ ${amount.replace('.', ',')}`)
  let emv: string | null = null
  if (key && !key.includes('{') && !dynamicAmount) {
    try {
      emv = pixEmv({ key, type: (config.pix_type as PixKeyType | undefined) ?? null, merchantName: merchant, amount: rawAmount })
    } catch {
      emv = null
    }
  }
  return { text: `${lines.join('\n')}\n\nPix copia e cola:`, emv }
}
