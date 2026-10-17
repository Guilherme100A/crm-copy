// Erros de domínio do acesso de suporte (T32). A API converte `kind` para o código da SPEC 3.5 e repassa
// `errorCode`/`details` em `error.details`.

export type SupportAccessErrorKind = 'not_found' | 'forbidden' | 'conflict' | 'invalid_transition' | 'validation'

export class SupportAccessError extends Error {
  constructor(
    readonly kind: SupportAccessErrorKind,
    message: string,
    readonly errorCode?: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message)
    this.name = 'SupportAccessError'
  }
}
