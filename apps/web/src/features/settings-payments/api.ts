// API das integrações de Vendas e Rastreamento (T114; 19 §3.1, §3.2, §3.4, §6): chaves de pagamento (T109, só XPag —
// Zenith fora de escopo, SPEC 10.1 nº 13), emissores de NF Notasy (T112) e UTMify (T113). Segredos/tokens nunca voltam
// no DTO; na edição, campo em branco mantém o atual (o corpo só leva o campo preenchido). Tipos locais (fora do shared).
import { queryOptions } from '@tanstack/react-query'
import { PRODUCTS_KEY, type ProductDto } from '@/features/settings-products/api'
import { api, HttpError } from '@/lib/http'

const enc = encodeURIComponent

// ---------------------------------------------------------------- pagamentos (XPag)

/** Gateways desta UI (Zenith fora de escopo). */
export const PAYMENT_GATEWAYS_UI = ['xpag'] as const
export type PaymentGatewayUi = (typeof PAYMENT_GATEWAYS_UI)[number]
export const GATEWAY_LABEL: Record<string, string> = { xpag: 'XPag', zenith: 'Zenith' }

export interface PaymentIntegrationDto {
  id: string
  label: string
  gateway: string
  client_id: string
  secret_configured: boolean
  /** `…abcd` ou `null`. */
  secret_hint: string | null
  webhook_url: string
  zenith_oauth: boolean
  last_tested_at: string | null
  last_test_ok: boolean | null
  created_at: string
  updated_at: string
}

export interface ConnectionTest {
  ok: boolean
  error?: string
}

export interface PaymentIntegrationInput {
  label: string
  gateway: string
  client_id: string
  client_secret?: string
}

export const PAYMENTS_KEY = ['integrations', 'payments'] as const

export const paymentsApi = {
  list: async (gateway?: string) =>
    (await api.get<{ items: PaymentIntegrationDto[] }>('/api/payment-integrations', { query: { gateway } })).items,
  get: async (id: string) =>
    (await api.get<{ integration: PaymentIntegrationDto }>(`/api/payment-integrations/${enc(id)}`)).integration,
  create: async (input: PaymentIntegrationInput) =>
    (
      await api.post<{ integration: PaymentIntegrationDto }>('/api/payment-integrations', {
        payment_integration: input,
      })
    ).integration,
  update: async (id: string, input: Partial<PaymentIntegrationInput>) =>
    (
      await api.patch<{ integration: PaymentIntegrationDto }>(`/api/payment-integrations/${enc(id)}`, {
        payment_integration: input,
      })
    ).integration,
  remove: (id: string) => api.delete(`/api/payment-integrations/${enc(id)}`),
  test: (id: string) => api.post<ConnectionTest>(`/api/payment-integrations/${enc(id)}/test-connection`, {}),
}

// ---------------------------------------------------------------- NF (Notasy) e UTMify

/** Emissor de NF ou integração UTMify: mesmo formato (nome da empresa + token write-only). */
export interface TokenIntegrationDto {
  id: string
  name: string
  company_name: string
  token_configured: boolean
  token_hint: string | null
  provider?: string
  created_at: string
  updated_at: string
}

export interface TokenIntegrationInput {
  company_name: string
  integration_token?: string
}

export interface IntegrationUsage {
  flows: { id: string; name: string }[]
  in_use: boolean
}

export type TokenKind = 'invoice' | 'utmify'

export const INVOICES_KEY = ['integrations', 'invoices'] as const
export const UTMIFY_KEY = ['integrations', 'utmify'] as const

const TOKEN_ROUTES: Record<TokenKind, { path: string; list: string; one: string; key: readonly string[] }> = {
  invoice: {
    path: '/api/invoice-integrations',
    list: 'invoice_integrations',
    one: 'invoice_integration',
    key: INVOICES_KEY,
  },
  utmify: { path: '/api/utmify-integrations', list: 'utmify_integrations', one: 'utmify_integration', key: UTMIFY_KEY },
}

export const tokenKey = (kind: TokenKind) => TOKEN_ROUTES[kind].key

/** Corpo do POST/PUT no envelope do produto de referência; token vazio não vai (mantém o atual). */
export function tokenBody(
  kind: TokenKind,
  input: { company_name: string; integration_token: string },
  create: boolean,
): Record<string, unknown> {
  const inner: Record<string, unknown> = { company_name: input.company_name.trim() }
  if (create && kind === 'invoice') inner.provider = 'notasy'
  const token = input.integration_token.trim()
  if (token) inner.integration_token = token
  return { [TOKEN_ROUTES[kind].one]: inner }
}

export function tokenApi(kind: TokenKind) {
  const r = TOKEN_ROUTES[kind]
  return {
    list: async (configuredOnly = false) =>
      (
        await api.get<Record<string, TokenIntegrationDto[]>>(r.path, {
          query: { configured: configuredOnly ? '1' : undefined },
        })
      )[r.list] ?? [],
    create: async (body: Record<string, unknown>) =>
      (await api.post<Record<string, TokenIntegrationDto>>(r.path, body))[r.one]!,
    update: async (id: string, body: Record<string, unknown>) =>
      (await api.put<Record<string, TokenIntegrationDto>>(`${r.path}/${enc(id)}`, body))[r.one]!,
    usage: (id: string) => api.get<IntegrationUsage>(`${r.path}/${enc(id)}/usage`),
    remove: (id: string, force = false) =>
      api.delete(`${r.path}/${enc(id)}`, force ? { query: { force: '1' } } : undefined),
  }
}

// ---------------------------------------------------------------- listas para os editores de bloco

export interface Listed<T> {
  items: T[]
  /** Sem permissão (403) ou rota ausente (404): o editor mostra o aviso e segue utilizável. */
  denied: boolean
}

export async function listed<T>(load: () => Promise<T[]>): Promise<Listed<T>> {
  try {
    return { items: await load(), denied: false }
  } catch (err) {
    if (err instanceof HttpError && (err.status === 403 || err.status === 404)) return { items: [], denied: true }
    throw err
  }
}

/** Chaves do gateway para o bloco Pagamento. */
export const gatewayKeysQuery = (gateway: string) =>
  queryOptions({
    queryKey: [...PAYMENTS_KEY, 'block', gateway] as const,
    queryFn: () => listed(() => paymentsApi.list(gateway)),
  })

/** Emissores de NF para o bloco Venda aprovada. */
export const issuersQuery = () =>
  queryOptions({
    queryKey: [...INVOICES_KEY, 'block'] as const,
    queryFn: () => listed(() => tokenApi('invoice').list()),
  })

/** Produtos para o bloco Venda aprovada (mesma raiz de chave da T90: o `ProductDialog` invalida e a lista recarrega). */
export const blockProductsQuery = () =>
  queryOptions({
    queryKey: [...PRODUCTS_KEY, 'block'] as const,
    queryFn: () => listed(async () => (await api.get<{ items: ProductDto[] }>('/api/products')).items),
  })

/** Integrações UTMify com token (`?configured=1`, 11 §3.6) para o bloco Venda aprovada. */
export const utmifyConfiguredQuery = () =>
  queryOptions({
    queryKey: [...UTMIFY_KEY, 'block'] as const,
    queryFn: () => listed(() => tokenApi('utmify').list(true)),
  })
