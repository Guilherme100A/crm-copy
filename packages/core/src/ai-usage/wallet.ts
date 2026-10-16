// Carteira de créditos de IA por empresa (T18): ledger `ai_wallet_entries` + projeção `ai_wallets`.
// Toda operação é transacional: o UPDATE da projeção trava a linha da empresa, então débitos concorrentes
// serializam e o saldo sempre bate com a soma do ledger (AC-T18-02).
import { eq, sql } from 'drizzle-orm'
import { aiUsage, aiWalletEntries, aiWallets, type Database, type WalletEntryKind, type WalletStatus } from '@crm/db'
import { InvalidCreditsError, UsageNotFoundError } from './errors'

export type Tx = Parameters<Parameters<Database['transaction']>[0]>[0]
type Executor = Database | Tx

export interface WalletSnapshot {
  companyId: string
  balanceCredits: number
  lowThresholdCredits: number
  maxOverrunCredits: number
  status: WalletStatus
  lifetimeCreditedCredits: number
  lifetimeSpentCredits: number
}

export interface WalletOperation {
  entryId: string
  wallet: WalletSnapshot
}

export interface RefundResult {
  /** `false` quando o uso já estava reembolsado (idempotente: nada é creditado). */
  refunded: boolean
  entryId: string | null
  wallet: WalletSnapshot
}

/** exhausted se saldo <= -overrun; senão low se saldo <= limiar; senão ok (AC-T18-03). */
export function walletStatusFor(balance: number, lowThreshold: number, maxOverrun: number): WalletStatus {
  if (balance <= -maxOverrun) return 'exhausted'
  if (balance <= lowThreshold) return 'low'
  return 'ok'
}

function assertCredits(value: number, what: string, allowZero = true): void {
  if (!Number.isSafeInteger(value) || value < 0 || (!allowZero && value === 0))
    throw new InvalidCreditsError(`${what}: créditos devem ser inteiro ${allowZero ? '>= 0' : '> 0'}`)
}

const snapshot = (w: typeof aiWallets.$inferSelect): WalletSnapshot => ({
  companyId: w.companyId,
  balanceCredits: w.balanceCredits,
  lowThresholdCredits: w.lowThresholdCredits,
  maxOverrunCredits: w.maxOverrunCredits,
  status: w.status,
  lifetimeCreditedCredits: w.lifetimeCreditedCredits,
  lifetimeSpentCredits: w.lifetimeSpentCredits,
})

/** Status calculado no SQL a partir do novo saldo e dos limites atuais da linha. */
const statusSql = (newBalance: ReturnType<typeof sql>) =>
  sql`(case when ${newBalance} <= -${aiWallets.maxOverrunCredits} then 'exhausted'
            when ${newBalance} <= ${aiWallets.lowThresholdCredits} then 'low'
            else 'ok' end)::crm.ai_wallet_status`

export interface EntryInput {
  companyId: string
  kind: WalletEntryKind
  /** Com sinal: débito negativo. */
  amount: number
  usageId?: string | null
  requestId?: string | null
  note?: string | null
  actorUserId?: string | null
}

/** Grava a entrada e atualiza a projeção na transação `tx`. */
export async function applyEntry(tx: Executor, input: EntryInput): Promise<WalletOperation> {
  await tx.insert(aiWallets).values({ companyId: input.companyId }).onConflictDoNothing()
  const delta = input.amount
  const credited = input.kind === 'credit' || input.kind === 'adjust' ? delta : 0
  const spent = input.kind === 'debit' ? -delta : input.kind === 'refund' ? -delta : 0
  const newBalance = sql`${aiWallets.balanceCredits} + ${delta}`
  const [wallet] = await tx
    .update(aiWallets)
    .set({
      balanceCredits: sql`${newBalance}`,
      status: statusSql(newBalance),
      lifetimeCreditedCredits: sql`${aiWallets.lifetimeCreditedCredits} + ${credited}`,
      lifetimeSpentCredits: sql`${aiWallets.lifetimeSpentCredits} + ${spent}`,
      updatedAt: sql`now()`,
    })
    .where(eq(aiWallets.companyId, input.companyId))
    .returning()
  const [entry] = await tx
    .insert(aiWalletEntries)
    .values({
      companyId: input.companyId,
      kind: input.kind,
      amountCredits: delta,
      balanceAfterCredits: wallet!.balanceCredits,
      usageId: input.usageId ?? null,
      requestId: input.requestId ?? null,
      note: input.note ?? null,
      actorUserId: input.actorUserId ?? null,
    })
    .returning({ id: aiWalletEntries.id })
  return { entryId: entry!.id, wallet: snapshot(wallet!) }
}

export interface WalletServiceOptions {
  db: Database
}

