// SSO vindo do painel do ai-manager: verificação do JWT HS256 (contrato combinado com o ai-manager).
// Claims: iss 'ai-manager', aud 'crm', sub 'ai-manager:<username>', name, email '<username>@ai-manager.local', iat,
// exp (iat + 120 s) e jti. Só HS256 (alg 'none' e qualquer outro são recusados); comparação em tempo constante.
// O uso único do `jti` fica com quem chama (Redis SET NX na API), DEPOIS desta verificação.
import { createHmac, timingSafeEqual } from 'node:crypto'

export const SSO_ISSUER = 'ai-manager'
export const SSO_AUDIENCE = 'crm'
export const SSO_SUBJECT_PREFIX = 'ai-manager:'
/** Tolerância de relógio entre os servidores (s). */
export const SSO_CLOCK_SKEW_SEC = 30
/** Vida máxima aceita (exp − iat): o contrato usa 120 s; acima disso o token é recusado. */
export const SSO_MAX_LIFETIME_SEC = 300

export type SsoTokenErrorCode = 'malformed' | 'bad_alg' | 'bad_signature' | 'bad_issuer' | 'bad_audience' | 'expired' | 'not_yet_valid' | 'bad_claims'

export class SsoTokenError extends Error {
  constructor(
    readonly code: SsoTokenErrorCode,
    message: string = code,
  ) {
    super(message)
    this.name = 'SsoTokenError'
  }
}

export interface SsoClaims {
  iss: string
  aud: string | string[]
  sub: string
  name: string
  email: string
  iat: number
  exp: number
  jti: string
}

const B64URL = /^[A-Za-z0-9_-]+$/

function decodeJson(part: string): unknown {
  if (!B64URL.test(part)) throw new SsoTokenError('malformed', 'Token malformado')
  try {
    return JSON.parse(Buffer.from(part, 'base64url').toString('utf8'))
  } catch {
    throw new SsoTokenError('malformed', 'Token malformado')
  }
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const str = (v: unknown, max = 320): v is string => typeof v === 'string' && v.trim().length > 0 && v.length <= max
const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

/** Assina (HS256) — usado nos testes e por quem precisar emitir um token compatível. */
export function signSsoToken(claims: Record<string, unknown>, secret: string, header: Record<string, unknown> = { alg: 'HS256', typ: 'JWT' }): string {
  const h = Buffer.from(JSON.stringify(header)).toString('base64url')
  const p = Buffer.from(JSON.stringify(claims)).toString('base64url')
  const sig = createHmac('sha256', secret).update(`${h}.${p}`).digest('base64url')
  return `${h}.${p}.${sig}`
}

/** Verifica assinatura e claims; devolve as claims ou lança `SsoTokenError`. `nowSec` = relógio em segundos. */
export function verifySsoToken(token: string, secret: string, opts: { nowSec?: number; clockSkewSec?: number } = {}): SsoClaims {
  if (!secret) throw new SsoTokenError('bad_signature', 'Segredo de SSO ausente')
  if (typeof token !== 'string' || token.length > 4096) throw new SsoTokenError('malformed', 'Token malformado')
  const parts = token.split('.')
  if (parts.length !== 3 || parts.some((p) => p.length === 0)) throw new SsoTokenError('malformed', 'Token malformado')
  const [h, p, s] = parts as [string, string, string]

  const header = decodeJson(h)
  if (!isObj(header) || header.alg !== 'HS256') throw new SsoTokenError('bad_alg', 'Algoritmo não aceito')

  if (!B64URL.test(s)) throw new SsoTokenError('malformed', 'Token malformado')
  const expected = createHmac('sha256', secret).update(`${h}.${p}`).digest()
  const given = Buffer.from(s, 'base64url')
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) throw new SsoTokenError('bad_signature', 'Assinatura inválida')

  const c = decodeJson(p)
  if (!isObj(c)) throw new SsoTokenError('bad_claims', 'Claims inválidas')
  if (c.iss !== SSO_ISSUER) throw new SsoTokenError('bad_issuer', 'Emissor inválido')
  const aud = c.aud
  if (!(aud === SSO_AUDIENCE || (Array.isArray(aud) && aud.includes(SSO_AUDIENCE)))) throw new SsoTokenError('bad_audience', 'Audiência inválida')

  const now = opts.nowSec ?? Math.floor(Date.now() / 1000)
  const skew = opts.clockSkewSec ?? SSO_CLOCK_SKEW_SEC
  if (!num(c.exp) || !num(c.iat)) throw new SsoTokenError('bad_claims', 'iat/exp ausentes')
  if (c.exp + skew <= now) throw new SsoTokenError('expired', 'Token expirado')
  if (c.iat - skew > now) throw new SsoTokenError('not_yet_valid', 'Token emitido no futuro')
  if (c.exp <= c.iat || c.exp - c.iat > SSO_MAX_LIFETIME_SEC) throw new SsoTokenError('bad_claims', 'Validade do token fora do permitido')

  if (!str(c.jti, 200)) throw new SsoTokenError('bad_claims', 'jti ausente')
  if (!str(c.sub) || !c.sub.startsWith(SSO_SUBJECT_PREFIX) || c.sub.length === SSO_SUBJECT_PREFIX.length)
    throw new SsoTokenError('bad_claims', 'sub inválido')
  if (!str(c.email, 254) || !/^[^\s@]+@[^\s@]+$/.test(c.email)) throw new SsoTokenError('bad_claims', 'email inválido')
  const name = str(c.name, 120) ? c.name.trim() : c.sub.slice(SSO_SUBJECT_PREFIX.length)

  return { iss: c.iss, aud: aud as string | string[], sub: c.sub, name, email: c.email.trim(), iat: c.iat, exp: c.exp, jti: c.jti }
}
