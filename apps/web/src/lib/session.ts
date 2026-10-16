// Sessão no cliente: perfil (`GET /api/auth/profile`), empresa ativa e permissões efetivas (SPEC 3.3; spec 18 §5.4).
// O perfil traz o papel e as permissões efetivas de cada empresa (as que o servidor aplica); sem elas, a matriz do papel.
// O servidor sempre revalida com `requirePerm`: aqui é só para esconder/desabilitar e guiar a navegação.
import { queryOptions, type QueryClient } from '@tanstack/react-query'
import { effectivePermissions, type CompanyRole, type PermissionKey, type User } from '@crm/shared'
import { api, HttpError, PROFILE_PATH, setActiveCompany } from './http'

export interface CompanySummary {
  id: string
  name: string
  slug: string
  role: CompanyRole
  /** T91: permissões efetivas que o servidor aplica (lista explícita do membro ou matriz do papel). */
  effective_permissions?: PermissionKey[]
}

export interface Profile {
  user: User & { personal_whatsapp?: string | null }
  companies: CompanySummary[]
}

export interface Session {
  user: Profile['user']
  companies: CompanySummary[]
  company: CompanySummary | null
  role: CompanyRole | null
  isOwner: boolean
  isSupport: boolean
  isPlatformAdmin: boolean
  perms: ReadonlySet<PermissionKey>
}

export const profileQueryKey = ['auth', 'profile'] as const

/** `null` = sem sessão (401). */
export const profileQuery = () =>
  queryOptions({
    queryKey: profileQueryKey,
    queryFn: async (): Promise<Profile | null> => {
      try {
        return await api.get<Profile>(PROFILE_PATH)
      } catch (err) {
        if (err instanceof HttpError && err.status === 401) return null
        throw err
      }
    },
    staleTime: 60_000,
    retry: false,
  })

/** Monta a sessão do perfil: empresa ativa = `last_company_id` (se ainda é membro) ou a primeira. */
export function sessionFrom(profile: Profile): Session {
  const company = profile.companies.find((c) => c.id === profile.user.last_company_id) ?? profile.companies[0] ?? null
  const isSupport = profile.user.system_role === 'support'
  const role = company?.role ?? null
  // As do servidor quando o perfil traz (respeitam a lista explícita do membro); a matriz do papel é só fallback.
  const perms = !role
    ? new Set<PermissionKey>(['profile.view'])
    : Array.isArray(company?.effective_permissions)
      ? new Set<PermissionKey>(company.effective_permissions)
      : effectivePermissions({ role, permission_keys: null, system_role: profile.user.system_role })
  return {
    user: profile.user,
    companies: profile.companies,
    company,
    role,
    isOwner: role === 'owner',
    isSupport,
    isPlatformAdmin: profile.user.system_role === 'platform_admin',
    perms,
  }
}

/** Lê (do cache ou da API) a sessão atual; `null` sem login. Ajusta o `X-Company-Id` do cliente HTTP. */
export async function loadSession(queryClient: QueryClient): Promise<Session | null> {
  const profile = await queryClient.fetchQuery(profileQuery())
  if (!profile) {
    setActiveCompany(null)
    return null
  }
  const session = sessionFrom(profile)
  setActiveCompany(session.company?.id ?? null)
  return session
}

/** O usuário tem alguma das permissões? Owner sempre passa (spec 18 §2.5). */
export function hasAny(session: Pick<Session, 'isOwner' | 'perms'>, keys: readonly string[] | null | undefined): boolean {
  if (!keys || keys.length === 0) return true
  if (session.isOwner) return true
  return keys.some((k) => (session.perms as ReadonlySet<string>).has(k))
}
