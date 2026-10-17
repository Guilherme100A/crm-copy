// API da equipe (T22/T31; 16 §3.4, §5 Equipe): membros, papel, permissões granulares, escopo de chat, remoção e
// transferência de propriedade. DTOs locais: a web não importa `@crm/core`.
import { queryOptions } from '@tanstack/react-query'
import type { CompanyRole } from '@crm/shared'
import { api } from '@/lib/http'

export interface MemberDto {
  /** `company_members.id` (é o `memberId` do escopo de chat). */
  id: string
  company_id: string
  user_id: string
  role: CompanyRole
  /** `null` = matriz padrão do papel. */
  permission_keys: string[] | null
  effective_permissions: string[]
  user: { id: string; name: string; email: string }
  /** T54: departamentos do escopo de chat; vazio = sem departamento. */
  department_ids?: string[]
  created_at: string
}

export interface DepartmentDto {
  id: string
  name: string
  color: string
}

export interface ConnectionLite {
  id: string
  name: string
}

export interface MemberScopeDto {
  member_id: string
  department_ids: string[]
  connection_ids: string[]
}

export interface PermissionDefinitions {
  groups: { key: string; keys: string[] }[]
  always_granted: string[]
  owner_only: string[]
  role?: CompanyRole
  defaults?: string[]
}

export const TEAM_KEY = ['settings-team'] as const
const enc = encodeURIComponent

export const teamQuery = () =>
  queryOptions({
    queryKey: [...TEAM_KEY, 'members'] as const,
    queryFn: async () => (await api.get<{ items: MemberDto[] }>('/api/team')).items,
    retry: false,
  })

export const departmentsAllQuery = () =>
  queryOptions({
    queryKey: [...TEAM_KEY, 'departments'] as const,
    queryFn: async () => (await api.get<{ items: DepartmentDto[] }>('/api/departments/all')).items,
    staleTime: 60_000,
    retry: false,
  })

export const connectionsQuery = () =>
  queryOptions({
    queryKey: [...TEAM_KEY, 'connections'] as const,
    queryFn: async () => (await api.get<{ items: ConnectionLite[] }>('/api/connections', { query: { limit: 100 } })).items,
    staleTime: 60_000,
    retry: false,
  })

export const definitionsQuery = (role: CompanyRole) =>
  queryOptions({
    queryKey: [...TEAM_KEY, 'definitions', role] as const,
    queryFn: () => api.get<PermissionDefinitions>('/api/permissions/definitions', { query: { role } }),
    staleTime: 5 * 60_000,
  })

export const scopeQuery = (memberId: string) =>
  queryOptions({
    queryKey: [...TEAM_KEY, 'scope', memberId] as const,
    queryFn: async () => (await api.get<{ scope: MemberScopeDto }>(`/api/departments/members/${enc(memberId)}/scope`)).scope,
    retry: false,
  })

export const teamApi = {
  update: async (userId: string, input: { role?: 'admin' | 'member'; permission_keys?: string[] | null }) =>
    (await api.patch<{ member: MemberDto }>(`/api/team/${enc(userId)}`, input)).member,
  remove: (userId: string) => api.delete<{ removed: true }>(`/api/team/${enc(userId)}`),
  transfer: (userId: string) =>
    api.post<{ owner: MemberDto; previous_owner: MemberDto }>(`/api/team/${enc(userId)}/transfer-ownership`),
  saveScope: async (memberId: string, input: { department_ids: string[]; connection_ids: string[] }) =>
    (await api.put<{ scope: MemberScopeDto }>(`/api/departments/members/${enc(memberId)}/scope`, input)).scope,
}
