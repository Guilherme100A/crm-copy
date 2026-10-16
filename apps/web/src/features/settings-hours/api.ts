// API dos horários de atendimento (T31; 16 §3.3, §5 "Horários"): config por conexão, conexões e fluxos dos selects.
import { queryOptions } from '@tanstack/react-query'
import { api, HttpError } from '@/lib/http'
import type { ActionType, HoursForm, Interval } from './validation'
import { hoursPayload } from './validation'

export type ConnectionStatus = 'pending' | 'connecting' | 'connected' | 'paused' | 'disconnected' | 'banned'

export interface ConnectionOption {
  id: string
  name: string
  phone_number: string | null
  status: ConnectionStatus
}

export interface BusinessHoursDto {
  id: string | null
  connection_id: string
  active: boolean
  action_type: ActionType
  message_text: string | null
  flow_id: string | null
  business_hours: (Interval & { id: string })[]
  updated_at: string | null
}

const enc = encodeURIComponent
export const HOURS_KEY = ['settings-hours'] as const
export const hoursKey = (connectionId: string) => [...HOURS_KEY, 'config', connectionId] as const

/** Conexões para o select; sem `connections.view` (member padrão) → `forbidden`, a tela mostra estado vazio. */
export const connectionsQuery = () =>
  queryOptions({
    queryKey: [...HOURS_KEY, 'connections'] as const,
    staleTime: 30_000,
    queryFn: async (): Promise<{ forbidden: boolean; items: ConnectionOption[] }> => {
      try {
        return {
          forbidden: false,
          items: (await api.get<{ items: ConnectionOption[] }>('/api/connections', { query: { limit: 100 } })).items,
        }
      } catch (err) {
        if (err instanceof HttpError && err.status === 403) return { forbidden: true, items: [] }
        throw err
      }
    },
  })

/** Fluxos para a ação "Fluxo"; sem `flows.view` a lista fica vazia. */
export const flowsQuery = () =>
  queryOptions({
    queryKey: [...HOURS_KEY, 'flows'] as const,
    staleTime: 60_000,
    queryFn: async () => {
      try {
        return (await api.get<{ items: { id: string; name: string }[] }>('/api/flows/names')).items
      } catch (err) {
        if (err instanceof HttpError && err.status === 403) return []
        throw err
      }
    },
  })

export const hoursQuery = (connectionId: string) =>
  queryOptions({
    queryKey: hoursKey(connectionId),
    queryFn: async () =>
      (await api.get<{ config: BusinessHoursDto }>(`/api/business-hours/${enc(connectionId)}`)).config,
  })

export const hoursApi = {
  save: async (connectionId: string, form: HoursForm) =>
    (await api.put<{ config: BusinessHoursDto }>(`/api/business-hours/${enc(connectionId)}`, hoursPayload(form)))
      .config,
}
