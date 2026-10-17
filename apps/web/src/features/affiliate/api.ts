// Config do app em tempo de execução (`GET /api/app-config`, T97; a T108 acrescenta campos). DTO local.
import { queryOptions } from '@tanstack/react-query'
import { api } from '@/lib/http'

export interface AppConfigDto {
  affiliate_portal_url: string | null
}

export const appConfigKey = ['app-config'] as const

export const appConfigQuery = () =>
  queryOptions({
    queryKey: appConfigKey,
    queryFn: () => api.get<AppConfigDto>('/api/app-config'),
    staleTime: 5 * 60_000,
  })

/** URL do portal só se for http/https absoluta (defesa extra: o servidor já valida). */
export function portalUrlOf(config: Partial<AppConfigDto> | undefined): string | null {
  const raw = config?.affiliate_portal_url
  if (typeof raw !== 'string' || !raw) return null
  try {
    const url = new URL(raw)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : null
  } catch {
    return null
  }
}
