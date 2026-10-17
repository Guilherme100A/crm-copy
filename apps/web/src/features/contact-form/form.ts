// Regras do formulário de contato (05 §3.1; T86): busca prévia de duplicados (≥ 2 caracteres, debounce 450 ms),
// telefone com seletor de país (lista própria + DDI) validado em E.164 por `@crm/shared`, modo "ID" para o LID do
// WhatsApp, UF por select (27 UFs, replicadas do core) com cidade livre que limpa ao trocar a UF, CEP com máscara
// `00000-000`, etiquetas e campos personalizados (linhas com nome vazio descartadas). Sem React: testável em node.
import { tryParsePhone } from '@crm/shared'

export const DUPLICATE_SEARCH_DEBOUNCE_MS = 450
export const DUPLICATE_SEARCH_MIN_CHARS = 2
export const DUPLICATE_SEARCH_LIMIT = 15

/** Termo da busca prévia (ou `null` abaixo do mínimo). */
export function duplicateSearchTerm(text: string): string | null {
  const term = text.trim()
  return term.length >= DUPLICATE_SEARCH_MIN_CHARS ? term : null
}

export interface Country {
  code: string
  dial: string
}

/** Principais países (BR primeiro; o padrão). Nomes vêm de `Intl.DisplayNames` no idioma da tela. */
export const COUNTRIES: readonly Country[] = [
  { code: 'BR', dial: '55' },
  { code: 'US', dial: '1' },
  { code: 'CA', dial: '1' },
  { code: 'PT', dial: '351' },
  { code: 'AR', dial: '54' },
  { code: 'UY', dial: '598' },
  { code: 'PY', dial: '595' },
  { code: 'CL', dial: '56' },
  { code: 'BO', dial: '591' },
  { code: 'PE', dial: '51' },
  { code: 'CO', dial: '57' },
  { code: 'VE', dial: '58' },
  { code: 'EC', dial: '593' },
  { code: 'MX', dial: '52' },
  { code: 'ES', dial: '34' },
  { code: 'FR', dial: '33' },
  { code: 'IT', dial: '39' },
  { code: 'DE', dial: '49' },
  { code: 'GB', dial: '44' },
  { code: 'IE', dial: '353' },
  { code: 'CH', dial: '41' },
  { code: 'NL', dial: '31' },
  { code: 'BE', dial: '32' },
  { code: 'JP', dial: '81' },
  { code: 'CN', dial: '86' },
  { code: 'IN', dial: '91' },
  { code: 'AU', dial: '61' },
  { code: 'IL', dial: '972' },
  { code: 'AO', dial: '244' },
  { code: 'MZ', dial: '258' },
  { code: 'ZA', dial: '27' },
]

export const DEFAULT_COUNTRY = 'BR'

export const countryOf = (code: string): Country => COUNTRIES.find((c) => c.code === code) ?? COUNTRIES[0]!

/** Bandeira em emoji a partir do código ISO. */
export const flagOf = (code: string) =>
  String.fromCodePoint(...[...code.toUpperCase()].map((ch) => 0x1f1e6 + ch.charCodeAt(0) - 65))

/** 27 UFs (mesma lista de `BR_STATES` do core, que a web não importa). */
export const BR_STATES = [
  'AC',
  'AL',
  'AP',
  'AM',
  'BA',
  'CE',
  'DF',
  'ES',
  'GO',
  'MA',
  'MT',
  'MS',
  'MG',
  'PA',
  'PB',
  'PR',
  'PE',
  'PI',
  'RJ',
  'RN',
  'RS',
  'RO',
  'RR',
  'SC',
  'SP',
  'SE',
  'TO',
] as const

const digitsOf = (s: string) => s.replace(/\D/g, '')

/** LID do WhatsApp (`123456789@lid`, com ou sem dispositivo): aceito como está, sem virar telefone. */
export const LID_RE = /^\d{5,25}(?::\d+)?@lid$/
export const isLid = (text: string) => LID_RE.test(text.trim())

export type PhoneError = 'required' | 'short' | 'long' | 'invalid'

export type PhoneResult = { ok: true; e164: string } | { ok: true; lid: string } | { ok: false; error: PhoneError }

/**
 * Valida o telefone digitado no país escolhido. BR: 10–11 dígitos (DDD + número); outros: 6–15; mínimo 8 no total
 * (com o DDI). Começando por `+` vale o DDI digitado. Saída em E.164 (normalizada pela lib de telefone do shared).
 */
