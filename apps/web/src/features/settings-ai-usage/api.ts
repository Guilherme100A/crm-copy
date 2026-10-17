// API do consumo de IA (T37; 12 §3.10/§6.2): carteira (com a última recarga, T59), extrato com cursor, resumo agrupado e
// cotas. Os DTOs do fio não estão em `@crm/shared`: tipos locais. Todas as rotas exigem `ai_usage.view`.
import { infiniteQueryOptions, queryOptions } from '@tanstack/react-query'
import { api } from '@/lib/http'

export type WalletStatus = 'ok' | 'low' | 'exhausted'

export interface WalletDto {
  balance_credits: number
  low_threshold_credits: number
  max_overrun_credits: number
  status: WalletStatus
  lifetime_credited_credits: number
  lifetime_spent_credits: number
  last_topup?: { amount_credits: number; created_at: string } | null
}

export type UsageStatus = 'charged' | 'refunded' | 'error'

export interface UsageDto {
  id: string
  created_at: string
  feature: string | null
  agent_id: string | null
  provider: string
  model: string
  kind: string
  input_tokens: number
  output_tokens: number
  cost_micros: number
  credits: number
  status: UsageStatus
  error_code: string | null
}

export type SummaryGroup = 'day' | 'feature' | 'model' | 'agent'

export interface SummaryItem {
  key: string | null
  count: number
  input_tokens: number
  output_tokens: number
  cost_micros: number
  credits: number
}

export interface SummaryDto {
  group_by: SummaryGroup
  time_zone: string
  items: SummaryItem[]
}

export interface QuotaDto {
  period: 'day' | 'month'
  max_credits: number | null
  max_cost_micros: number | null
  max_tokens: number | null
  hard: boolean
  updated_at: string | null
}

export interface UsageFilters {
  from?: string
  to?: string
  feature?: string
  provider?: string
  model?: string
  status?: UsageStatus
}

export const AI_USAGE_KEY = ['settings-ai-usage'] as const
/** Por empresa: o realtime (`ai_wallet.updated`) grava direto na chave da empresa do evento. */
export const walletKey = (companyId: string | null | undefined) => ['ai-wallet', companyId ?? ''] as const

export const walletQuery = (companyId: string | null | undefined) =>
  queryOptions({
    queryKey: walletKey(companyId),
    queryFn: async () => (await api.get<{ wallet: WalletDto }>('/api/ai/wallet')).wallet,
    // AC-T59-01: atualiza ao voltar para a aba (o padrão do app é `false`).
    refetchOnWindowFocus: true,
    staleTime: 15_000,
  })

export const USAGE_PAGE = 50

export const usageInfiniteQuery = (companyId: string, filters: UsageFilters) =>
  infiniteQueryOptions({
    queryKey: [...AI_USAGE_KEY, companyId, 'usage', filters] as const,
    queryFn: ({ pageParam }) =>
      api.get<{ items: UsageDto[]; next_cursor: string | null }>('/api/ai/usage', {
        query: { ...filters, limit: USAGE_PAGE, cursor: pageParam ?? undefined },
      }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.next_cursor,
  })

/** Há algum uso (de qualquer época) nesta empresa? Decide o estado vazio da aba. */
export const anyUsageQuery = (companyId: string) =>
  queryOptions({
    queryKey: [...AI_USAGE_KEY, companyId, 'any'] as const,
    queryFn: async () => (await api.get<{ items: UsageDto[] }>('/api/ai/usage', { query: { limit: 1 } })).items.length > 0,
  })

export const summaryQuery = (companyId: string, group_by: SummaryGroup, range: { from?: string; to?: string }, enabled = true) =>
  queryOptions({
    queryKey: [...AI_USAGE_KEY, companyId, 'summary', group_by, range] as const,
    queryFn: () => api.get<SummaryDto>('/api/ai/usage/summary', { query: { group_by, ...range } }),
    enabled,
  })

export const quotasQuery = (companyId: string) =>
  queryOptions({
    queryKey: [...AI_USAGE_KEY, companyId, 'quotas'] as const,
    queryFn: async () => (await api.get<{ quotas: QuotaDto[] }>('/api/ai/quotas')).quotas,
  })
