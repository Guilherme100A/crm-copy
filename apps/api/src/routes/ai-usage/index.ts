// Consumo de IA da empresa (SPEC T37; 12 §6.2): carteira, extrato, resumo e cotas. Permissão `ai_usage.view`.
import { Hono } from 'hono'
import { WalletService } from '@crm/core'
import { aiQuotas } from '@crm/db'
import { asc, eq } from 'drizzle-orm'
import { getCompanyCtx } from '../../lib/context'
import type { AppEnv, ResolvedDeps } from '../../lib/types'
import { validate } from '../../lib/validate'
import { requirePerm } from '../../middleware/authorize'
import { listUsage, quotaDto, summaryQuery, usageListQuery, usageSummary, walletDto } from './queries'

export function aiUsageRoutes(deps: ResolvedDeps) {
  const wallets = new WalletService({ db: deps.db })
  const app = new Hono<AppEnv>()
  const view = requirePerm('ai_usage.view')

  app.get('/api/ai/wallet', view, async (c) => {
    const { companyId } = getCompanyCtx(c)
    return c.json({ wallet: walletDto(await wallets.getWallet(companyId)) }, 200)
  })

  app.get('/api/ai/usage', view, validate('query', usageListQuery), async (c) => {
    const { companyId } = getCompanyCtx(c)
    return c.json(await listUsage(deps.db, companyId, c.req.valid('query')), 200)
  })

  app.get('/api/ai/usage/summary', view, validate('query', summaryQuery), async (c) => {
    const { companyId } = getCompanyCtx(c)
    return c.json(await usageSummary(deps.db, companyId, c.req.valid('query')), 200)
  })

  app.get('/api/ai/quotas', view, async (c) => {
    const { companyId } = getCompanyCtx(c)
    const rows = await deps.db.select().from(aiQuotas).where(eq(aiQuotas.companyId, companyId)).orderBy(asc(aiQuotas.period))
    return c.json({ quotas: rows.map(quotaDto) }, 200)
  })

  return app
}