export class WalletService {
  private readonly db: Database

  constructor(opts: WalletServiceOptions) {
    this.db = opts.db
  }

  /** Carteira atual; sem linha, a carteira vazia (saldo 0, limites 0). */
  async getWallet(companyId: string): Promise<WalletSnapshot> {
    const [w] = await this.db.select().from(aiWallets).where(eq(aiWallets.companyId, companyId)).limit(1)
    if (w) return snapshot(w)
    return {
      companyId,
      balanceCredits: 0,
      lowThresholdCredits: 0,
      maxOverrunCredits: 0,
      status: walletStatusFor(0, 0, 0),
      lifetimeCreditedCredits: 0,
      lifetimeSpentCredits: 0,
    }
  }

  /** Recarga (manual do admin ou compra futura). */
  async credit(companyId: string, credits: number, opts: { note?: string; actorUserId?: string | null } = {}): Promise<WalletOperation> {
    assertCredits(credits, 'credit', false)
    return this.db.transaction((tx) => applyEntry(tx, { companyId, kind: 'credit', amount: credits, ...opts }))
  }

  /** Débito de consumo. O saldo pode ficar negativo; bloquear é papel do UsageGuard (T24). */
  async debit(
    companyId: string,
    credits: number,
    opts: { usageId?: string | null; requestId?: string | null; note?: string } = {},
  ): Promise<WalletOperation> {
    assertCredits(credits, 'debit')
    return this.db.transaction((tx) => applyEntry(tx, { companyId, kind: 'debit', amount: -credits, ...opts }))
  }

  /** Ajuste manual com sinal (correções do admin). */
  async adjust(companyId: string, deltaCredits: number, opts: { note: string; actorUserId?: string | null }): Promise<WalletOperation> {
    if (!Number.isSafeInteger(deltaCredits) || deltaCredits === 0) throw new InvalidCreditsError('adjust: delta deve ser inteiro diferente de 0')
    return this.db.transaction((tx) => applyEntry(tx, { companyId, kind: 'adjust', amount: deltaCredits, ...opts }))
  }

  /** Devolve os créditos de um uso e marca `ai_usage.status = 'refunded'`. Idempotente (AC-T18-04). */
  async refund(usageId: string, opts: { note?: string; actorUserId?: string | null } = {}): Promise<RefundResult> {
    return this.db.transaction(async (tx) => {
      const [usage] = await tx
        .select({ id: aiUsage.id, companyId: aiUsage.companyId, credits: aiUsage.credits, status: aiUsage.status })
        .from(aiUsage)
        .where(eq(aiUsage.id, usageId))
        .for('update')
      if (!usage) throw new UsageNotFoundError(usageId)
      if (usage.status === 'refunded') return { refunded: false, entryId: null, wallet: await this.walletIn(tx, usage.companyId) }
      const op = await applyEntry(tx, { companyId: usage.companyId, kind: 'refund', amount: usage.credits, usageId, ...opts })
      await tx.update(aiUsage).set({ status: 'refunded' }).where(eq(aiUsage.id, usageId))
      return { refunded: true, entryId: op.entryId, wallet: op.wallet }
    })
  }

  /** Limiar de saldo baixo e overrun máximo; recalcula o status. */
  async configure(companyId: string, opts: { lowThresholdCredits?: number; maxOverrunCredits?: number }): Promise<WalletSnapshot> {
    if (opts.lowThresholdCredits !== undefined) assertCredits(opts.lowThresholdCredits, 'lowThresholdCredits')
    if (opts.maxOverrunCredits !== undefined) assertCredits(opts.maxOverrunCredits, 'maxOverrunCredits')
    return this.db.transaction(async (tx) => {
      await tx.insert(aiWallets).values({ companyId }).onConflictDoNothing()
      const [cur] = await tx.select().from(aiWallets).where(eq(aiWallets.companyId, companyId)).for('update')
      const low = opts.lowThresholdCredits ?? cur!.lowThresholdCredits
      const overrun = opts.maxOverrunCredits ?? cur!.maxOverrunCredits
      const [w] = await tx
        .update(aiWallets)
        .set({ lowThresholdCredits: low, maxOverrunCredits: overrun, status: walletStatusFor(cur!.balanceCredits, low, overrun), updatedAt: sql`now()` })
        .where(eq(aiWallets.companyId, companyId))
        .returning()
      return snapshot(w!)
    })
  }

  private async walletIn(tx: Tx, companyId: string): Promise<WalletSnapshot> {
    const [w] = await tx.select().from(aiWallets).where(eq(aiWallets.companyId, companyId)).limit(1)
    return w ? snapshot(w) : this.getWallet(companyId)
  }
}