export function validatePhone(countryCode: string, text: string): PhoneResult {
  const raw = text.trim()
  if (!raw) return { ok: false, error: 'required' }
  if (isLid(raw)) return { ok: true, lid: raw }
  const digits = digitsOf(raw)
  if (!digits) return { ok: false, error: 'invalid' }
  let candidate: string
  if (raw.startsWith('+')) {
    if (digits.length < 8) return { ok: false, error: 'short' }
    if (digits.length > 15) return { ok: false, error: 'long' }
    candidate = `+${digits}`
  } else {
    const country = countryOf(countryCode)
    const [min, max] = country.code === 'BR' ? [10, 11] : [6, 15]
    if (digits.length < min || country.dial.length + digits.length < 8) return { ok: false, error: 'short' }
    if (digits.length > max || country.dial.length + digits.length > 15) return { ok: false, error: 'long' }
    candidate = `+${country.dial}${digits}`
  }
  const e164 = tryParsePhone(candidate)
  return e164 ? { ok: true, e164 } : { ok: false, error: 'invalid' }
}

/**
 * Separa um E.164 salvo em país + número nacional (detecção de DDI ao editar): o DDI mais longo da lista que casar;
 * `+1` fica com US. Fora da lista o número fica inteiro com `+`.
 */
export function splitPhone(e164: string | null | undefined): { country: string; national: string } {
  if (!e164) return { country: DEFAULT_COUNTRY, national: '' }
  const digits = digitsOf(e164)
  let best: Country | null = null
  for (const c of COUNTRIES) if (digits.startsWith(c.dial) && (!best || c.dial.length > best.dial.length)) best = c
  return best
    ? { country: best.code, national: digits.slice(best.dial.length) }
    : { country: DEFAULT_COUNTRY, national: e164 }
}

/** Máscara `00000-000` (até 8 dígitos). */
export function maskZip(text: string): string {
  const d = digitsOf(text).slice(0, 8)
  return d.length > 5 ? `${d.slice(0, 5)}-${d.slice(5)}` : d
}

