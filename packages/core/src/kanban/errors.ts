// Erros do Kanban (T50); a API converte `kind` para o código da SPEC 3.5 e repassa `errorCode`/`details`.

export type KanbanErrorKind = 'not_found' | 'validation' | 'conflict'

export class KanbanError extends Error {
  constructor(
    readonly kind: KanbanErrorKind,
    message: string,
    readonly errorCode?: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message)
    this.name = 'KanbanError'
  }
}

export const kanbanNotFound = (what: string) => new KanbanError('not_found', `${what} não encontrado(a)`)
export const kanbanInvalid = (path: string, message: string) => new KanbanError('validation', message, undefined, { fields: [{ path, message }] })
