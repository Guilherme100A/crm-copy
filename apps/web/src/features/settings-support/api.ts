// API do acesso de suporte (T32; 16 §3.7, §5 "Acesso de suporte"). Lado empresa (owner/admin): pedidos, aprovar
// (12 h), recusar, concessões e revogar. Lado suporte (`system_role = support`): pedir por e-mail (lookup),
// reenviar, cancelar, concessões e fluxos da empresa concedida. DTOs locais.
import { queryOptions } from '@tanstack/react-query'
import { api } from '@/lib/http'

export type SupportRequestStatus = 'pending' | 'approved' | 'rejected' | 'cancelled'

export interface SupportAccessRequestDto {
  id: string
  status: SupportRequestStatus
  support_user_id: string
  support_name: string
  support_email: string
  company_id: string
  company_name: string
  decided_at: string | null
  resent_at: string | null
  created_at: string
  updated_at: string
}

export interface SupportAccessGrantDto {
  id: string
  support_user_id: string
  name: string
  email: string
  company_id: string
  company_name: string
  request_id: string | null
  expires_at: string
  created_at: string
}

export interface SupportAccountDto {
  id: string
  name: string
}

export interface SupportFlowDto {
  id: string
  name: string
  folder_id: string | null
  status: string
  updated_at: string
}

export const SUPPORT_KEY = ['settings-support'] as const
const enc = encodeURIComponent

/** Fila do modal global: pedidos pendentes da empresa (mais antigos primeiro). */
export const pendingRequestsKey = (companyId: string | null | undefined) => [...SUPPORT_KEY, companyId ?? '', 'pending'] as const
export const pendingRequestsQuery = (companyId: string | null | undefined) =>
  queryOptions({
    queryKey: pendingRequestsKey(companyId),
    queryFn: async () =>
      (await api.get<{ requests: SupportAccessRequestDto[] }>('/api/support-access/requests', { query: { status: 'pending' } }))
        .requests,
    retry: false,
    staleTime: 30_000,
  })

export const companyGrantsKey = (companyId: string | null | undefined) => [...SUPPORT_KEY, companyId ?? '', 'grants'] as const
export const companyGrantsQuery = (companyId: string | null | undefined) =>
  queryOptions({
    queryKey: companyGrantsKey(companyId),
    queryFn: async () => (await api.get<{ grants: SupportAccessGrantDto[] }>('/api/support-access/grants')).grants,
    retry: false,
  })

export const companySupportApi = {
  approve: (id: string) =>
    api.post<{ request: SupportAccessRequestDto; grant: SupportAccessGrantDto }>(`/api/support-access/requests/${enc(id)}/approve`),
  reject: (id: string) => api.post<{ request: SupportAccessRequestDto }>(`/api/support-access/requests/${enc(id)}/reject`),
  revoke: (supportUserId: string) =>
    api.delete<{ grant: SupportAccessGrantDto }>(`/api/support-access/grants/${enc(supportUserId)}`),
}

// ---------- lado do suporte ----------

/** Sem SSE (o suporte sem empresa ativa não abre o stream): atualiza por intervalo e ao focar a aba. */
const POLL_MS = 15_000
export const MY_KEY = [...SUPPORT_KEY, 'me'] as const

export const myRequestsQuery = () =>
  queryOptions({
    queryKey: [...MY_KEY, 'requests'] as const,
    queryFn: async () => (await api.get<{ requests: SupportAccessRequestDto[] }>('/api/support/access-requests')).requests,
    refetchInterval: POLL_MS,
    refetchOnWindowFocus: true,
  })

export const myGrantsQuery = () =>
  queryOptions({
    queryKey: [...MY_KEY, 'grants'] as const,
    queryFn: async () => (await api.get<{ grants: SupportAccessGrantDto[] }>('/api/support/access-grants')).grants,
    refetchInterval: POLL_MS,
    refetchOnWindowFocus: true,
  })

export const grantFlowsQuery = (companyId: string) =>
  queryOptions({
    queryKey: [...MY_KEY, 'flows', companyId] as const,
    queryFn: async () => (await api.get<{ flows: SupportFlowDto[] }>(`/api/support/access-grants/${enc(companyId)}/flows`)).flows,
    retry: false,
  })

export const supportApi = {
  lookup: async (email: string) =>
    (await api.post<{ accounts: SupportAccountDto[] }>('/api/support/access-requests/lookup', { email })).accounts,
  request: async (input: { email: string; company_id?: string }) =>
    (await api.post<{ request: SupportAccessRequestDto }>('/api/support/access-requests', input)).request,
  resend: async (id: string) =>
    (await api.post<{ request: SupportAccessRequestDto }>(`/api/support/access-requests/${enc(id)}/resend`)).request,
  cancel: (id: string) => api.delete<{ request: SupportAccessRequestDto }>(`/api/support/access-requests/${enc(id)}`),
}