export const zipValid = (text: string) => {
  const d = digitsOf(text)
  return d.length === 0 || d.length === 8
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
export const emailValid = (text: string) => !text.trim() || EMAIL_RE.test(text.trim())

export interface CustomFieldRow {
  key: string
  value: string
}

export interface ContactFormValues {
  name: string
  country: string
  phone: string
  email: string
  state: string
  city: string
  zip: string
  labelIds: string[]
  customFields: CustomFieldRow[]
  /** Só edição (dados do anúncio CTWA). */
  ctwaClid: string
  sourceId: string
  sourceUrl: string
}

export const emptyForm = (): ContactFormValues => ({
  name: '',
  country: DEFAULT_COUNTRY,
  phone: '',
  email: '',
  state: '',
  city: '',
  zip: '',
  labelIds: [],
  customFields: [],
  ctwaClid: '',
  sourceId: '',
  sourceUrl: '',
})

/** Troca de UF: a cidade (texto livre) não vale para outra UF e é limpa. */
export function withState(values: ContactFormValues, state: string): ContactFormValues {
  return state === values.state ? values : { ...values, state, city: '' }
}

/** "Criar novo contato" a partir do termo buscado: e-mail, telefone (só dígitos/+) ou nome. */
export function formFromTerm(term: string): ContactFormValues {
  const t = term.trim()
  const form = emptyForm()
  if (t.includes('@') && !isLid(t)) return { ...form, email: t }
  if (/^\+?[\d\s().-]+$/.test(t) && digitsOf(t).length >= 4) {
    if (t.startsWith('+')) {
      const split = splitPhone(`+${digitsOf(t)}`)
      return { ...form, ...split, phone: split.national }
    }
    return { ...form, phone: digitsOf(t) }
  }
  return { ...form, name: t }
}

export interface ContactDetail {
  id: string
  name: string
  phone_e164: string | null
  wa_lid: string | null
  email: string | null
  state: string | null
  city: string | null
  zip: string | null
  custom_fields: Record<string, unknown> | null
  labels: { id: string; name: string; color: string | null }[]
  ctwa_clid?: string | null
  source_id?: string | null
  source_url?: string | null
}

export function formFromContact(c: ContactDetail): ContactFormValues {
  const split = splitPhone(c.phone_e164)
  return {
    name: c.name ?? '',
    country: split.country,
    phone: c.phone_e164 ? split.national : (c.wa_lid ?? ''),
    email: c.email ?? '',
    state: c.state ?? '',
    city: c.city ?? '',
    zip: maskZip(c.zip ?? ''),
    labelIds: c.labels.map((l) => l.id),
    customFields: Object.entries(c.custom_fields ?? {}).map(([key, value]) => ({
      key,
      value: value === null || value === undefined ? '' : typeof value === 'string' ? value : JSON.stringify(value),
    })),
    ctwaClid: c.ctwa_clid ?? '',
    sourceId: c.source_id ?? '',
    sourceUrl: c.source_url ?? '',
  }
}

export type FieldKey = 'name' | 'phone' | 'email' | 'state' | 'city' | 'zip' | 'custom_fields' | 'source_url'

export type FormErrors = Partial<Record<FieldKey, string>>

/** Erros locais (códigos de tradução em `contact-form:errors.*`); salvar fica desabilitado enquanto houver algum. */
export function validateForm(v: ContactFormValues): FormErrors {
  const errors: FormErrors = {}
  if (!v.name.trim()) errors.name = 'nameRequired'
  const phone = validatePhone(v.country, v.phone)
  if (!phone.ok) errors.phone = `phone.${phone.error}`
  if (!emailValid(v.email)) errors.email = 'email'
  if (!zipValid(v.zip)) errors.zip = 'zip'
  return errors
}

/** Corpo de `POST /api/contacts` / `PATCH /api/contacts/:id`. Na edição, campos vazios viram `null` (limpam). */
export function toContactBody(v: ContactFormValues, mode: 'create' | 'edit'): Record<string, unknown> {
  const phone = validatePhone(v.country, v.phone)
  const opt = (s: string) => (s.trim() ? s.trim() : mode === 'edit' ? null : undefined)
  const customFields: Record<string, string> = {}
  for (const row of v.customFields) if (row.key.trim()) customFields[row.key.trim()] = row.value
  const body: Record<string, unknown> = {
    name: v.name.trim(),
    email: opt(v.email),
    state: opt(v.state),
    city: opt(v.city),
    zip: digitsOf(v.zip) ? digitsOf(v.zip) : mode === 'edit' ? null : undefined,
    label_ids: v.labelIds,
    custom_fields: customFields,
  }
  if (phone.ok && 'e164' in phone) body.phone = phone.e164
  if (phone.ok && 'lid' in phone) body.wa_lid = phone.lid
  if (mode === 'edit') {
    body.ctwa_clid = opt(v.ctwaClid)
    body.source_id = opt(v.sourceId)
    body.source_url = opt(v.sourceUrl)
  }
  return Object.fromEntries(Object.entries(body).filter(([, val]) => val !== undefined))
}

/** `details.fields[].path` do 422 → campo do formulário (o resto vai para o erro geral). */
export function serverFieldErrors(details: unknown): { fields: FormErrors; other: string[] } {
  const list = (details as { fields?: { path?: unknown; message?: unknown }[] } | undefined)?.fields
  const fields: FormErrors = {}
  const other: string[] = []
  const map: Record<string, FieldKey> = {
    name: 'name',
    full_name: 'name',
    phone: 'phone',
    phone_number: 'phone',
    phone_e164: 'phone',
    wa_lid: 'phone',
    email: 'email',
    state: 'state',
    city: 'city',
    zip: 'zip',
    custom_fields: 'custom_fields',
    source_url: 'source_url',
  }
  for (const f of Array.isArray(list) ? list : []) {
    const path = String(f.path ?? '').split('.')[0] ?? ''
    const message = String(f.message ?? '')
    const key = map[path]
    if (key && !fields[key]) fields[key] = message
    else if (message) other.push(message)
  }
  return { fields, other }
}

/** Conexões que casam com a busca do modal "Abrir chat" (nome, telefone ou status). */
export function filterConnections<C extends { name: string; status: string; phone?: string | null }>(
  conns: readonly C[],
  text: string,
): C[] {
  const q = text.trim().toLowerCase()
  if (!q) return [...conns]
  return conns.filter((c) => [c.name, c.status, c.phone ?? ''].some((v) => v.toLowerCase().includes(q)))
}
