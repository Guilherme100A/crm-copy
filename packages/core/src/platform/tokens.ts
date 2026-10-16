// Tokens opacos (SPEC 3.4): 32 bytes aleatórios; no banco só o SHA-256 em hex.
import { createHash, randomBytes } from 'node:crypto'

export const SESSION_COOKIE = 'crm_session'
export const API_TOKEN_PREFIX = 'crm_pat_'
const TOKEN_BYTES = 32

/** SHA-256 em hex do token cru (o que vai para `token_hash`). Tokens de API são hasheados com o prefixo. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex')
}

export function generateSessionToken(): string {
  return randomBytes(TOKEN_BYTES).toString('base64url')
}

export function generateApiToken(): string {
  return `${API_TOKEN_PREFIX}${randomBytes(TOKEN_BYTES).toString('base64url')}`
}

export function isApiToken(token: string): boolean {
  return token.startsWith(API_TOKEN_PREFIX) && token.length > API_TOKEN_PREFIX.length
}

/** Prefixo exibível do token de API (para a máscara na UI), sem revelar o segredo. */
export function apiTokenDisplayPrefix(token: string): string {
  return token.slice(0, API_TOKEN_PREFIX.length + 4)
}
