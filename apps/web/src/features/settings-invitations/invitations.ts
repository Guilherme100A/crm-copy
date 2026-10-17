// Regras puras dos convites (16 §4 "Reenvio", §5): estado do botão reenviar, erro do 429 e validação do e-mail.
import { HttpError } from '@/lib/http'
import type { InvitationDto } from './api'

export const MAX_RESENDS_PER_DAY = 3
export type ResendBlock = 'limit' | 'cooldown' | null

/** Por que o reenvio está bloqueado (pelos dados do convite): sem reenvios hoje → `limit`; senão `cooldown`. */
export function resendBlock(inv: Pick<InvitationDto, 'can_resend' | 'resends_remaining_today' | 'status'>): ResendBlock {
  if (inv.status !== 'pending') return null
  if (inv.resends_remaining_today <= 0) return 'limit'
  if (!inv.can_resend) return 'cooldown'
  return null
}

/** 429 `RATE_LIMIT` do reenvio → `limit` (`resend_limit`) ou `cooldown` (`resend_cooldown`). */
export function resendErrorKind(err: unknown): ResendBlock {
  if (!(err instanceof HttpError) || err.status !== 429) return null
  const code = (err.details as { error_code?: string } | undefined)?.error_code
  return code === 'resend_cooldown' ? 'cooldown' : 'limit'
}

/** Regex do formulário de convite (16 §5 Equipe 8). */
export const isEmail = (v: string) => /^\S+@\S+\.\S+$/.test(v.trim())

/** Copia para a área de transferência; `false` se o navegador recusar. */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}
