// API de convites (T22; 16 §3.5, §3.6, §5 Equipe 8–9 e Convites para Plataforma): lista paginada com contagem por
// status, criar, reenviar (limite 3/dia e intervalo mínimo), cancelar e gerar link. DTOs locais.
import { keepPreviousData, queryOptions } from '@tanstack/react-query'
import { api } from '@/lib/http'

export type InvitationKind = 'member' | 'platform'
export const INVITATION_STATUSES = ['pending', 'accepted', 'declined', 'expired'] as const
export type InvitationStatus = (typeof INVITATION_STATUSES)[number]
export type StatusCounts = Record<'total' | InvitationStatus, number>

export interface InvitationDto {
  id: string
  kind: InvitationKind
  email: string
  role: 'admin' | 'member'
  status: InvitationStatus
  created_at: string
  updated_at: string
  expires_at: string
  can_resend: boolean
  resends_remaining_today: number
  invited_by: { id: string; name: string } | null
  company?: { id?: string; name?: string; slug?: string; description?: string | null } | null
}

export interface PageMeta {
  page: number
  limit: number
  total_count: number | null
  total_pages?: number | null
  has_more: boolean
}

export interface InvitationsPage {
  items: InvitationDto[]
  page: PageMeta
  status_counts: StatusCounts
}

export const INVITATIONS_PAGE_SIZE = 20
export const INVITATIONS_KEY = ['settings-invitations'] as const
const enc = encodeURIComponent

export const invitationsQuery = (kind: InvitationKind, f: { status?: InvitationStatus; search?: string; page?: number }) =>
  queryOptions({
    queryKey: [...INVITATIONS_KEY, kind, f.status ?? 'all', f.search ?? '', f.page ?? 1] as const,
    queryFn: () =>
      api.get<InvitationsPage>('/api/team/invitations', {
        query: { kind, status: f.status, search: f.search || undefined, page: f.page ?? 1, limit: INVITATIONS_PAGE_SIZE },
      }),
    placeholderData: keepPreviousData,
    retry: false,
  })

export const invitationsApi = {
  create: (input: { kind: InvitationKind; email: string; role: 'admin' | 'member' }) =>
    api.post<{ invitation: InvitationDto; invitation_link: string }>('/api/team/invitations', input),
  resend: (id: string) => api.post<{ invitation: InvitationDto; invitation_link: string }>(`/api/team/invitations/${enc(id)}/resend`),
  cancel: (id: string) => api.post<{ invitation: InvitationDto }>(`/api/team/invitations/${enc(id)}/cancel`),
  link: async (id: string) => (await api.post<{ invitation_link: string }>(`/api/team/invitations/${enc(id)}/link`)).invitation_link,
}
