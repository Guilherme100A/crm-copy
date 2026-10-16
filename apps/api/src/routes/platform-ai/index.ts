// Administração de IA pela plataforma (SPEC T37; 12 §5.6, §6.4): recargas, ajustes, reembolsos, cotas e limites da
// carteira de cada empresa, tabela de preços (com histórico de vigências) e conversão custo → créditos.
// Só `platform_admin`. Toda mudança de carteira publica `ai_wallet.updated` na empresa afetada.
import { Hono } from 'hono'
import { z } from 'zod'
import { DEFAULT_PRICING_SETTINGS, InvalidCreditsError, RealtimePublisher, UsageNotFoundError, WalletService, type WalletSnapshot } from '@crm/core'
import { aiPricingSettings, aiQuotas, aiWalletEntries, aiWallets, companies, llmPrices, AI_PRICE_KINDS, QUOTA_PERIODS, ROUNDING_MODES } from '@crm/db'
import { and, asc, desc, eq, isNull, lt } from 'drizzle-orm'
import { getCtx } from '../../lib/context'
import { ApiError } from '../../lib/errors'
import type { AppEnv, ResolvedDeps } from '../../lib/types'
import { validate } from '../../lib/validate'
import { setAudit } from '../../middleware/audit'
import { requirePlatformRole } from '../../middleware/authorize'
import { entryDto, listUsage, priceDto, quotaDto, usageListQuery, UUID_RE, walletDto } from '../ai-usage/queries'

const credits = z.number().int().safe()
const note = z.string().trim().min(1, 'Informe a nota').max(500)
const topupSchema = z.object({ credits: credits.positive('Créditos devem ser > 0'), note })
const adjustmentSchema = z.object({ credits: credits.refine((v) => v !== 0, 'O ajuste não pode ser 0'), note })
const refundSchema = z.object({ note: z.string().trim().max(500).optional() })
const walletPatchSchema = z
  .object({ low_threshold_credits: credits.nonnegative().optional(), max_overrun_credits: credits.nonnegative().optional() })
  .refine((v) => v.low_threshold_credits !== undefined || v.max_overrun_credits !== undefined, 'Informe ao menos um limite')
const micros = z.number().int().safe().nonnegative()
const quotaSchema = z.object({
  period: z.enum(QUOTA_PERIODS),
  max_credits: micros.nullable().optional(),
  max_cost_micros: micros.nullable().optional(),
  max_tokens: micros.nullable().optional(),
  hard: z.boolean().optional(),
})
const quotasPutSchema = z.object({ quotas: z.array(quotaSchema).max(QUOTA_PERIODS.length) }).refine(
  (v) => new Set(v.quotas.map((q) => q.period)).size === v.quotas.length,
  { message: 'Um período por cota', path: ['quotas'] },
)
const priceFields = {
  input_per_mtok_micros: micros.optional(),
  output_per_mtok_micros: micros.optional(),
  cache_read_per_mtok_micros: micros.nullable().optional(),
  cache_write_per_mtok_micros: micros.nullable().optional(),
  reasoning_per_mtok_micros: micros.nullable().optional(),
  unit_price_micros: micros.nullable().optional(),
}
const priceCreateSchema = z.object({
  provider: z.string().trim().min(1).max(100),
  model: z.string().trim().min(1).max(200),
  kind: z.enum(AI_PRICE_KINDS).default('llm'),
  /** Default: agora. Futuro = agendado (não muda o custo de usos já registrados). */
  effective_from: z.iso.datetime({ offset: true }).optional(),
  ...priceFields,
})
const pricePatchSchema = z.object({ effective_from: z.iso.datetime({ offset: true }).optional(), ...priceFields })
const pricesQuery = z.object({ provider: z.string().max(100).optional(), model: z.string().max(200).optional(), kind: z.enum(AI_PRICE_KINDS).optional() })
const settingsQuery = z.object({ company_id: z.string().max(64).optional() })
const settingsPatchSchema = z.object({
  /** Ausente/nulo = configuração global; com id = sobreposição da empresa. */
  company_id: z.string().max(64).nullable().optional(),
  markup_bps: z.number().int().min(0).max(1_000_000).optional(),
  credits_per_usd: z.number().int().min(1).max(100_000_000).optional(),
  rounding_mode: z.enum(ROUNDING_MODES).optional(),
})
const walletsQuery = z.object({ negative: z.enum(['0', '1', 'true', 'false']).optional(), limit: z.coerce.number().int().min(1).max(500).optional() })
const platformUsageQuery = usageListQuery.extend({ company_id: z.string().max(64).optional() })

