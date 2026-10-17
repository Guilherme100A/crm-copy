// API das conexões (T40 + T71; 08-conexoes.md §5): lista com contagem por status e limite, ações da sessão, QR e
// código no telefone, proxy, configurações da instância, "Parar todos os fluxos" (T43) e os fluxos pausados na
// queda (Retomar/Cancelar). DTOs locais: a web não importa `@crm/core`.
import { keepPreviousData, queryOptions } from '@tanstack/react-query'
import { api } from '@/lib/http'

export const CONNECTION_STATUSES = ['pending', 'connecting', 'connected', 'paused', 'disconnected', 'banned'] as const
export type ConnectionStatus = (typeof CONNECTION_STATUSES)[number]

export const CONNECTION_BADGES = ['warming', 'degraded', 'requires_restart', 'scheduled_deletion'] as const
export type ConnectionBadge = (typeof CONNECTION_BADGES)[number]

export const PROXY_PROTOCOLS = ['http', 'https', 'socks5'] as const
export type ProxyProtocol = (typeof PROXY_PROTOCOLS)[number]

export const EPHEMERAL_DURATIONS = ['off', '1d', '7d', '90d'] as const
export type EphemeralDuration = (typeof EPHEMERAL_DURATIONS)[number]

/** `crm`: criada pelo CRM; `ai-manager`: chip importado do ai-manager (sessão gerenciada no painel de lá). */
export type ConnectionOrigin = 'crm' | 'ai-manager'

export interface ConnectionProxy {
  protocol: ProxyProtocol
  host: string
  port: number
  username: string | null
  has_password: boolean
}

export interface ConnectionDto {
  id: string
  name: string
  session_id: string
  phone_number: string | null
  /** Ausente em respostas antigas = `crm`. */
  origin?: ConnectionOrigin
  status: ConnectionStatus
  session_state: string | null
  badges: ConnectionBadge[]
  connection_state: 'open' | 'close' | null
  last_disconnect_reason: string | null
  disconnected_at: string | null
  connected_at: string | null
  notify_sent_by_me: boolean
  ephemeral_duration: EphemeralDuration
  save_contacts_enabled: boolean
  scheduled_for_deletion_at: string | null
  requires_restart: boolean
  proxy: ConnectionProxy | null
  created_at: string
  updated_at: string
  /** Runs pausados pela última queda (só na lista). */
  paused_flows_count?: number
}

export interface ConnectionLimits {
  /** `null` = sem limite. */
  connections: number | null
  used: number
}

export interface ConnectionsPage {
  items: ConnectionDto[]
  page: { page: number; limit: number; total_count: number | null; total_pages?: number | null; has_more: boolean }
  status_counts: Record<ConnectionStatus, number>
  limits?: ConnectionLimits
  /** Modo extensão (gateway no perfil ai-manager): mostra "Importar chips do ai-manager". */
  features?: { import_ai_manager?: boolean }
}

/** Chip do ai-manager ainda sem conexão no CRM (GET /api/connections/importable). */
export interface ImportableSession {
  session_id: string
  name: string
  phone_number: string | null
  session_state: string
  connected: boolean
  warmup_started_at: string | null
  last_connected_at: string | null
  created_at: string
}

export interface ListParams {
  search?: string
  status?: ConnectionStatus
  page?: number
}

/** Contagens do modal "fluxos pausados na queda" (evento `connection.reconnected_with_paused_flows`). */
export interface PausedFlowsCounts {
  paused_count: number
  waiting_count?: number
  failed_count?: number
  received_count?: number
  total_leads: number
}

export interface ProxyInput {
  protocol: ProxyProtocol
  host: string
  port: number
  username?: string
  /** Ausente mantém a senha salva. */
  password?: string
  remove_password?: boolean
}

export interface InstanceSettingsInput {
  ephemeral_duration: EphemeralDuration
  save_contacts_enabled: boolean
  notify_sent_by_me: boolean
}

