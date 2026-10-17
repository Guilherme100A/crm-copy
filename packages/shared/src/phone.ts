// Telefones em E.164 (SPEC 3.8: contato identificado por `phone_e164`). Padrão Brasil: número nacional
// com DDD tem 10 (fixo) ou 11 (celular) dígitos.
import { parsePhoneNumberFromString, parsePhoneNumberWithError, ParseError, type CountryCode } from 'libphonenumber-js'
import * as z from 'zod'

export const DEFAULT_PHONE_COUNTRY: CountryCode = 'BR'
/** Mínimo de dígitos aceito por `toE164` (com código do país, se houver). */
export const MIN_PHONE_DIGITS = 8
const MAX_E164_DIGITS = 15

export type PhoneErrorReason = 'NOT_A_NUMBER' | 'TOO_SHORT' | 'TOO_LONG' | 'INVALID_COUNTRY' | 'INVALID'

export class PhoneError extends Error {
  override readonly name = 'PhoneError'
  constructor(
    readonly reason: PhoneErrorReason,
    readonly input: string,
  ) {
    super(`Telefone inválido (${reason})`)
  }
}

export interface ParsePhoneOptions {
  /** País assumido quando o número não começa com `+` (padrão `BR`). */
  defaultCountry?: CountryCode
}

const digitsOf = (input: string) => input.replace(/\D/g, '')

/**
 * Normaliza um telefone para E.164 (`+5511999998888`) e valida pelas regras do país.
 * Lança `PhoneError` se o número for inválido (ex.: celular BR sem DDD).
 */
export function parsePhone(input: string, opts: ParsePhoneOptions = {}): string {
  const defaultCountry = opts.defaultCountry ?? DEFAULT_PHONE_COUNTRY
  const raw = String(input ?? '').trim()
  const digits = digitsOf(raw)
  if (!digits) throw new PhoneError('NOT_A_NUMBER', raw)
  if (digits.length > MAX_E164_DIGITS) throw new PhoneError('TOO_LONG', raw)

  let text = raw
  if (raw.startsWith('00')) text = `+${digits.slice(2)}`
  // WhatsApp entrega números BR sem "+" (5511999998888): 12–13 dígitos começando por 55 são internacionais.
  else if (!raw.startsWith('+') && defaultCountry === 'BR' && digits.startsWith('55') && (digits.length === 12 || digits.length === 13))
    text = `+${digits}`

  let parsed
  try {
    parsed = parsePhoneNumberWithError(text, { defaultCountry })
  } catch (err) {
    if (err instanceof ParseError) throw new PhoneError(err.message as PhoneErrorReason, raw)
    throw err
  }
  if (parsed.countryCallingCode === '55') {
    const national = parsed.nationalNumber.length
    if (national < 10) throw new PhoneError('TOO_SHORT', raw)
    if (national > 11) throw new PhoneError('TOO_LONG', raw)
  }
  if (!parsed.isValid()) throw new PhoneError('INVALID', raw)
  return parsed.number
}

/** Igual a `parsePhone`, sem lançar: devolve `null` se inválido. */
export function tryParsePhone(input: string, opts?: ParsePhoneOptions): string | null {
  try {
    return parsePhone(input, opts)
  } catch (err) {
    if (err instanceof PhoneError) return null
    throw err
  }
}

/** Converte para E.164; rejeita entradas com menos de `MIN_PHONE_DIGITS` dígitos antes de validar. */
export function toE164(input: string, opts?: ParsePhoneOptions): string {
  const raw = String(input ?? '').trim()
  if (digitsOf(raw).length < MIN_PHONE_DIGITS) throw new PhoneError('TOO_SHORT', raw)
  return parsePhone(raw, opts)
}

const E164_RE = /^\+[1-9]\d{7,14}$/

/** Formato E.164 (sem validar as regras do país). */
export function isE164(value: unknown): value is string {
  return typeof value === 'string' && E164_RE.test(value)
}

/** Schema de `phone_e164` já normalizado no fio. */
export const phoneE164Schema = z.string().regex(E164_RE, 'Telefone fora do formato E.164')

/** Schema de entrada livre: aceita qualquer formatação e devolve o E.164 (erro de validação se inválido). */
export const phoneInputSchema = z.string().transform((value, ctx) => {
  const e164 = tryParsePhone(value)
  if (!e164) {
    ctx.addIssue({ code: 'custom', message: 'Telefone inválido' })
    return z.NEVER
  }
  return e164
})

/**
 * DDI → país principal (ISO 3166-1 alfa-2, minúsculo), para quando o `libphonenumber-js` não define o país do número
 * (faixas não geográficas ou numeração nova). Cobre os DDIs mais comuns de quem anuncia daqui; o resto cai no padrão.
 */
export const CALLING_CODE_COUNTRY: Readonly<Record<string, string>> = {
  '1': 'us',
  '7': 'ru',
  '20': 'eg',
  '27': 'za',
  '30': 'gr',
  '31': 'nl',
  '32': 'be',
  '33': 'fr',
  '34': 'es',
  '39': 'it',
  '41': 'ch',
  '44': 'gb',
  '49': 'de',
  '51': 'pe',
  '52': 'mx',
  '53': 'cu',
  '54': 'ar',
  '55': 'br',
  '56': 'cl',
  '57': 'co',
  '58': 've',
  '61': 'au',
  '81': 'jp',
  '86': 'cn',
  '91': 'in',
  '244': 'ao',
  '258': 'mz',
  '351': 'pt',
  '353': 'ie',
  '591': 'bo',
  '593': 'ec',
  '595': 'py',
  '598': 'uy',
}

/**
 * País (ISO alfa-2 minúsculo) de um telefone com DDI ("+5511999998888" ou "5511999998888"). Usa o `libphonenumber-js`
 * (resolve +1 entre EUA/Canadá etc. pelo número) e, se ele não souber, a tabela `CALLING_CODE_COUNTRY`. Sem DDI
 * reconhecível → null.
 */
export function phoneCountry(phone: string | null | undefined): string | null {
  const digits = digitsOf(String(phone ?? '')).replace(/^0+/, '')
  if (digits.length < MIN_PHONE_DIGITS) return null
  const parsed = parsePhoneNumberFromString(`+${digits}`)
  if (parsed?.country) return parsed.country.toLowerCase()
  for (const len of [3, 2, 1]) {
    const cc = CALLING_CODE_COUNTRY[digits.slice(0, len)]
    if (cc) return cc
  }
  return null
}
