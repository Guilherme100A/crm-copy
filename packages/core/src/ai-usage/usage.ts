// Registro de uso de IA (T18): precifica, grava `ai_usage` (único por `request_id`) e debita a carteira
// na mesma transação. Reentregar o mesmo `request_id` não debita de novo.
import { eq } from 'drizzle-orm'
import { aiUsage, type AiPriceKind, type AiUsageStatus, type Database } from '@crm/db'
import { PricingService, type UsageToPrice } from './pricing'
import { applyEntry, type WalletSnapshot } from './wallet'

export interface RecordUsageInput {
  companyId: string
  /** Chave de idempotência da chamada (ex.: id da execução + passo). */
  requestId: string
  provider: string
  model: string
  kind?: AiPriceKind
  usage: Omit<UsageToPrice, 'provider' | 'model' | 'kind'>
  at?: Date
  source?: string | null
  sourceId?: string | null
  actorUserId?: string | null
}

export interface RecordedUsage {
  id: string
  companyId: string
  requestId: string
  credits: number
  costMicros: number
  billedMicros: number
  status: AiUsageStatus
}

export interface RecordUsageResult {
  usage: RecordedUsage
  /** `false` quando o `request_id` já existia (nada foi debitado de novo). */
  created: boolean
  wallet: WalletSnapshot | null
}

export interface AiUsageServiceOptions {
  db: Database
  pricing?: PricingService
}

const recorded = {
  id: aiUsage.id,
  companyId: aiUsage.companyId,
  requestId: aiUsage.requestId,
  credits: aiUsage.credits,
  costMicros: aiUsage.costMicros,
  billedMicros: aiUsage.billedMicros,
  status: aiUsage.status,
}

export class AiUsageService {
  private readonly db: Database
  private readonly pricing: PricingService

  constructor(opts: AiUsageServiceOptions) {
    this.db = opts.db
    this.pricing = opts.pricing ?? new PricingService({ db: opts.db })
  }

  async record(input: RecordUsageInput): Promise<RecordUsageResult> {
    const existing = await this.find(input.requestId)
    if (existing) return { usage: existing, created: false, wallet: null }

    const kind = input.kind ?? 'llm'
    const at = input.at ?? new Date()
    const cost = await this.pricing.costOf({ ...input.usage, provider: input.provider, model: input.model, kind }, at, { companyId: input.companyId })
    const u = input.usage
    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .insert(aiUsage)
        .values({
          companyId: input.companyId,
          requestId: input.requestId,
          provider: input.provider,
          model: input.model,
          kind,
          inputTokens: u.inputTokens ?? 0,
          outputTokens: u.outputTokens ?? 0,
          cacheReadTokens: u.cacheReadTokens ?? 0,
          cacheWriteTokens: u.cacheWriteTokens ?? 0,
          reasoningTokens: u.reasoningTokens ?? 0,
          units: kind === 'tts' ? (u.characters ?? 0) : kind === 'stt' ? (u.seconds ?? 0) : null,
          costMicros: cost.costMicros,
          billedMicros: cost.billedMicros,
          credits: cost.credits,
          priceId: cost.priceId,
          source: input.source ?? null,
          sourceId: input.sourceId ?? null,
          actorUserId: input.actorUserId ?? null,
          createdAt: at,
        })
        .onConflictDoNothing({ target: aiUsage.requestId })
        .returning(recorded)
      if (!row) {
        // Corrida com outra entrega do mesmo request_id: ela debitou.
        const [other] = await tx.select(recorded).from(aiUsage).where(eq(aiUsage.requestId, input.requestId)).limit(1)
        return { usage: other!, created: false, wallet: null }
      }
      const op = await applyEntry(tx, { companyId: input.companyId, kind: 'debit', amount: -row.credits, usageId: row.id, requestId: input.requestId })
      return { usage: row, created: true, wallet: op.wallet }
    })
  }

  async find(requestId: string): Promise<RecordedUsage | null> {
    const [row] = await this.db.select(recorded).from(aiUsage).where(eq(aiUsage.requestId, requestId)).limit(1)
    return row ?? null
  }
}
