// Normalização e hash dos dados de usuário da Conversions API (T104; revisão 3). SHA-256 em hex minúsculo DEPOIS de
// normalizar, como pede a doc "Customer Information Parameters":
//   https://developers.facebook.com/docs/marketing-api/conversions-api/parameters/customer-information-parameters
// - em: trim + minúsculas. ph: só dígitos, com DDI, sem zeros à esquerda.
// - fn/ln: minúsculas, sem pontuação (apóstrofo, hífen, ponto…); também sem acento (a doc recomenda a-z).
// - ct: minúsculas, sem pontuação, sem espaços. st: EUA → sigla ANSI de 2 letras; demais países → minúsculas sem
//   pontuação nem espaços (no Brasil, o nome do estado vira a UF: "São Paulo" → "sp").
// - zp: minúsculas, sem espaços nem hífen; EUA → só os 5 primeiros dígitos (CEP "01310-100" → "01310100").
// - country: ISO 3166-1 alfa-2 minúsculo, enviado sempre (mesmo com todos os dados de um país só).
// - external_id: hash recomendado (mantido). Em claro, nunca hasheados: client_ip_address, client_user_agent, fbc, fbp,
//   ctwa_clid, page_id, whatsapp_business_account_id.
import { createHash } from 'node:crypto'
import { phoneCountry } from '@crm/shared'

export const sha256 = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex')

/** "+55 (11) 99999-8888" → "5511999998888"; "0055 11…" → "5511…" (sem zeros à esquerda). Vazio/curto → null. */
export function normalizePhone(phone: string | null | undefined): string | null {
  const digits = (phone ?? '').replace(/\D/g, '').replace(/^0+/, '')
  return digits.length >= 8 ? digits : null
}

export function normalizeCapiEmail(email: string | null | undefined): string | null {
  const v = (email ?? '').trim().toLowerCase()
  return v.includes('@') ? v : null
}

const stripAccents = (v: string) => v.normalize('NFD').replace(/\p{M}/gu, '')
/** Tudo que não é letra, número ou espaço (pontuação e símbolos). */
const PUNCT = /[^\p{L}\p{N}\s]/gu

/** Minúsculas, sem acentos, sem pontuação e com espaços simples (nome e sobrenome). "D'Ávila-Souza Jr." → "davilasouza jr". */
export function normalizeText(value: string | null | undefined): string | null {
  const v = stripAccents(value ?? '')
    .toLowerCase()
    .replace(PUNCT, '')
    .replace(/\s+/g, ' ')
    .trim()
  return v || null
}

/** Cidade: como `normalizeText`, sem espaços ("São Paulo" → "saopaulo"). */
export function normalizeCity(value: string | null | undefined): string | null {
  return normalizeText(value)?.replace(/\s+/g, '') || null
}

const BR_STATES: Readonly<Record<string, string>> = {
  acre: 'ac',
  alagoas: 'al',
  amapa: 'ap',
  amazonas: 'am',
  bahia: 'ba',
  ceara: 'ce',
  distritofederal: 'df',
  espiritosanto: 'es',
  goias: 'go',
  maranhao: 'ma',
  matogrosso: 'mt',
  matogrossodosul: 'ms',
  minasgerais: 'mg',
  para: 'pa',
  paraiba: 'pb',
  parana: 'pr',
  pernambuco: 'pe',
  piaui: 'pi',
  riodejaneiro: 'rj',
  riograndedonorte: 'rn',
  riograndedosul: 'rs',
  rondonia: 'ro',
  roraima: 'rr',
  santacatarina: 'sc',
  saopaulo: 'sp',
  sergipe: 'se',
  tocantins: 'to',
}
const BR_UFS = new Set(Object.values(BR_STATES))

/** Estado: minúsculas sem pontuação nem espaços; no Brasil, nome por extenso vira UF ("Rio de Janeiro" → "rj"). */
export function normalizeState(value: string | null | undefined, country?: string | null): string | null {
  const v = normalizeCity(value)
  if (!v) return null
  if (country === 'br' || !country) {
    if (BR_UFS.has(v)) return v
    if (BR_STATES[v]) return BR_STATES[v]
  }
  return v
}