/** Padrões quando não há configuração global (os do PricingService da T18). */
const DEFAULT_SETTINGS = {
  markup_bps: DEFAULT_PRICING_SETTINGS.markupBps,
  credits_per_usd: DEFAULT_PRICING_SETTINGS.creditsPerUsd,
  rounding_mode: DEFAULT_PRICING_SETTINGS.roundingMode,
}

export function platformAiRoutes(deps: ResolvedDeps) {
  const db = deps.db
  const wallets = new WalletService({ db })
  const publisher = deps.realtimePublisher ?? new RealtimePublisher({ redis: deps.redis, prefix: deps.realtime?.prefix })
  const app = new Hono<AppEnv>()
  app.use('/api/platform/*', requirePlatformRole('platform_admin'))

  const actorId = (c: Parameters<typeof getCtx>[0]) => getCtx(c).user?.id ?? null
  const publishWallet = (companyId: string, w: WalletSnapshot) =>
    publisher
      .publish(companyId, 'ai_wallet.updated', {
        balance_credits: w.balanceCredits,
        status: w.status,
        low_threshold_credits: w.lowThresholdCredits,
        max_overrun_credits: w.maxOverrunCredits,
      })
      .catch((err: unknown) => deps.logger?.warn({ err, company_id: companyId }, 'falha ao publicar ai_wallet.updated'))

  async function company(id: string): Promise<string> {
    if (!UUID_RE.test(id)) throw new ApiError('NOT_FOUND', 'Empresa não encontrada')
    const [row] = await db.select({ id: companies.id }).from(companies).where(eq(companies.id, id)).limit(1)
    if (!row) throw new ApiError('NOT_FOUND', 'Empresa não encontrada')
    return row.id
  }
  async function entry(id: string) {
    const [row] = await db.select().from(aiWalletEntries).where(eq(aiWalletEntries.id, id)).limit(1)
    return row ? entryDto(row) : null
  }
  const creditsError = (err: unknown) => {
    if (err instanceof InvalidCreditsError) throw new ApiError('VALIDATION_ERROR', err.message, { fields: [{ path: 'credits', message: err.message }] })
    throw err
  }

  // ---------------------------------------------------------------- carteira da empresa

  app.post('/api/platform/companies/:id/ai/topups', validate('json', topupSchema), async (c) => {
    const companyId = await company(c.req.param('id'))
    const body = c.req.valid('json')
    const op = await wallets.credit(companyId, body.credits, { note: body.note, actorUserId: actorId(c) }).catch(creditsError)
    await publishWallet(companyId, op.wallet)
    setAudit(c, { action: 'ai.wallet.topup', targetType: 'ai_wallet', targetId: companyId, detail: { company_id: companyId, credits: body.credits } })
    return c.json({ entry: await entry(op.entryId), wallet: walletDto(op.wallet) }, 201)
  })

  app.post('/api/platform/companies/:id/ai/adjustments', validate('json', adjustmentSchema), async (c) => {
    const companyId = await company(c.req.param('id'))
    const body = c.req.valid('json')
    const op = await wallets.adjust(companyId, body.credits, { note: body.note, actorUserId: actorId(c) }).catch(creditsError)
    await publishWallet(companyId, op.wallet)
    setAudit(c, { action: 'ai.wallet.adjust', targetType: 'ai_wallet', targetId: companyId, detail: { company_id: companyId, credits: body.credits } })
    return c.json({ entry: await entry(op.entryId), wallet: walletDto(op.wallet) }, 201)
  })

  app.patch('/api/platform/companies/:id/ai/wallet', validate('json', walletPatchSchema), async (c) => {
    const companyId = await company(c.req.param('id'))
    const body = c.req.valid('json')
    const w = await wallets
      .configure(companyId, {
        ...(body.low_threshold_credits !== undefined ? { lowThresholdCredits: body.low_threshold_credits } : {}),
        ...(body.max_overrun_credits !== undefined ? { maxOverrunCredits: body.max_overrun_credits } : {}),
      })
      .catch(creditsError)
    await publishWallet(companyId, w)
    setAudit(c, { action: 'ai.wallet.configure', targetType: 'ai_wallet', targetId: companyId, detail: { company_id: companyId, ...body } })
    return c.json({ wallet: walletDto(w) }, 200)
  })

  app.post('/api/platform/ai/usage/:id/refund', validate('json', refundSchema), async (c) => {
    const usageId = c.req.param('id')
    if (!UUID_RE.test(usageId)) throw new ApiError('NOT_FOUND', 'Uso não encontrado')
    const body = c.req.valid('json')
    const result = await wallets.refund(usageId, { ...(body.note ? { note: body.note } : {}), actorUserId: actorId(c) }).catch((err: unknown) => {
      if (err instanceof UsageNotFoundError) throw new ApiError('NOT_FOUND', 'Uso não encontrado')
      throw err
    })
    if (result.refunded) await publishWallet(result.wallet.companyId, result.wallet)
    setAudit(c, { action: 'ai.usage.refund', targetType: 'ai_usage', targetId: usageId, detail: { company_id: result.wallet.companyId, refunded: result.refunded } })
    return c.json({ refunded: result.refunded, entry: result.entryId ? await entry(result.entryId) : null, wallet: walletDto(result.wallet) }, 200)
  })

  app.get('/api/platform/ai/wallets', validate('query', walletsQuery), async (c) => {
    const q = c.req.valid('query')
    const negative = q.negative === '1' || q.negative === 'true'
    const rows = await db
      .select({ wallet: aiWallets, name: companies.name })
      .from(aiWallets)
      .innerJoin(companies, eq(companies.id, aiWallets.companyId))
      .where(negative ? lt(aiWallets.balanceCredits, 0) : undefined)
      .orderBy(asc(aiWallets.balanceCredits), asc(companies.name))
      .limit(q.limit ?? 200)
    return c.json(
      {
        items: rows.map((r) => ({
          company_id: r.wallet.companyId,
          company_name: r.name,
          ...walletDto({
            companyId: r.wallet.companyId,
            balanceCredits: r.wallet.balanceCredits,
            lowThresholdCredits: r.wallet.lowThresholdCredits,
            maxOverrunCredits: r.wallet.maxOverrunCredits,
            status: r.wallet.status,
            lifetimeCreditedCredits: r.wallet.lifetimeCreditedCredits,
            lifetimeSpentCredits: r.wallet.lifetimeSpentCredits,
          }),
          updated_at: r.wallet.updatedAt.toISOString(),
        })),
      },
      200,
    )
  })

  // ---------------------------------------------------------------- cotas

  app.get('/api/platform/companies/:id/ai/quotas', async (c) => {
    const companyId = await company(c.req.param('id'))
    const rows = await db.select().from(aiQuotas).where(eq(aiQuotas.companyId, companyId)).orderBy(asc(aiQuotas.period))
    return c.json({ quotas: rows.map(quotaDto) }, 200)
  })

  /** Substitui as cotas da empresa (período ausente = sem cota naquele período). */
  app.put('/api/platform/companies/:id/ai/quotas', validate('json', quotasPutSchema), async (c) => {
    const companyId = await company(c.req.param('id'))
    const { quotas } = c.req.valid('json')
    await db.transaction(async (tx) => {
      await tx.delete(aiQuotas).where(eq(aiQuotas.companyId, companyId))
      if (quotas.length)
        await tx.insert(aiQuotas).values(
          quotas.map((q) => ({
            companyId,
            period: q.period,
            maxCredits: q.max_credits ?? null,
            maxCostMicros: q.max_cost_micros ?? null,
            maxTokens: q.max_tokens ?? null,
            hard: q.hard ?? true,
          })),
        )
    })
    const rows = await db.select().from(aiQuotas).where(eq(aiQuotas.companyId, companyId)).orderBy(asc(aiQuotas.period))
    setAudit(c, { action: 'ai.quotas.update', targetType: 'ai_quotas', targetId: companyId, detail: { company_id: companyId, periods: quotas.map((q) => q.period) } })
    return c.json({ quotas: rows.map(quotaDto) }, 200)
  })

  // ---------------------------------------------------------------- preços

  app.get('/api/platform/ai/prices', validate('query', pricesQuery), async (c) => {
    const q = c.req.valid('query')
    const where = [q.provider ? eq(llmPrices.provider, q.provider) : undefined, q.model ? eq(llmPrices.model, q.model) : undefined, q.kind ? eq(llmPrices.kind, q.kind) : undefined].filter(
      (w): w is NonNullable<typeof w> => w !== undefined,
    )
    const rows = await db
      .select()
      .from(llmPrices)
      .where(where.length ? and(...where) : undefined)
      .orderBy(asc(llmPrices.provider), asc(llmPrices.model), asc(llmPrices.kind), desc(llmPrices.effectiveFrom))
    const now = new Date()
    // Vigente = a mais recente com effective_from <= agora em cada (provider, model, kind).
    const current = new Set<string>()
    const seen = new Set<string>()
    for (const r of rows) {
      const k = `${r.provider}\u0000${r.model}\u0000${r.kind}`
      if (seen.has(k) || r.effectiveFrom.getTime() > now.getTime()) continue
      seen.add(k)
      current.add(r.id)
    }
    return c.json({ items: rows.map((r) => ({ ...priceDto(r, now), current: current.has(r.id) })) }, 200)
  })

  /** Novo preço (nova vigência). Usos já registrados guardam o próprio custo: nunca são recalculados. */
  app.post('/api/platform/ai/prices', validate('json', priceCreateSchema), async (c) => {
    const body = c.req.valid('json')
    const effectiveFrom = body.effective_from ? new Date(body.effective_from) : new Date()
    const [row] = await db
      .insert(llmPrices)
      .values({
        provider: body.provider,
        model: body.model,
        kind: body.kind,
        effectiveFrom,
        inputPerMtokMicros: body.input_per_mtok_micros ?? 0,
        outputPerMtokMicros: body.output_per_mtok_micros ?? 0,
        cacheReadPerMtokMicros: body.cache_read_per_mtok_micros ?? null,
        cacheWritePerMtokMicros: body.cache_write_per_mtok_micros ?? null,
        reasoningPerMtokMicros: body.reasoning_per_mtok_micros ?? null,
        unitPriceMicros: body.unit_price_micros ?? null,
      })
      .onConflictDoNothing()
      .returning()
    if (!row) throw new ApiError('CONFLICT', 'Já existe preço deste modelo com essa vigência', { error_code: 'price_exists' })
    setAudit(c, { action: 'ai.price.create', targetType: 'llm_price', targetId: row.id, detail: { provider: row.provider, model: row.model, kind: row.kind } })
    return c.json({ price: priceDto(row) }, 201)
  })

  /** Só preço ainda não vigente pode ser editado (o histórico de vigências não muda). */
  app.patch('/api/platform/ai/prices/:id', validate('json', pricePatchSchema), async (c) => {
    const id = c.req.param('id')
    if (!UUID_RE.test(id)) throw new ApiError('NOT_FOUND', 'Preço não encontrado')
    const [cur] = await db.select().from(llmPrices).where(eq(llmPrices.id, id)).limit(1)
    if (!cur) throw new ApiError('NOT_FOUND', 'Preço não encontrado')
    const now = new Date()
    if (cur.effectiveFrom.getTime() <= now.getTime())
      throw new ApiError('CONFLICT', 'Preço já vigente não pode ser alterado: cadastre uma nova vigência', { error_code: 'price_in_effect' })
    const body = c.req.valid('json')
    const effectiveFrom = body.effective_from ? new Date(body.effective_from) : undefined
    if (effectiveFrom && effectiveFrom.getTime() <= now.getTime())
      throw new ApiError('VALIDATION_ERROR', 'A vigência editada deve ser futura', { fields: [{ path: 'effective_from', message: 'Use uma data futura' }] })
    const set: Partial<typeof llmPrices.$inferInsert> = {}
    if (effectiveFrom) set.effectiveFrom = effectiveFrom
    if (body.input_per_mtok_micros !== undefined) set.inputPerMtokMicros = body.input_per_mtok_micros
    if (body.output_per_mtok_micros !== undefined) set.outputPerMtokMicros = body.output_per_mtok_micros
    if (body.cache_read_per_mtok_micros !== undefined) set.cacheReadPerMtokMicros = body.cache_read_per_mtok_micros
    if (body.cache_write_per_mtok_micros !== undefined) set.cacheWritePerMtokMicros = body.cache_write_per_mtok_micros
    if (body.reasoning_per_mtok_micros !== undefined) set.reasoningPerMtokMicros = body.reasoning_per_mtok_micros
    if (body.unit_price_micros !== undefined) set.unitPriceMicros = body.unit_price_micros
    const [row] = Object.keys(set).length ? await db.update(llmPrices).set(set).where(eq(llmPrices.id, id)).returning() : [cur]
    setAudit(c, { action: 'ai.price.update', targetType: 'llm_price', targetId: id, detail: { fields: Object.keys(set) } })
    return c.json({ price: priceDto(row!) }, 200)
  })

  // ---------------------------------------------------------------- conversão custo → créditos

  const settingsDto = (r: typeof aiPricingSettings.$inferSelect | undefined, scope: 'global' | 'company', companyId: string | null) => ({
    scope,
    company_id: companyId,
    configured: Boolean(r),
    markup_bps: r?.markupBps ?? DEFAULT_SETTINGS.markup_bps,
    credits_per_usd: r?.creditsPerUsd ?? DEFAULT_SETTINGS.credits_per_usd,
    rounding_mode: r?.roundingMode ?? DEFAULT_SETTINGS.rounding_mode,
    updated_at: r ? r.updatedAt.toISOString() : null,
  })
  const loadSettings = async (companyId: string | null) => {
    const [row] = await db
      .select()
      .from(aiPricingSettings)
      .where(companyId ? eq(aiPricingSettings.companyId, companyId) : isNull(aiPricingSettings.companyId))
      .limit(1)
    return row
  }

  app.get('/api/platform/ai/pricing-settings', validate('query', settingsQuery), async (c) => {
    const q = c.req.valid('query')
    const global = settingsDto(await loadSettings(null), 'global', null)
    if (!q.company_id) return c.json({ settings: global, effective: global }, 200)
    const companyId = await company(q.company_id)
    const own = await loadSettings(companyId)
    const settings = settingsDto(own, 'company', companyId)
    return c.json({ settings, effective: own ? settings : global }, 200)
  })

  app.patch('/api/platform/ai/pricing-settings', validate('json', settingsPatchSchema), async (c) => {
    const body = c.req.valid('json')
    const companyId = body.company_id ? await company(body.company_id) : null
    const cur = await loadSettings(companyId)
    const base = settingsDto(cur, companyId ? 'company' : 'global', companyId)
    const values = {
      markupBps: body.markup_bps ?? base.markup_bps,
      creditsPerUsd: body.credits_per_usd ?? base.credits_per_usd,
      roundingMode: body.rounding_mode ?? base.rounding_mode,
      updatedAt: new Date(),
    }
    if (cur) await db.update(aiPricingSettings).set(values).where(eq(aiPricingSettings.id, cur.id))
    else await db.insert(aiPricingSettings).values({ companyId, ...values })
    const settings = settingsDto(await loadSettings(companyId), companyId ? 'company' : 'global', companyId)
    setAudit(c, { action: 'ai.pricing_settings.update', targetType: 'ai_pricing_settings', targetId: companyId ?? 'global', detail: { company_id: companyId } })
    return c.json({ settings }, 200)
  })

  // ---------------------------------------------------------------- uso de todas as empresas

  app.get('/api/platform/ai/usage', validate('query', platformUsageQuery), async (c) => {
    const { company_id, ...q } = c.req.valid('query')
    const companyId = company_id ? await company(company_id) : null
    return c.json(await listUsage(db, companyId, q), 200)
  })

  return app
}

