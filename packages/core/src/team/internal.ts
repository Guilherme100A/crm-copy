// Atalhos internos de erro (empresas, equipe, convites). Não são reexportados por @crm/core.
import { TeamError } from './errors'

export const notFound = (what = 'Recurso') => new TeamError('not_found', `${what} não encontrado(a)`)
export const forbidden = (message = 'Permissão insuficiente', errorCode?: string) => new TeamError('forbidden', message, errorCode)
