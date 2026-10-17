// SSO do painel do ai-manager (`/auth/sso#token=<jwt>`): o token vem SÓ do hash (não vai ao servidor nos logs de
// acesso nem no Referer) e é trocado uma única vez (o `jti` é de uso único na API).
import { HttpError } from '@/lib/http'
import { isSafeRedirect } from '@/lib/redirect'

export interface SsoHash {
  token: string | null
  /** Caminho interno opcional para depois de entrar (`#token=…&redirect=/chats`), só se for seguro. */
  redirect: string | null
}

/** Lê `token` (e `redirect`) do fragmento da URL. Query string é ignorada de propósito. */
export function readSsoHash(hash: string): SsoHash {
  const params = new URLSearchParams(hash.startsWith('#') ? hash.slice(1) : hash)
  const token = params.get('token')?.trim() || null
  const redirect = params.get('redirect')
  return { token, redirect: isSafeRedirect(redirect) ? redirect : null }
}

// Último hash com token lido nesta carga. O StrictMode monta a página duas vezes: a 1ª montagem já apagou o hash da
// URL, então a 2ª precisa reaproveitar o que foi lido (senão mostra "sem token" e descarta a troca em andamento).
let lastRead: SsoHash | null = null

/** Como `readSsoHash`, mas lembra o token lido até `forgetSsoHash` (2ª montagem do StrictMode). */
export function takeSsoHash(hash: string): SsoHash {
  const read = readSsoHash(hash)
  if (read.token) {
    lastRead = read
    return read
  }
  return lastRead ?? read
}

/** Esquece o token lembrado (quando a troca termina). */
export function forgetSsoHash(token: string): void {
  if (lastRead?.token === token) lastRead = null
}

const exchanges = new Map<string, Promise<unknown>>()

/**
 * Troca o token uma vez por carga: o StrictMode (e re-renderizações) chamam de novo com o mesmo token e recebem a
 * mesma promessa, em vez de reapresentar um `jti` já usado.
 */
export function exchangeOnce<T>(token: string, exchange: (token: string) => Promise<T>): Promise<T> {
  let p = exchanges.get(token) as Promise<T> | undefined
  if (!p) {
    p = exchange(token)
    exchanges.set(token, p)
  }
  return p
}

/** 404 = SSO desligado na API (sem `CRM_SSO_SECRET`); outro 4xx = token inválido/expirado/já usado. */
export function ssoErrorKey(err: unknown): 'sso.disabled' | 'sso.invalid' | 'errors.generic' {
  if (!(err instanceof HttpError)) return 'errors.generic'
  if (err.status === 404 || err.status === 501) return 'sso.disabled'
  return err.status < 500 ? 'sso.invalid' : 'errors.generic'
}
