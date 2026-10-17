// Captura do código de indicação no cadastro (SPEC T97; 13-afiliacao.md §3): `?ref` tem precedência sobre `?via`.
// Mesma regra do core (`REFERRAL_CODE_RE` em `@crm/core/auth/normalize`, replicada: a web só importa `@crm/shared`).
// Código inválido conta como ausente: `ref` inválido cai para `via` (decisão do Orquestrador, AC-T97-02).

export const REFERRAL_CODE_RE = /^[A-Za-z0-9_-]{1,64}$/

/** Código de indicação válido (1–64 de `[A-Za-z0-9_-]`) ou `undefined`. */
export function validReferral(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined
  const value = raw.trim()
  return REFERRAL_CODE_RE.test(value) ? value : undefined
}

/** `referral_code` a enviar no cadastro: `ref` válido, senão `via` válido, senão nada. */
export function pickReferral(search: { ref?: unknown; via?: unknown }): string | undefined {
  return validReferral(search.ref) ?? validReferral(search.via)
}