/** CEP/ZIP: minúsculas sem espaços nem hífen; EUA → 5 primeiros dígitos. */
export function normalizeZip(value: string | null | undefined, country?: string | null): string | null {
  const v = stripAccents(value ?? '')
    .toLowerCase()
    .replace(/[\s-]/g, '')
    .replace(PUNCT, '')
  if (!v) return null
  if (country === 'us') return /^\d{5}/.test(v) ? v.slice(0, 5) : v
  return v
}

/** ISO 3166-1 alfa-2 minúsculo; inválido → null. */
export function normalizeCountry(value: string | null | undefined): string | null {
  const v = (value ?? '').trim().toLowerCase()
  return /^[a-z]{2}$/.test(v) ? v : null
}

/** País do evento: o do DDI do telefone; senão o padrão (do pixel); senão `br`. */
export function resolveCountry(phone: string | null | undefined, fallback?: string | null): string {
  return phoneCountry(normalizePhone(phone)) ?? normalizeCountry(fallback) ?? DEFAULT_CAPI_COUNTRY
}

export const DEFAULT_CAPI_COUNTRY = 'br'

export interface CapiUserInput {
  phone?: string | null
  email?: string | null
  /** Id estável do lead no CRM (vira `external_id` hasheado). */
  externalId?: string | null
  firstName?: string | null
  lastName?: string | null
  city?: string | null
  state?: string | null
  zip?: string | null
  /** País explícito (ISO alfa-2). Sem ele: DDI do telefone → `defaultCountry`. */
  country?: string | null
  /** País padrão (do pixel) quando o DDI não resolve. */
  defaultCountry?: string | null
  clientIpAddress?: string | null
  clientUserAgent?: string | null
  fbc?: string | null
  fbp?: string | null
  /** Click id do anúncio de clique para WhatsApp (só usado no modo business_messaging). */
  ctwaClid?: string | null
}

/** `user_data` do evento: campos de identificação hasheados em listas (como a Meta pede); técnicos em claro. */
export function buildUserData(u: CapiUserInput): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  const phone = normalizePhone(u.phone)
  const email = normalizeCapiEmail(u.email)
  const external = u.externalId?.trim()
  const fn = normalizeText(u.firstName)
  const ln = normalizeText(u.lastName)
  const ct = normalizeCity(u.city)
  const country = normalizeCountry(u.country) ?? resolveCountry(phone, u.defaultCountry)
  const st = normalizeState(u.state, country)
  const zp = normalizeZip(u.zip, country)
  if (phone) out.ph = [sha256(phone)]
  if (email) out.em = [sha256(email)]
  if (external) out.external_id = [sha256(external)]
  if (fn) out.fn = [sha256(fn)]
  if (ln) out.ln = [sha256(ln)]
  if (ct) out.ct = [sha256(ct)]
  if (st) out.st = [sha256(st)]
  if (zp) out.zp = [sha256(zp)]
  out.country = [sha256(country)]
  if (u.clientIpAddress) out.client_ip_address = u.clientIpAddress
  if (u.clientUserAgent) out.client_user_agent = u.clientUserAgent
  if (u.fbc) out.fbc = u.fbc
  if (u.fbp) out.fbp = u.fbp
  return out
}

/**
 * Identificadores "fortes" para a pontuação estimada de correspondência (diagnóstico): os que sozinhos costumam
 * identificar a pessoa. IP + user agent contam como um par. Não é a "Qualidade de correspondência" oficial da Meta.
 */
export const STRONG_IDENTIFIERS = ['em', 'ph', 'external_id', 'fbc', 'fbp', 'ctwa_clid'] as const

export function matchScore(userData: Record<string, unknown>): number {
  let n = STRONG_IDENTIFIERS.filter((k) => userData[k] !== undefined).length
  if (userData.client_ip_address && userData.client_user_agent) n += 1
  return n
}

/** Máximo de `matchScore` (para a escala da UI). */
export const MATCH_SCORE_MAX = STRONG_IDENTIFIERS.length + 1

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
