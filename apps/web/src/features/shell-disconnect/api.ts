// Consulta do indicador de conexões desconectadas (T107; 18 §5.5, §6): `GET /api/connections/disconnect-alert` da
// empresa ativa. A chave leva a empresa: a troca de empresa (`resetQueries`) refaz a consulta (AC-T107-04).
import { queryOptions } from '@tanstack/react-query'
import { api } from '@/lib/http'
import { hasAny, type Session } from '@/lib/session'

export interface DisconnectAlertDto {
  has_recent_disconnected: boolean
  last_disconnected_at: string | null
}

export const DISCONNECT_ALERT_PATH = '/api/connections/disconnect-alert'
export const DISCONNECT_ALERT_WINDOW_MS = 24 * 60 * 60 * 1000
export const SHELL_DISCONNECT_PERMS = ['connections.view'] as const

export const disconnectAlertKey = (companyId: string | null | undefined) =>
  ['shell-disconnect', companyId ?? ''] as const

export const disconnectAlertQuery = (companyId: string | null | undefined) =>
  queryOptions({
    queryKey: disconnectAlertKey(companyId),
    queryFn: () => api.get<DisconnectAlertDto>(DISCONNECT_ALERT_PATH),
    // Só o realtime (queda → cache, reconexão/exclusão → nova consulta) e a troca de empresa atualizam.
    staleTime: Infinity,
  })

/** AC-T107-03: support nunca; os demais com `connections.view` (owner sempre passa). Sem isso nem consulta. */
export function canSeeDisconnectAlert(session: Pick<Session, 'company' | 'isSupport' | 'isOwner' | 'perms'>): boolean {
  return !!session.company && !session.isSupport && hasAny(session, SHELL_DISCONNECT_PERMS)
}

/** O indicador some sozinho quando a última queda conhecida sai da janela de 24 h (aba aberta por muito tempo). */
export function isAlertActive(dto: DisconnectAlertDto | undefined, now = Date.now()): boolean {
  if (!dto?.has_recent_disconnected) return false
  if (!dto.last_disconnected_at) return true
  const at = Date.parse(dto.last_disconnected_at)
  return Number.isNaN(at) || now - at < DISCONNECT_ALERT_WINDOW_MS
}
