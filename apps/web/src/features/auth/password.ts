// Regras de senha das telas (spec 01 §3.3): medidor de força de 4 barras e mínimo do servidor.
import { PASSWORD_MIN_LENGTH } from '@crm/shared'

export { PASSWORD_MIN_LENGTH }

export type StrengthLabel = 'weak' | 'medium' | 'strong'

/** Nível 0..4 = min(4, floor(tamanho/3)); rótulo Fraca (<6), Média (<10), Forte (≥10). */
export function passwordStrength(password: string): { level: number; label: StrengthLabel } {
  const len = password.length
  return { level: Math.min(4, Math.floor(len / 3)), label: len < 6 ? 'weak' : len < 10 ? 'medium' : 'strong' }
}

export type PasswordProblem = 'tooShort' | 'mismatch' | null

/** Erro do par senha/confirmação antes de enviar (nenhum request sai com erro). */
export function passwordProblem(password: string, confirmation: string): PasswordProblem {
  if (password !== confirmation) return 'mismatch'
  if (password.length < PASSWORD_MIN_LENGTH) return 'tooShort'
  return null
}
