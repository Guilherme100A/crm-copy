// AC-T18-02..04 — WalletService (ledger transacional, status por limiar/overrun) e refund idempotente de ai_usage.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { uniqueId } from '../helpers/factories'
import { type Env, insertPrice, ledgerVsBalance, num, seedCompany, setPricing, startEnv } from './setup'

let env: Env
let wallet: any

beforeAll(async () => {
  env = await startEnv()
  wallet = new env.core.WalletService({ db: env.db })
})
afterAll(async () => {
  await env?.close()
})

const statusOf = async (companyId: string) => {
  const w = await wallet.getWallet(companyId)
  const db = await ledgerVsBalance(env, companyId)
  expect(db.status, 'status no banco difere do getWallet').toBe(w.status)
  return { status: w.status as string, balance: num(w.balanceCredits) }
}

describe('T18 — ledger sob concorrência', () => {
  it('AC-T18-02 após 100 débitos concorrentes, balance_credits = soma de ai_wallet_entries', async () => {
    const company = await seedCompany(env)
    await wallet.credit(company, 1_000_000, { note: 'carga inicial' })
    const amounts = Array.from({ length: 100 }, (_, i) => 1 + ((i * 37) % 250))
    const results = await Promise.allSettled(amounts.map((a, i) => wallet.debit(company, a, { requestId: `t18-req-${company}-${i}` })))
    const failed = results.filter((r) => r.status === 'rejected')
    expect(failed, `débitos falharam: ${failed.map((f) => String((f as PromiseRejectedResult).reason)).slice(0, 3).join(' | ')}`).toHaveLength(0)

    const { ledger, entries, balance } = await ledgerVsBalance(env, company)
    expect(entries).toBe(101)
    expect(balance).toBe(ledger)
    expect(balance).toBe(1_000_000 - amounts.reduce((s, a) => s + a, 0))
    const w = await wallet.getWallet(company)
    expect(num(w.balanceCredits)).toBe(balance)
    expect(num(w.lifetimeSpentCredits)).toBe(amounts.reduce((s, a) => s + a, 0))
  })

  it('AC-T18-02 créditos e débitos concorrentes misturados mantêm saldo = ledger', async () => {
    const company = await seedCompany(env)
    const ops = Array.from({ length: 100 }, (_, i) => (i % 3 === 0 ? wallet.credit(company, 50) : wallet.debit(company, 20)))
    await Promise.all(ops)
    const { ledger, balance } = await ledgerVsBalance(env, company)
    expect(balance).toBe(ledger)
    expect(balance).toBe(34 * 50 - 66 * 20)
  })

  it('AC-T18-02 débitos de empresas diferentes não se misturam', async () => {
    const a = await seedCompany(env)
    const b = await seedCompany(env)
    await Promise.all([...Array.from({ length: 30 }, () => wallet.debit(a, 3)), ...Array.from({ length: 30 }, () => wallet.debit(b, 5))])
    expect((await ledgerVsBalance(env, a)).balance).toBe(-90)
    expect((await ledgerVsBalance(env, b)).balance).toBe(-150)
  })
})

describe('T18 — status da carteira', () => {
  it('AC-T18-03 cruzar o limiar → low; saldo ≤ -max_overrun → exhausted; recarga → ok', async () => {
    const company = await seedCompany(env)
    await wallet.configure(company, { lowThresholdCredits: 100, maxOverrunCredits: 50 })
    await wallet.credit(company, 500)
    expect(await statusOf(company)).toEqual({ status: 'ok', balance: 500 })

    await wallet.debit(company, 399)
    expect((await statusOf(company)).status).toBe('ok') // 101 > limiar
    await wallet.debit(company, 1)
    expect(await statusOf(company)).toEqual({ status: 'low', balance: 100 }) // = limiar

    await wallet.debit(company, 149)
    expect(await statusOf(company)).toEqual({ status: 'low', balance: -49 }) // overrun ainda permitido
    await wallet.debit(company, 1)
    expect(await statusOf(company)).toEqual({ status: 'exhausted', balance: -50 }) // = -max_overrun

    await wallet.credit(company, 1_000)
    expect(await statusOf(company)).toEqual({ status: 'ok', balance: 950 })
  })

  it('AC-T18-03 débito que salta direto para além do overrun → exhausted; recarga parcial abaixo do limiar → low', async () => {
    const company = await seedCompany(env)
    await wallet.configure(company, { lowThresholdCredits: 20, maxOverrunCredits: 10 })
    await wallet.credit(company, 30)
    await wallet.debit(company, 100)
    expect(await statusOf(company)).toEqual({ status: 'exhausted', balance: -70 })
    await wallet.credit(company, 80)
    expect(await statusOf(company)).toEqual({ status: 'low', balance: 10 })
    await wallet.credit(company, 11)
    expect(await statusOf(company)).toEqual({ status: 'ok', balance: 21 })
  })

  it('AC-T18-03 adjust negativo também recalcula o status', async () => {
    const company = await seedCompany(env)
    await wallet.configure(company, { lowThresholdCredits: 10, maxOverrunCredits: 0 })
    await wallet.credit(company, 100)
    await wallet.adjust(company, -100, { note: 'ajuste manual' })
    expect(await statusOf(company)).toEqual({ status: 'exhausted', balance: 0 })
    await wallet.adjust(company, 50, { note: 'ajuste manual' })
    expect(await statusOf(company)).toEqual({ status: 'ok', balance: 50 })
  })
})

