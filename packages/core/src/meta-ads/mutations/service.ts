// Edição na Meta (T103; 11 §5.3): status, nome e orçamento de campanha/conjunto (status também de anúncio) por
// `POST /{entity_id}` na Graph, com o token do perfil dono da conta (`appsecret_proof` pelo GraphClient).
// - Orçamento chega na moeda da conta ("12,50", 12.5) e vai em centavos (`1250`); campo vazio não é enviado.
// - `name` e orçamento não existem em `level=ad`; `fb_ad_account_id` é obrigatório e precisa ser da empresa.
// - Limite de uso como na T101: conta em espera (`crm:meta:ratelimit:<act>`) ou erro de limite da Graph → não edita
//   agora (`rate_limited` com `retryAt`); o limite também passa a valer para a montagem do bundle.
// - Depois de editar, o cache de 5 min dos bundles da empresa é invalidado (`invalidateCompany`).
import { and, eq } from 'drizzle-orm'
import { metaAdAccounts, type Database } from '@crm/db'
import type { Redis } from 'ioredis'
import { MetaGraphError } from '../client/graph'
import type { MetaProfilesService } from '../profiles/service'
import { DEFAULT_RATE_LIMIT_WAIT_MS, isRateLimitError } from '../structure/account'
import type { MetaBundleService } from '../structure/service'

export const META_ENTITY_LEVELS = ['campaign', 'adset', 'ad'] as const
export type MetaEntityLevel = (typeof META_ENTITY_LEVELS)[number]
export const META_ENTITY_STATUSES = ['ACTIVE', 'PAUSED'] as const
export type MetaEntityStatus = (typeof META_ENTITY_STATUSES)[number]

/** Mensagem do erro da Meta mostrada ao usuário (11 §5.3). */
export const META_UPDATE_FAILED_MESSAGE = 'Não foi possível atualizar na Meta.'

export interface MetaEntityUpdateInput {
  level?: unknown
  fb_ad_account_id?: unknown
  status?: unknown
  name?: unknown
  daily_budget?: unknown
  lifetime_budget?: unknown
}

export interface MetaEntityUpdateResult {
  success: true
  entity: {
    id: string
    level: MetaEntityLevel
    fb_ad_account_id: string
    status?: MetaEntityStatus
    name?: string
    /** Na moeda da conta (como o bundle mostra). */
    daily_budget?: number
    lifetime_budget?: number
  }
  /** O que foi para a Graph (orçamentos em centavos, texto). */
  sent: Record<string, string>
}

export class MetaMutationError extends Error {
  constructor(
    readonly code: 'validation' | 'not_found' | 'upstream' | 'rate_limited',
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message)
    this.name = 'MetaMutationError'
  }
}

export interface MetaMutationsServiceOptions {
  db: Database
  redis: Pick<Redis, 'get' | 'set'>
  profiles: Pick<MetaProfilesService, 'accessToken' | 'graph'>
  bundles?: Pick<MetaBundleService, 'invalidateCompany'>
  /** Prefixo das chaves Redis (o mesmo do bundle). Default `crm:meta`. */
  prefix?: string
  now?: () => Date
}

const ENTITY_ID_RE = /^[A-Za-z0-9_-]{1,64}$/

/** "12,50" → 1250; "1.234,5" → 123450; 12.5 → 1250. Vazio → null (não envia). Inválido/negativo → NaN. */
export function budgetToCents(value: unknown): number | null {
  if (value === null || value === undefined) return null
  if (typeof value === 'number') return Number.isFinite(value) && value >= 0 ? Math.round(value * 100) : Number.NaN
  if (typeof value !== 'string') return Number.NaN
  let s = value.trim().replace(/\s+/g, '')
  if (!s) return null
  if (!/^\d[\d.,]*$/.test(s)) return Number.NaN
  const lastComma = s.lastIndexOf(',')
  const lastDot = s.lastIndexOf('.')
  if (lastComma > -1 && lastDot > -1) {
    const decimal = lastComma > lastDot ? ',' : '.'
    s = s.split(decimal === ',' ? '.' : ',').join('').replace(decimal, '.')
  } else if (lastComma > -1) {
    s = /,\d{1,2}$/.test(s) ? s.replace(',', '.') : s.replace(/,/g, '')
  } else if ((s.match(/\./g) ?? []).length > 1 || /\.\d{3}$/.test(s)) {
    s = s.replace(/\./g, '')
  }
  const n = Number(s)
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) : Number.NaN
}

export class MetaMutationsService {
  private readonly prefix: string

  constructor(private readonly opts: MetaMutationsServiceOptions) {
    this.prefix = opts.prefix ?? 'crm:meta'
  }

  private now() {
    return this.opts.now?.() ?? new Date()
  }

