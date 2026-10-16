// Ambiente da suíte T18: banco descartável migrado + serviços públicos de `@crm/core` (contrato combinado com o Torno).
//  - PricingService({ db }).costOf(usage, at, { companyId? }) → { costMicros, billedMicros, credits, ... }
//  - WalletService({ db }): credit/debit/refund/adjust/configure/getWallet
//  - AiUsageService({ db }).record({...}) → { usage: { id, credits, status }, created }
//  - PriceNotFoundError, NoopBillingProvider, BillingNotConfiguredError
import { createDb } from '@crm/db'
import { createTempDatabase, type TempDatabase } from '@crm/db/testing'
import { uniqueId } from '../helpers/factories'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

export interface Env {
  tmp: TempDatabase
  db: Any
  core: Any
  q: (text: string, params?: unknown[]) => Promise<Any[]>
  close: () => Promise<void>
}

export async function startEnv(): Promise<Env> {
  const core: Any = await import('@crm/core')
  for (const n of ['PricingService', 'WalletService', 'AiUsageService', 'PriceNotFoundError', 'NoopBillingProvider', 'BillingNotConfiguredError'])
    if (core[n] === undefined) throw new Error(`@crm/core não exporta ${n}`)
  const tmp = await createTempDatabase({ migrate: true })
  const db = createDb(tmp.url)
  const q = async (text: string, params: unknown[] = []) => (await db.$client.query(text, params)).rows
  return {
    tmp,
    db,
    core,
    q,
    close: async () => {
      await db.$client.end().catch(() => {})
      await tmp.drop()
    },
  }
}

export async function seedCompany(env: Env): Promise<string> {
  const [row] = await env.q(`INSERT INTO crm.companies (name, slug) VALUES ($1, $2) RETURNING id`, [uniqueId('Empresa'), uniqueId('slug').toLowerCase()])
  return row.id
}

export interface PriceRow {
  provider: string
  model: string
  effectiveFrom: string
  input: number
  output: number
  cacheRead?: number | null
  cacheWrite?: number | null
  reasoning?: number | null
}

/** Preços em micro-USD por 1M tokens, numa linha por vigência. */
export async function insertPrice(env: Env, p: PriceRow) {
  await env.q(
    `INSERT INTO crm.llm_prices (provider, model, kind, effective_from, input_per_mtok_micros, output_per_mtok_micros,
       cache_read_per_mtok_micros, cache_write_per_mtok_micros, reasoning_per_mtok_micros)
     VALUES ($1, $2, 'llm', $3, $4, $5, $6, $7, $8)`,
    [p.provider, p.model, p.effectiveFrom, p.input, p.output, p.cacheRead ?? null, p.cacheWrite ?? null, p.reasoning ?? null],
  )
}

/** Configuração de precificação da empresa (markup em bps; 10000 = 1x). */
export async function setPricing(env: Env, companyId: string, markupBps: number, creditsPerUsd: number, rounding: 'ceil' | 'floor' | 'round') {
  await env.q(`INSERT INTO crm.ai_pricing_settings (company_id, markup_bps, credits_per_usd, rounding_mode) VALUES ($1, $2, $3, $4)`, [
    companyId,
    markupBps,
    creditsPerUsd,
    rounding,
  ])
}

export const num = (v: unknown) => Number(v)

/** Soma do ledger e saldo projetado da empresa, lidos do banco. */
export async function ledgerVsBalance(env: Env, companyId: string) {
  const [s] = await env.q(`SELECT coalesce(sum(amount_credits), 0) AS total, count(*) AS n FROM crm.ai_wallet_entries WHERE company_id = $1`, [companyId])
  const [w] = await env.q(`SELECT balance_credits, status FROM crm.ai_wallets WHERE company_id = $1`, [companyId])
  return { ledger: num(s.total), entries: num(s.n), balance: w ? num(w.balance_credits) : null, status: w?.status as string | undefined }
}
