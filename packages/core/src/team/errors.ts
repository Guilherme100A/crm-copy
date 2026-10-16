// Erros de domínio de empresas, equipe e convites (T22). A API converte `kind` para o código da SPEC 3.5
// e repassa `errorCode`/`details` em `error.details` (padrão `error_code` da T15).

export type TeamErrorKind = 'not_found' | 'forbidden' | 'conflict' | 'validation' | 'gone' | 'rate_limit' | 'unauthorized'

export class TeamError extends Error {
  constructor(
    readonly kind: TeamErrorKind,
    message: string,
    readonly errorCode?: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message)
    this.name = 'TeamError'
  }
}
