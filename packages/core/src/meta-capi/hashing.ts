// Normalização e hash dos dados de usuário da Conversions API (T104; STACK E §1.7): SHA-256 em hex minúsculo DEPOIS
// de normalizar — e-mail com trim + minúsculas; telefone só com dígitos e DDI (sem `+`); nome e cidade em minúsculas
// sem acento. `client_ip_address`, `client_user_agent`, `fbc` e `fbp` NÃO são hasheados.
import { createHash } from 'node:crypto'

export const sha256 = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex')

/** "+55 (11) 99999-8888" → "5511999998888". Vazio → null. */
export function normalizePhone(phone: string | null | undefined): string | null {
  const digits = (phone ?? '').replace(/\D/g, '')
  return digits.length >= 8 ? digits : null
}

export function normalizeCapiEmail(email: string | null | undefined): string | null {
  const v = (email ?? '').trim().toLowerCase()
  return v.includes('@') ? v : null
}

/** Minúsculas, sem acentos e sem espaços nas pontas (nome, sobrenome, cidade). */
export function normalizeText(value: string | null | undefined): string | null {
  const v = (value ?? '')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .trim()
  return v || null
}

export interface CapiUserInput {
  phone?: string | null
  email?: string | null
  /** Id estável do lead no CRM (vira `external_id` hasheado). */
  externalId?: string | null
  firstName?: string | null
  lastName?: string | null
  city?: string | null
  clientIpAddress?: string | null
  clientUserAgent?: string | null
  fbc?: string | null
  fbp?: string | null
}

/** `user_data` do evento: campos de identificação hasheados em listas (como a Meta pede); técnicos em claro. */
export function buildUserData(u: CapiUserInput): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  const phone = normalizePhone(u.phone)
  const email = normalizeCapiEmail(u.email)
  const external = u.externalId?.trim()
  const fn = normalizeText(u.firstName)
  const ln = normalizeText(u.lastName)
  const ct = normalizeText(u.city)?.replace(/\s+/g, '')
  if (phone) out.ph = [sha256(phone)]
  if (email) out.em = [sha256(email)]
  if (external) out.external_id = [sha256(external)]
  if (fn) out.fn = [sha256(fn)]
  if (ln) out.ln = [sha256(ln)]
  if (ct) out.ct = [sha256(ct)]
  if (u.clientIpAddress) out.client_ip_address = u.clientIpAddress
  if (u.clientUserAgent) out.client_user_agent = u.clientUserAgent
  if (u.fbc) out.fbc = u.fbc
  if (u.fbp) out.fbp = u.fbp
  return out
}

export const DEFAULT_CAPI_CURRENCY = 'BRL'

/** Moeda ISO-4217 (3 letras); vazia ou inválida → BRL (AC-T104-03; 11 §5.4). */
export function normalizeCapiCurrency(value: string | null | undefined): string {
  const v = (value ?? '').trim().toUpperCase()
  return /^[A-Z]{3}$/.test(v) ? v : DEFAULT_CAPI_CURRENCY
}

/**
 * Valor monetário de texto livre (já renderizado): "199,90", "R$ 1.299,90", "1299.9", "1,299.90". Sem número → null.
 * Com vírgula e ponto, o último separador é o decimal.
 */
export function parseMoney(value: string | number | null | undefined): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? Math.round(value * 100) / 100 : null
  let s = (value ?? '').replace(/[^\d.,-]/g, '')
  if (!s || !/\d/.test(s)) return null
  const lastComma = s.lastIndexOf(',')
  const lastDot = s.lastIndexOf('.')
  if (lastComma > -1 && lastDot > -1) {
    const decimal = lastComma > lastDot ? ',' : '.'
    s = s.split(decimal === ',' ? '.' : ',').join('').replace(decimal, '.')
  } else if (lastComma > -1) {
    // Só vírgula: decimal se tiver até 2 casas depois dela, senão milhar.
    s = /,\d{1,2}$/.test(s) ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '')
  } else if ((s.match(/\./g) ?? []).length > 1) {
    s = s.replace(/\./g, '')
  }
  const n = Number(s)
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null
}
