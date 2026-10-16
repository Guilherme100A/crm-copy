// Normalização dos campos de contato (feature 05 §3.1; SPEC 3.8): telefone E.164, LID, UF, CEP, e-mail.
import { toE164, PhoneError } from '@crm/shared'
import { invalid } from './errors'

export const BR_STATES = [
  'AC', 'AL', 'AP', 'AM', 'BA', 'CE', 'DF', 'ES', 'GO', 'MA', 'MT', 'MS', 'MG', 'PA',
  'PB', 'PR', 'PE', 'PI', 'RJ', 'RN', 'RS', 'RO', 'RR', 'SC', 'SP', 'SE', 'TO',
] as const

/**
 * Telefone livre → E.164. Sem DDI vale o Brasil (10–11 dígitos com DDD); internacional com 8–15 dígitos.
 * `…@s.whatsapp.net` (JID de telefone) também é aceito. Inválido → erro de validação no campo `path`.
 */
export function normalizeContactPhone(raw: string, path = 'phone'): string {
  const jid = /^(\d{8,15})(?::\d+)?@s\.whatsapp\.net$/.exec(raw.trim())
  try {
    return toE164(jid ? `+${jid[1]}` : raw)
  } catch (err) {
    if (err instanceof PhoneError) throw invalid(path, 'Telefone inválido')
    throw err
  }
}

/** `123456789@lid` (com ou sem sufixo de dispositivo) → `123456789@lid`. Nunca usa o JID cru como chave de telefone. */
export function normalizeContactLid(raw: string, path = 'wa_lid'): string {
  const m = /^(\d{5,25})(?::\d+)?@lid$/.exec(raw.trim())
  if (!m) throw invalid(path, 'LID inválido (formato esperado: <número>@lid)')
  return `${m[1]}@lid`
}

export function normalizeContactState(raw: string): string {
  const uf = raw.trim().toUpperCase()
  if (!(BR_STATES as readonly string[]).includes(uf)) throw invalid('state', 'UF inválida')
  return uf
}

export function normalizeContactZip(raw: string): string {
  const digits = raw.replace(/\D/g, '')
  if (digits.length !== 8) throw invalid('zip', 'CEP deve ter 8 dígitos')
  return digits
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export function normalizeContactEmail(raw: string): string {
  const email = raw.trim().toLowerCase()
  if (!EMAIL_RE.test(email) || email.length > 254) throw invalid('email', 'E-mail inválido')
  return email
}

/** Texto opcional: vazio vira null. */
export const emptyToNull = (v: string | null | undefined): string | null => {
  const t = v?.trim()
  return t ? t : null
}
