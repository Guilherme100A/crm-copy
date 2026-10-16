// Ambiente da suíte T24: banco descartável migrado, Redis real (db 1), UsageGuard/meter de `@crm/core`,
// FakeLlm de `@crm/ai/testing` e um espião no lugar do RealtimePublisher. Contrato combinado com o Torno.
import { randomUUID } from 'node:crypto'
import { createDb } from '@crm/db'
import { createTempDatabase, type TempDatabase } from '@crm/db/testing'
import { redisConnection } from '@crm/node-kit'
import { uniqueId } from '../helpers/factories'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

export const PROVIDER = 'openai'
export const TZ = 'America/Sao_Paulo'
// micro-USD por 1M tokens; com markup 1x e 1000 créditos/USD:
// 100k input × $1/M + 50k output × $2/M = $0,20 = 200.000 micros = 200 créditos
export const USAGE = { inputTokens: 100_000, outputTokens: 50_000, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 }
export const USAGE_COST_MICROS = 200_000
export const USAGE_CREDITS = 200

export interface Published {
  companyId: string
  type: string
  data: Any
}

export interface Env {
  tmp: TempDatabase
  db: Any
  redis: Any
  core: Any
  ai: Any
  published: Published[]
  realtime: { publish: (companyId: string, type: string, data: Any, opts?: Any) => Promise<string> }
  guard: Any
  q: (text: string, params?: unknown[]) => Promise<Any[]>
  close: () => Promise<void>
}

export async function startEnv(): Promise<Env> {
  const core: Any = await import('@crm/core')
  const ai: Any = await import('@crm/ai/testing')
  for (const n of ['UsageGuard', 'meter', 'LlmQuotaExceededError', 'WalletService'])
    if (core[n] === undefined) throw new Error(`@crm/core não exporta ${n}`)
  if (typeof ai.FakeLlm !== 'function') throw new Error('@crm/ai/testing não exporta FakeLlm')
  const tmp = await createTempDatabase({ migrate: true })
  const db = createDb(tmp.url)
  const redis = redisConnection({})
  redis.on?.('error', () => {})
  const published: Published[] = []
  const realtime = {
    publish: async (companyId: string, type: string, data: Any) => {
      published.push({ companyId, type, data })
      return `${Date.now()}-0`
    },
  }
  const guard = new core.UsageGuard({ db, redis, realtime })
  const q = async (text: string, params: unknown[] = []) => (await db.$client.query(text, params)).rows
  return {
    tmp,
    db,
    redis,
    core,
    ai,
    published,
    realtime,
    guard,
    q,
    close: async () => {
      await Promise.resolve(redis.quit()).catch(() => redis.disconnect())
      await db.$client.end().catch(() => {})
      await tmp.drop()
    },
  }
}

export interface Company {
  companyId: string
  model: string
}

/** Empresa nova com preço próprio (modelo exclusivo), precificação 1x / 1000 créditos por USD e saldo inicial. */
export async function seedCompany(env: Env, balance = 1_000_000): Promise<Company> {
  const [c] = await env.q(`INSERT INTO crm.companies (name, slug, time_zone) VALUES ($1, $2, $3) RETURNING id`, [uniqueId('Empresa'), uniqueId('slug').toLowerCase(), TZ])
  const model = uniqueId('modelo-t24')
  await env.q(
    `INSERT INTO crm.llm_prices (provider, model, kind, effective_from, input_per_mtok_micros, output_per_mtok_micros) VALUES ($1, $2, 'llm', '2020-01-01T00:00:00Z', 1000000, 2000000)`,
    [PROVIDER, model],
  )
  await env.q(`INSERT INTO crm.ai_pricing_settings (company_id, markup_bps, credits_per_usd, rounding_mode) VALUES ($1, 10000, 1000, 'ceil')`, [c.id])
  const wallet = new env.core.WalletService({ db: env.db })
  if (balance > 0) await wallet.credit(c.id, balance, { note: 'carga T24' })
  return { companyId: c.id, model }
}

export async function setQuota(env: Env, companyId: string, period: 'day' | 'month', maxCredits: number, hard: boolean) {
  await env.q(`INSERT INTO crm.ai_quotas (company_id, period, max_credits, hard) VALUES ($1, $2, $3, $4)`, [companyId, period, maxCredits, hard])
}

/** Consumo real do período via guard.commit (atualiza Redis e Postgres). */
export async function consume(env: Env, c: Company, feature = 'consumo-previo') {
  return env.guard.commit({ requestId: randomUUID(), companyId: c.companyId, provider: PROVIDER, model: c.model, feature, usage: USAGE })
}

/** LlmRequest mínimo para o FakeLlm. */
export function llmRequest(c: Company, agentId: string) {
  return {
    model: { provider: PROVIDER, model: c.model },
    instructions: 'Responda curto.',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'oi' }] }],
    maxOutputTokens: 100,
    tenantId: c.companyId,
    agentId,
  }
}

export async function usageRows(env: Env, companyId: string) {
  return env.q(`SELECT * FROM crm.ai_usage WHERE company_id = $1 ORDER BY created_at`, [companyId])
}

export async function balanceOf(env: Env, companyId: string): Promise<number> {
  const [w] = await env.q(`SELECT balance_credits FROM crm.ai_wallets WHERE company_id = $1`, [companyId])
  return Number(w?.balance_credits ?? 0)
}

export async function debitEntries(env: Env, companyId: string): Promise<number> {
  const [r] = await env.q(`SELECT count(*) AS n FROM crm.ai_wallet_entries WHERE company_id = $1 AND kind = 'debit'`, [companyId])
  return Number(r.n)
}

/** Bucket do contador quente no fuso da empresa: 'YYYY-MM' (mês) ou 'YYYY-MM-DD' (dia). */
export function bucket(period: 'month' | 'day', at = new Date(), tz = TZ): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(at)
  const get = (t: string) => parts.find((p) => p.type === t)!.value
  return period === 'month' ? `${get('year')}-${get('month')}` : `${get('year')}-${get('month')}-${get('day')}`
}

export const hotKey = (companyId: string, period: 'month' | 'day') => `crm:ai:used:${companyId}:${period}:${bucket(period)}`

export async function rejection(p: Promise<unknown>): Promise<unknown> {
  return p.then(
    () => null,
    (e: unknown) => e ?? new Error('rejeição sem valor'),
  )
}