  async update(companyId: string, entityId: string, input: MetaEntityUpdateInput): Promise<MetaEntityUpdateResult> {
    const v = this.validate(entityId, input)
    const [account] = await this.opts.db
      .select({ id: metaAdAccounts.id, profileId: metaAdAccounts.profileId, fbAccountId: metaAdAccounts.fbAccountId })
      .from(metaAdAccounts)
      .where(and(eq(metaAdAccounts.companyId, companyId), eq(metaAdAccounts.fbAccountId, v.fbAccountId)))
      .limit(1)
    if (!account) throw new MetaMutationError('not_found', 'Conta de anúncio não encontrada')

    const rateKey = `${this.prefix}:ratelimit:${account.fbAccountId}`
    const blocked = Number((await this.opts.redis.get(rateKey)) ?? 0)
    if (blocked > this.now().getTime()) throw this.rateLimited(blocked)

    const token = await this.opts.profiles.accessToken(companyId, account.profileId)
    try {
      await this.opts.profiles.graph(token).post(entityId, v.sent)
    } catch (err) {
      if (isRateLimitError(err)) {
        const retryAt = this.now().getTime() + DEFAULT_RATE_LIMIT_WAIT_MS
        await this.opts.redis.set(rateKey, String(retryAt), 'PX', DEFAULT_RATE_LIMIT_WAIT_MS)
        throw this.rateLimited(retryAt)
      }
      if (err instanceof MetaGraphError) {
        throw new MetaMutationError('upstream', META_UPDATE_FAILED_MESSAGE, { meta_message: err.message, meta_code: err.code, fbtrace_id: err.fbtraceId })
      }
      throw err
    }
    await this.opts.bundles?.invalidateCompany(companyId)
    return {
      success: true,
      entity: {
        id: entityId,
        level: v.level,
        fb_ad_account_id: account.fbAccountId,
        ...(v.sent.status ? { status: v.sent.status as MetaEntityStatus } : {}),
        ...(v.sent.name !== undefined ? { name: v.sent.name } : {}),
        ...(v.sent.daily_budget !== undefined ? { daily_budget: Number(v.sent.daily_budget) / 100 } : {}),
        ...(v.sent.lifetime_budget !== undefined ? { lifetime_budget: Number(v.sent.lifetime_budget) / 100 } : {}),
      },
      sent: v.sent,
    }
  }

  private rateLimited(retryAt: number): MetaMutationError {
    return new MetaMutationError('rate_limited', 'Limite da Meta atingido. Tente novamente em alguns minutos.', { retry_at: new Date(retryAt).toISOString() })
  }

  private validate(entityId: string, input: MetaEntityUpdateInput): { level: MetaEntityLevel; fbAccountId: string; sent: Record<string, string> } {
    const fields: { path: string; message: string }[] = []
    const push = (path: string, message: string) => fields.push({ path, message })
    if (!ENTITY_ID_RE.test(entityId)) throw new MetaMutationError('not_found', 'Entidade não encontrada')

    const level = typeof input.level === 'string' && (META_ENTITY_LEVELS as readonly string[]).includes(input.level) ? (input.level as MetaEntityLevel) : null
    if (!level) push('level', 'Nível deve ser campaign, adset ou ad')
    const rawAccount = typeof input.fb_ad_account_id === 'string' || typeof input.fb_ad_account_id === 'number' ? String(input.fb_ad_account_id).trim() : ''
    if (!rawAccount) push('fb_ad_account_id', 'Informe a conta de anúncio')
    const fbAccountId = rawAccount && !rawAccount.startsWith('act_') ? `act_${rawAccount}` : rawAccount

    const sent: Record<string, string> = {}
    if (input.status !== undefined && input.status !== null && input.status !== '') {
      const status = typeof input.status === 'string' ? input.status.trim().toUpperCase() : ''
      if ((META_ENTITY_STATUSES as readonly string[]).includes(status)) sent.status = status
      else push('status', 'Status deve ser ACTIVE ou PAUSED')
    }
    if (input.name !== undefined && input.name !== null) {
      if (level === 'ad') push('name', 'O nome de anúncio não pode ser editado aqui')
      else {
        const name = typeof input.name === 'string' ? input.name.trim() : ''
        // Nome vazio não é enviado (11 §5.3).
        if (name.length > 400) push('name', 'Nome muito longo')
        else if (name) sent.name = name
      }
    }
    for (const key of ['daily_budget', 'lifetime_budget'] as const) {
      const raw = input[key]
      if (raw === undefined || raw === null || raw === '') continue
      if (level === 'ad') {
        push(key, 'Anúncio não tem orçamento')
        continue
      }
      const cents = budgetToCents(raw)
      if (cents === null) continue
      if (Number.isNaN(cents)) push(key, 'Orçamento inválido')
      else sent[key] = String(cents)
    }
    if (!fields.length && Object.keys(sent).length === 0) push('status', 'Nada para atualizar')
    if (fields.length) throw new MetaMutationError('validation', fields[0]!.message, { fields })
    return { level: level!, fbAccountId, sent }
  }
}
