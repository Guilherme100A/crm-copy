// Regras puras da tela do suporte (T32 "Entrega do operário"): escolha da empresa pelo lookup e mensagens dos
// erros do pedido (422 `account_not_found` | `account_required`; 409 `request_pending` | `grant_active`).
import { HttpError } from '@/lib/http'
import type { SupportAccountDto } from './api'

export type Target = { kind: 'none' } | { kind: 'one'; companyId: string } | { kind: 'choose' }

/** Nenhuma empresa → erro; uma → pede direto; várias → o suporte escolhe. */
export function resolveTarget(accounts: readonly SupportAccountDto[]): Target {
  if (accounts.length === 0) return { kind: 'none' }
  if (accounts.length === 1) return { kind: 'one', companyId: accounts[0]!.id }
  return { kind: 'choose' }
}

export const REQUEST_ERRORS = ['account_not_found', 'account_required', 'request_pending', 'grant_active'] as const
export type RequestErrorKey = (typeof REQUEST_ERRORS)[number] | 'generic'

const errorCode = (err: HttpError) => {
  const d = err.details as { error_code?: string } | undefined
  return d?.error_code ?? err.code
}

/** Chave i18n do erro do pedido (`me.errors.<chave>`); `generic` = mostrar a mensagem do servidor. */
export function requestErrorKey(err: unknown): RequestErrorKey {
  if (!(err instanceof HttpError)) return 'generic'
  const code = errorCode(err)
  return (REQUEST_ERRORS as readonly string[]).includes(code) ? (code as RequestErrorKey) : 'generic'
}

/** Empresas que vêm no 422 `account_required` (`details.accounts`). */
export function accountsOf(err: unknown): SupportAccountDto[] | null {
  if (!(err instanceof HttpError)) return null
  const list = (err.details as { accounts?: SupportAccountDto[] } | undefined)?.accounts
  return Array.isArray(list) ? list : null
}