describe('T18 — refund de uso', () => {
  let provider: string
  let model: string

  beforeAll(async () => {
    provider = 'anthropic'
    model = uniqueId('modelo-refund')
    await insertPrice(env, { provider, model, effectiveFrom: '2026-01-01T00:00:00Z', input: 3_000_000, output: 15_000_000 })
  })

  async function recordUsage(company: string) {
    await setPricing(env, company, 10_000, 1_000, 'ceil')
    const svc = new env.core.AiUsageService({ db: env.db })
    const r = await svc.record({
      companyId: company,
      requestId: uniqueId('req'),
      provider,
      model,
      usage: { inputTokens: 1_000_000, outputTokens: 1_000_000 }, // 18 USD → 18.000 créditos
      at: new Date('2026-09-01T00:00:00Z'),
    })
    return r.usage
  }

  it('AC-T18-04 refund(usageId) credita os créditos do uso e marca ai_usage.status = refunded', async () => {
    const company = await seedCompany(env)
    await wallet.credit(company, 50_000)
    const usage = await recordUsage(company)
    expect(num(usage.credits)).toBe(18_000)
    expect((await ledgerVsBalance(env, company)).balance).toBe(32_000)

    const r = await wallet.refund(usage.id, { note: 'falha do provedor' })
    expect(r.refunded).toBe(true)
    const [row] = await env.q(`SELECT status FROM crm.ai_usage WHERE id = $1`, [usage.id])
    expect(row.status).toBe('refunded')
    const after = await ledgerVsBalance(env, company)
    expect(after.balance).toBe(50_000)
    expect(after.balance).toBe(after.ledger)
  })

  it('AC-T18-04 segunda chamada de refund não credita de novo', async () => {
    const company = await seedCompany(env)
    await wallet.credit(company, 50_000)
    const usage = await recordUsage(company)
    await wallet.refund(usage.id)
    const once = await ledgerVsBalance(env, company)

    const second = await wallet.refund(usage.id).then(
      (v: any) => v,
      (e: unknown) => ({ error: e }),
    )
    expect(second?.refunded ?? false, 'segundo refund não pode reportar crédito').toBe(false)
    const twice = await ledgerVsBalance(env, company)
    expect(twice.balance).toBe(once.balance)
    expect(twice.entries).toBe(once.entries)
    const refunds = await env.q(`SELECT count(*) AS n FROM crm.ai_wallet_entries WHERE company_id = $1 AND kind = 'refund'`, [company])
    expect(num(refunds[0].n)).toBe(1)
  })

  it('AC-T18-04 refunds concorrentes do mesmo uso creditam uma única vez', async () => {
    const company = await seedCompany(env)
    await wallet.credit(company, 50_000)
    const usage = await recordUsage(company)
    await Promise.allSettled(Array.from({ length: 10 }, () => wallet.refund(usage.id)))
    const { balance, ledger } = await ledgerVsBalance(env, company)
    expect(balance).toBe(50_000)
    expect(balance).toBe(ledger)
    const [row] = await env.q(`SELECT status FROM crm.ai_usage WHERE id = $1`, [usage.id])
    expect(row.status).toBe('refunded')
  })
})
