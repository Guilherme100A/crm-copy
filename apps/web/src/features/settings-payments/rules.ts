// Regras puras dos modais de Vendas/Rastreamento (T114; 19 §3.1, §3.2, §4.1, §5.1–§5.2), réplica das do servidor
// (a web não importa `@crm/core`): nome ≥ 2, Client ID obrigatório, segredo/token obrigatório só na criação (em branco
// na edição = manter), status Ativo pelo segredo/token configurado e o mapeamento DTO → card do hub.
import type { IntegrationRecord } from '@/features/integrations/catalog'
import { HttpError } from '@/lib/http'
import {
  GATEWAY_LABEL,
  type PaymentIntegrationDto,
  type PaymentIntegrationInput,
  type TokenIntegrationDto,
  type TokenKind,
} from './api'

export const LABEL_MIN = 2
export const LABEL_MAX = 120
export const CLIENT_ID_MAX = 500
export const SECRET_MAX = 1000
export const TOKEN_MAX = 2000

export type FormError =
  | 'labelMin'
  | 'labelMax'
  | 'clientIdRequired'
  | 'clientIdMax'
  | 'secretRequired'
  | 'secretMax'
  | 'companyMin'
  | 'companyMax'
  | 'tokenRequired'
  | 'tokenMax'

export interface PaymentForm {
  label: string
  client_id: string
  client_secret: string
}

export type PaymentFormErrors = Partial<Record<keyof PaymentForm, FormError>>

export function validatePaymentForm(f: PaymentForm, mode: 'create' | 'edit'): PaymentFormErrors {
  const out: PaymentFormErrors = {}
  const label = f.label.trim()
  if (label.length < LABEL_MIN) out.label = 'labelMin'
  else if (label.length > LABEL_MAX) out.label = 'labelMax'
  const id = f.client_id.trim()
  if (!id) out.client_id = 'clientIdRequired'
  else if (id.length > CLIENT_ID_MAX) out.client_id = 'clientIdMax'
  const secret = f.client_secret.trim()
  if (mode === 'create' && !secret) out.client_secret = 'secretRequired'
  else if (f.client_secret.length > SECRET_MAX) out.client_secret = 'secretMax'
  return out
}

/** Corpo do POST (criação) ou do PATCH (edição: segredo só quando preenchido; gateway não muda). */
export function paymentBody(f: PaymentForm, gateway: string, mode: 'create' | 'edit'): PaymentIntegrationInput {
  const body: PaymentIntegrationInput = { label: f.label.trim(), gateway, client_id: f.client_id.trim() }
  const secret = f.client_secret.trim()
  if (mode === 'create' || secret) body.client_secret = secret
  return body
}

export interface TokenForm {
  company_name: string
  integration_token: string
}

export type TokenFormErrors = Partial<Record<keyof TokenForm, FormError>>

export function validateTokenForm(f: TokenForm, mode: 'create' | 'edit'): TokenFormErrors {
  const out: TokenFormErrors = {}
  const name = f.company_name.trim()
  if (name.length < LABEL_MIN) out.company_name = 'companyMin'
  else if (name.length > LABEL_MAX) out.company_name = 'companyMax'
  if (mode === 'create' && !f.integration_token.trim()) out.integration_token = 'tokenRequired'
  else if (f.integration_token.length > TOKEN_MAX) out.integration_token = 'tokenMax'
  return out
}

/** Campo do erro 422 do servidor (`details.fields[0].path`), ou `null` para erro geral. */
export function pathOf(err: unknown): string | null {
  if (!(err instanceof HttpError)) return null
  const fields = (err.details as { fields?: { path?: string }[] } | undefined)?.fields
  return fields?.[0]?.path ?? null
}

export const hasFormErrors = (e: Record<string, unknown>) => Object.values(e).some(Boolean)

// ---------------------------------------------------------------- cards do hub (19 §2.4, §4.1)

export const PAYMENTS_SOURCE = 'payment-integrations'
export const INVOICES_SOURCE = 'invoice-integrations'
export const UTMIFY_SOURCE = 'utmify-integrations'

export const GATEWAY_INITIALS: Record<string, string> = { xpag: 'XP', zenith: 'ZW' }

export function paymentRecord(p: PaymentIntegrationDto): IntegrationRecord {
  return {
    id: p.id,
    sourceId: PAYMENTS_SOURCE,
    category: 'sales',
    title: p.label,
    provider: p.gateway,
    providerLabel: GATEWAY_LABEL[p.gateway] ?? p.gateway,
    initials: GATEWAY_INITIALS[p.gateway] ?? p.gateway.slice(0, 2).toUpperCase(),
    active: p.secret_configured,
    ...(p.secret_hint ? { detail: p.secret_hint } : {}),
    modalKind: 'payments',
  }
}

export function tokenRecord(kind: TokenKind, r: TokenIntegrationDto): IntegrationRecord {
  const invoice = kind === 'invoice'
  return {
    id: r.id,
    sourceId: invoice ? INVOICES_SOURCE : UTMIFY_SOURCE,
    category: invoice ? 'sales' : 'tracking',
    title: r.company_name,
    provider: invoice ? 'notasy' : 'utmify',
    providerLabel: r.name || (invoice ? 'Notasy' : 'UTMify'),
    initials: invoice ? 'NT' : 'UT',
    active: r.token_configured,
    ...(r.token_hint ? { detail: r.token_hint } : {}),
    modalKind: invoice ? 'invoice' : 'utmify',
  }
}