export const CONNECTIONS_PAGE_SIZE = 20
export const CONNECTIONS_KEY = ['connections'] as const
export const listKey = (p: ListParams) =>
  [...CONNECTIONS_KEY, 'list', p.search ?? '', p.status ?? '', p.page ?? 1] as const
export const qrKey = (id: string) => [...CONNECTIONS_KEY, 'qr', id] as const
export const pairingKey = (id: string) => [...CONNECTIONS_KEY, 'pairing', id] as const
export const pausedKey = (id: string) => [...CONNECTIONS_KEY, 'paused', id] as const
export const importableKey = [...CONNECTIONS_KEY, 'importable'] as const

const enc = encodeURIComponent
const base = (id: string) => `/api/connections/${enc(id)}`

export const connectionsListQuery = (p: ListParams) =>
  queryOptions({
    queryKey: listKey(p),
    queryFn: () =>
      api.get<ConnectionsPage>('/api/connections', {
        query: { search: p.search || undefined, status: p.status, page: p.page ?? 1, limit: CONNECTIONS_PAGE_SIZE },
      }),
    placeholderData: keepPreviousData,
  })

export const qrQuery = (id: string, enabled: boolean) =>
  queryOptions({
    queryKey: qrKey(id),
    queryFn: () => api.get<{ qr_code: string | null; generated_at: string | null }>(`${base(id)}/qr`),
    enabled,
    // O QR do WhatsApp expira em ~20 s (08 §5.4); o `connection.qr_updated` atualiza antes.
    refetchInterval: 20_000,
  })

export const importableQuery = (enabled: boolean) =>
  queryOptions({
    queryKey: importableKey,
    queryFn: () => api.get<{ items: ImportableSession[] }>('/api/connections/importable'),
    enabled,
  })

export const pausedFlowsQuery = (id: string, enabled: boolean) =>
  queryOptions({
    queryKey: pausedKey(id),
    queryFn: () => api.get<PausedFlowsCounts>(`${base(id)}/paused-flows`),
    enabled,
  })

type One = { connection: ConnectionDto }

export const connectionsApi = {
  create: (name: string) => api.post<One>('/api/connections', { name }),
  rename: (id: string, name: string) => api.patch<One>(base(id), { name }),
  connect: (id: string) => api.post<One>(`${base(id)}/connect`),
  disconnect: (id: string) => api.post<One>(`${base(id)}/disconnect`),
  restart: (id: string) => api.post<One>(`${base(id)}/restart`),
  scheduleDeletion: (id: string) => api.post<One>(`${base(id)}/schedule-deletion`),
  importSessions: (sessionIds: string[]) =>
    api.post<{ items: ConnectionDto[] }>('/api/connections/import', { session_ids: sessionIds }),
  /** Só conexões importadas: o CRM larga o chip; nada muda no ai-manager. */
  unlink: (id: string) => api.post<{ unlinked: { id: string; session_id: string } }>(`${base(id)}/unlink`),
  pairingCode: (id: string, phone: string) => api.post<{ code: string }>(`${base(id)}/pairing-code`, { phone }),
  setProxy: (id: string, input: ProxyInput) => api.post<One>(`${base(id)}/proxy`, input),
  removeProxy: (id: string) => api.delete<One>(`${base(id)}/proxy`),
  instanceSettings: (id: string, input: InstanceSettingsInput) => api.post<One>(`${base(id)}/instance-settings`, input),
  cancelAllFlowRuns: (id: string, confirmationName: string) =>
    api.post<{ cancelled: number }>(`${base(id)}/cancel-all-flow-runs`, { confirmation_name: confirmationName }),
  resumePausedFlows: (id: string) => api.post<{ resumed: number }>(`${base(id)}/paused-flows/resume`),
  cancelPausedFlows: (id: string) => api.post<{ cancelled: number }>(`${base(id)}/paused-flows/cancel`),
}
