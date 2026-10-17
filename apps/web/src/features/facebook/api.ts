// Cliente das rotas Meta (T99, T101, T103, T104): perfis/contas, OAuth, bundle do Gerenciador, edição de entidades e
// pixels. Formas espelham os DTOs do servidor (snake_case no fio, SPEC 3.6).
import { api, buildUrl } from '@/lib/http'
import type { BundleLevel, EntityPatch } from './rules'

// ---------------------------------------------------------------- perfis (T99)

export interface MetaAdAccount {
  id: string
  profile_id?: string
  fb_account_id: string
  account_id: string
  name: string | null
  currency: string | null
  account_status: number | null
  included_in_dashboard: boolean
}

export interface MetaProfile {
  id: string
  fb_user_id: string
  fb_user_name: string | null
  picture_url: string | null
  active: boolean
  token_expires_at: string | null
  ad_accounts: MetaAdAccount[]
  ad_accounts_count: number
  ad_accounts_included_count: number
}

export const profilesKey = (companyId: string | null | undefined) => ['facebook', 'profiles', companyId ?? ''] as const

export const fetchProfiles = () => api.get<{ items: MetaProfile[] }>('/api/meta/profiles').then((r) => r.items)
export const deleteProfile = (id: string) => api.delete<void>(`/api/meta/profiles/${encodeURIComponent(id)}`)
export const refreshAdAccounts = (id: string) =>
  api.post<{ profile: MetaProfile }>(`/api/meta/profiles/${encodeURIComponent(id)}/refresh-ad-accounts`, {}).then((r) => r.profile)
export const setAccountIncluded = (id: string, included: boolean) =>
  api.put<{ ad_account: MetaAdAccount }>(`/api/meta/ad-accounts/${encodeURIComponent(id)}`, { included_in_dashboard: included }).then((r) => r.ad_account)
export const startOAuth = (profileId?: string) =>
  api.post<{ oauth_url: string }>('/api/meta/oauth/start', profileId ? { profile_id: profileId } : {}).then((r) => r.oauth_url)

// ---------------------------------------------------------------- Gerenciador (T101, T103)

export interface BundleRow {
  id: string
  name: string
  status: string
  objective?: string | null
  campaign_id?: string | null
  campaign_name?: string | null
  adset_id?: string | null
  adset_name?: string | null
  ad_account_id: string
  fb_ad_account_id: string
  ad_account_label: string
  currency: string | null
  daily_budget: number | null
  lifetime_budget: number | null
  daily_budget_display: number | null
  lifetime_budget_display: number | null
  metrics: {
    meta_spend: number
    purchase_value_meta: number | null
    purchases_pixel: number | null
    conversations_meta: number | null
    meta_link_clicks: number | null
    meta_impressions: number | null
    cost_per_purchase_meta: number | null
    cost_per_lead_meta: number | null
    purchase_value_leona: number | null
    purchases_leona: number | null
  } & Partial<Record<string, number | null>>
}

export interface BundleEnvelope {
  bundle_key: string
  status: 'loading' | 'partial' | 'refreshing' | 'ready'
  campaign: BundleRow[]
  adset: BundleRow[]
  ad: BundleRow[]
  targets_done: number
  targets_total: number
  errors: { ad_account_id: string; fb_ad_account_id: string; error: string }[]
  display_currency: string
  since: string
  until: string
  status_filter: string
  warnings: string[]
  cached: boolean
  generated_at: string | null
}

export interface BundleQuery {
  status_filter: 'active' | 'all'
  date_preset: string
  since?: string
  until?: string
  display_currency: string
  /** Ids LOCAIS das contas aplicadas no filtro (vazio = todas as incluídas). */
  ad_account_ids: string[]
}

/** `async` = 202 com o estado até o job terminar; `sync` = monta/lê na hora; `force` = refaz ignorando o cache. */
export type BundleMode = 'async' | 'sync' | 'force'

export const bundleKeyPrefix = ['facebook', 'bundle'] as const
export const bundleQueryKey = (companyId: string | null | undefined, q: BundleQuery) =>
  [...bundleKeyPrefix, companyId ?? '', [...q.ad_account_ids].sort().join(','), q.date_preset, q.since ?? '', q.until ?? '', q.status_filter, q.display_currency] as const

export function fetchBundle(q: BundleQuery, mode: BundleMode): Promise<BundleEnvelope> {
  return api.get<BundleEnvelope>('/api/meta/structure-bundle', {
    query: {
      status_filter: q.status_filter,
      date_preset: q.date_preset,
      since: q.since,
      until: q.until,
      display_currency: q.display_currency,
      ad_account_ids: q.ad_account_ids.length ? [...q.ad_account_ids].sort().join(',') : undefined,
      async: mode === 'sync' ? undefined : 1,
      force_refresh: mode === 'force' ? 1 : undefined,
    },
  })
}

export const patchEntity = (id: string, body: EntityPatch) =>
  api.patch<{ success: boolean; entity?: unknown }>(`/api/meta/structure-entities/${encodeURIComponent(id)}`, body)

// ---------------------------------------------------------------- pixels (T104)

export interface PixelConfig {
  id: string
  name: string
  platform: string
  masked_pixel_id: string
  masked_access_token: string
  auto_send_sales: boolean
  pixel_id?: string
  access_token?: string
}

export interface PixelInput {
  name: string
  pixel_id: string
  access_token?: string | null
  platform: string
  auto_send_sales: boolean
}

export const pixelsKey = (companyId: string | null | undefined) => ['facebook', 'pixels', companyId ?? ''] as const

export const fetchPixels = () => api.get<{ items: PixelConfig[] }>('/api/meta/pixels').then((r) => r.items)
export const fetchPixel = (id: string) =>
  api.get<{ pixel: PixelConfig }>(buildUrl(`/api/meta/pixels/${encodeURIComponent(id)}`, { include_access_token: 'true' })).then((r) => r.pixel)
export const createPixel = (input: PixelInput) => api.post<{ pixel: PixelConfig }>('/api/meta/pixels', input).then((r) => r.pixel)
export const updatePixel = (id: string, input: PixelInput) => api.put<{ pixel: PixelConfig }>(`/api/meta/pixels/${encodeURIComponent(id)}`, input).then((r) => r.pixel)
export const deletePixel = (id: string) => api.delete<void>(`/api/meta/pixels/${encodeURIComponent(id)}`)

export type { BundleLevel }
