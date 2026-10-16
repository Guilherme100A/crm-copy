// Regras puras do conteúdo (T35; 17 §3A–3C): atalho normalizado, nome/valor de variável global e a montagem do
// modelo interno em texto (botões viram menu numerado e links, porque mensagens interativas ficam fora no Baileys).

export class ContentError extends Error {
  constructor(
    readonly kind: 'not_found' | 'validation' | 'conflict' | 'unsupported_media' | 'payload_too_large',
    message: string,
    readonly errorCode?: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message)
    this.name = 'ContentError'
  }
}

export const contentNotFound = (what: string) => new ContentError('not_found', `${what} não encontrado(a)`)
export const contentInvalid = (path: string, message: string, errorCode?: string) =>
  new ContentError('validation', message, errorCode, { fields: [{ path, message }] })

export const SHORTCUT_MAX = 60

/** Como o editor da referência: minúsculas, só `a-z 0-9 _ espaço -`; aqui também colapsa espaços e apara. */
export function normalizeShortcut(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9_ -]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

const GLOBAL_NAME_RE = /^[A-Za-z0-9_]+$/
export const NUMBER_VALUE_RE = /^-?\d+(\.\d+)?$/

/** `foo` → `g_foo` (o prefixo vem da criação); `g_foo` fica como está. Fora de `[A-Za-z0-9_]` → inválido. */
export function globalVariableName(raw: string): string {
  const name = raw.trim()
  if (!name || !GLOBAL_NAME_RE.test(name)) throw contentInvalid('name', 'Use apenas letras, números e underscore')
  const full = name.startsWith('g_') ? name : `g_${name}`
  if (full.length > 64) throw contentInvalid('name', 'Nome muito longo')
  return full
}

/** Tipo no fio `text|number`; aceita os valores persistidos pela referência (`Texto`/`Número`). */
export function globalVariableType(raw: string | undefined): 'text' | 'number' | undefined {
  if (raw === undefined) return undefined
  const v = raw.trim().toLowerCase()
  if (v === 'text' || v === 'texto') return 'text'
  if (v === 'number' || v === 'número' || v === 'numero') return 'number'
  throw contentInvalid('type', 'Tipo deve ser text ou number')
}

export function assertGlobalValue(type: 'text' | 'number', value: string | null | undefined) {
  if (type === 'number' && value !== null && value !== undefined && value !== '' && !NUMBER_VALUE_RE.test(value.trim()))
    throw contentInvalid('value', 'Valor numérico inválido (ex.: 10 ou -2.5)')
}

export const TEMPLATE_HEADER_TYPES = ['none', 'text', 'image', 'video', 'document'] as const
export type TemplateHeaderType = (typeof TEMPLATE_HEADER_TYPES)[number]
export const TEMPLATE_BUTTON_TYPES = ['reply', 'url', 'phone'] as const
export type TemplateButtonType = (typeof TEMPLATE_BUTTON_TYPES)[number]

export interface TemplateHeader {
  type: TemplateHeaderType
  text?: string | null
  media_id?: string | null
}
export interface TemplateButton {
  type: TemplateButtonType
  text: string
  url?: string | null
  phone?: string | null
}
export interface TemplateContent {
  header: TemplateHeader
  body: string
  footer?: string | null
  buttons: TemplateButton[]
}

/**
 * Modelo → texto da mensagem: cabeçalho de texto, corpo, menu numerado dos botões `reply` ("1 - Opção"), links dos
 * `url` e `phone` ("Texto: destino") e rodapé, em blocos separados por linha em branco. `interpolate` aplica as
 * variáveis (T11) em cada parte. Cabeçalho de mídia vai à parte em `media`.
 */
export function renderTemplateContent(
  t: TemplateContent,
  interpolate: (s: string) => string = (s) => s,
): { text: string; media: { type: Exclude<TemplateHeaderType, 'none' | 'text'>; media_id: string } | null } {
  const blocks: string[] = []
  if (t.header.type === 'text' && t.header.text?.trim()) blocks.push(interpolate(t.header.text.trim()))
  blocks.push(interpolate(t.body))
  const replies = t.buttons.filter((b) => b.type === 'reply')
  if (replies.length) blocks.push(replies.map((b, i) => `${i + 1} - ${interpolate(b.text)}`).join('\n'))
  const links = t.buttons.filter((b) => b.type !== 'reply')
  if (links.length) blocks.push(links.map((b) => `${interpolate(b.text)}: ${interpolate(String(b.type === 'url' ? b.url ?? '' : b.phone ?? ''))}`).join('\n'))
  if (t.footer?.trim()) blocks.push(interpolate(t.footer.trim()))
  const media =
    t.header.type !== 'none' && t.header.type !== 'text' && t.header.media_id ? { type: t.header.type, media_id: t.header.media_id } : null
  return { text: blocks.filter((b) => b.length > 0).join('\n\n'), media }
}
