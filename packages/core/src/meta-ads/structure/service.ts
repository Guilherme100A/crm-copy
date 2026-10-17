// Bundle do Gerenciador Meta (T101; 11 §3.5, §4.4, §5.2, §7): para as contas efetivas (incluídas no dashboard ∩
// filtro), junta estrutura + insights dos 3 níveis por conta, num job (`meta-sync`) ou na hora. Estado e cache no
// Redis: pronto por 5 min; o último pronto fica 24 h para o caso de limite da Meta (devolvido com aviso). Progresso
// por SSE `meta.bundle.progress` (`loading|refreshing → partial → ready`). Limite de uso por conta: adia, não falha.
import { randomBytes } from 'node:crypto'
import { and, asc, eq, inArray } from 'drizzle-orm'
import { companies, metaAdAccounts, type Database } from '@crm/db'
import type { Redis } from 'ioredis'
import type { MetaProfilesService } from '../profiles/service'
import type { SalesJoin } from '../sales-join/service'
import { fetchAccountRows, MetaRateLimitedError, type BundleAccount, type BundleRow } from './account'
import { fxRatesFromEnv, type FxRate } from './metrics'
import { bundleKey, normalizeBundleParams, type BundleParams, type RawBundleQuery } from './params'

export const META_SYNC_QUEUE = 'meta-sync'
export const BUNDLE_CACHE_TTL_S = 5 * 60
/** T103: validade da geração do cache da empresa (bem acima do TTL do bundle). */
export const BUNDLE_GEN_TTL_S = 24 * 3600
export const BUNDLE_LAST_TTL_S = 24 * 3600
export const BUNDLE_STATE_TTL_S = 15 * 60
/** T129: bundle pronto com erro de conta (fora do cache de 5 min) fica no estado por este tempo; depois, job novo. */
export const BUNDLE_ERROR_TTL_S = 60
export const DEFAULT_DISPLAY_CURRENCY = 'BRL'

export type BundleStatus = 'loading' | 'partial' | 'refreshing' | 'ready'

export interface BundleEnvelope {
  bundle_key: string
  status: BundleStatus
  campaign: BundleRow[]
  adset: BundleRow[]
  ad: BundleRow[]
  targets_done: number
  targets_total: number
  errors: { ad_account_id: string; fb_ad_account_id: string; error: string }[]
  display_currency: string
  since: string
  until: string
  status_filter: string
  /** `rate_limited` (devolvido do cache por limite da Meta), `fx_rate_missing:<FROM>-><TO>`, `no_ad_accounts`. */
  warnings: string[]
  /** Veio do cache (não chamou a Meta). */
  cached: boolean
  generated_at: string | null
}

export interface MetaSyncJobData {
  companyId: string
  bundleKey: string
  params: BundleParams
  accountIds: string[]
  force: boolean
}

export interface BundlePublisher {
  publish(companyId: string, type: 'meta.bundle.progress', data: Record<string, unknown>): Promise<unknown>
}

export interface MetaBundleServiceOptions {
  db: Database
  redis: Pick<Redis, 'get' | 'set' | 'del'>
  profiles: Pick<MetaProfilesService, 'accessToken' | 'graph'>
  publisher?: BundlePublisher
  /** Enfileira o job `meta-sync` (sem ele, `async` monta na hora). */
  enqueue?: (data: MetaSyncJobData, opts: { jobId: string }) => Promise<void>
  fx?: FxRate
  /** Prefixo das chaves Redis. Default `crm:meta`. */
  prefix?: string
  now?: () => Date
  logger?: { warn(obj: object, msg?: string): void }
  /** T105: vendas internas × anúncios; preenche `purchases_leona`/`purchase_value_leona` das linhas (sem ela, null). */
  internalSales?: SalesJoin
}

export interface BundleRequest extends RawBundleQuery {
  force_refresh?: boolean
  async?: boolean
}

export class MetaBundleError extends Error {
  constructor(
    readonly code: 'validation' | 'not_found',
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message)
    this.name = 'MetaBundleError'
  }
}

function withRateLimited(env: BundleEnvelope): BundleEnvelope {
  return { ...env, cached: true, warnings: [...new Set([...env.warnings, 'rate_limited'])] }
}

interface AccountRow extends BundleAccount {
  profileId: string
}

export class MetaBundleService {
  private readonly db: Database
  private readonly redis: MetaBundleServiceOptions['redis']
  private readonly prefix: string
  private readonly fx: FxRate
  private readonly now: () => Date

  constructor(private readonly opts: MetaBundleServiceOptions) {
    this.db = opts.db
    this.redis = opts.redis
    this.prefix = opts.prefix ?? 'crm:meta'
    this.fx = opts.fx ?? fxRatesFromEnv()
    this.now = opts.now ?? (() => new Date())
  }

  // ---------------------------------------------------------------- chaves

  private k(kind: 'bundle' | 'last' | 'state', key: string) {
    return `${this.prefix}:${kind}:${key}`
  }
  private rateKey(fbAccountId: string) {
    return `${this.prefix}:ratelimit:${fbAccountId}`
  }
  /**
   * T103: chave do cache de 5 min com a geração da empresa. `invalidateCompany` troca a geração e todos os bundles
   * prontos da empresa (qualquer filtro) deixam de ser achados. Sem geração (nunca invalidada), a chave é a da T101.
   */
  private async bundleCacheKey(companyId: string, key: string): Promise<string> {
    const gen = await this.redis.get(`${this.prefix}:gen:${companyId}`)
    return gen ? `${this.k('bundle', key)}:g${gen}` : this.k('bundle', key)
  }

  /** T103: invalida o cache de 5 min de TODOS os bundles da empresa (ex.: depois de editar na Meta). */
  async invalidateCompany(companyId: string): Promise<void> {
    await this.redis.set(`${this.prefix}:gen:${companyId}`, `${this.now().getTime().toString(36)}${randomBytes(3).toString('hex')}`, 'EX', BUNDLE_GEN_TTL_S)
  }

  // ---------------------------------------------------------------- leitura (API)

  /**
   * Bundle da empresa. Cache pronto (5 min) responde sem chamar a Meta, salvo `force_refresh`. Com `async`, devolve o
   * estado em andamento (ou enfileira o job e devolve `loading`/`refreshing`); sem `async`, monta na hora.
   * Se alguma conta está em limite de uso, devolve o último bundle pronto com `warnings: ['rate_limited']`.
   */
  async getBundle(companyId: string, req: BundleRequest): Promise<BundleEnvelope> {
    const params = await this.params(companyId, req)
    const accounts = await this.accounts(companyId, params.adAccountIds)
    const key = bundleKey(companyId, params, accounts.map((a) => a.id))
    if (accounts.length === 0) return { ...this.empty(key, params, 'ready', 0), warnings: ['no_ad_accounts'] }

    if (!req.force_refresh) {
      const cached = await this.read(await this.bundleCacheKey(companyId, key))
      // T129 retrabalho: no async, cache com conta em limite (ex.: o refresh forçado caiu no limite) leva o aviso.
      if (cached && req.async && (await this.blockedUntil(accounts)) > this.now().getTime()) return withRateLimited(cached)
      if (cached) return { ...cached, cached: true }
      if (req.async) {
        const state = await this.read(this.k('state', key))
        if (state) return state
      }
    }

    // Limite de uso ativo numa das contas: não chama a Meta agora; agenda (async) e devolve o último pronto.
    const blockedUntil = await this.blockedUntil(accounts)
    if (blockedUntil > this.now().getTime()) {
      // Mesma janela de limite = mesmo job (dedupe); force_refresh gera um novo.
      if (req.async && this.opts.enqueue) {
        const force = req.force_refresh ?? false
        await this.enqueue(companyId, key, params, accounts, force, force ? undefined : `bundle-${key}-rl-${blockedUntil}`)
      }
      return this.rateLimitedFallback(key, params, accounts.length)
    }

    if (req.async && this.opts.enqueue) {
      const state = this.empty(key, params, req.force_refresh ? 'refreshing' : 'loading', accounts.length)
      if (req.force_refresh) await this.save('state', key, state, BUNDLE_STATE_TTL_S)
      // T129: o estado é a trava de concorrência (SET NX): quem não grava não enfileira e devolve o estado do outro.
      else if (!(await this.claimState(key, state))) return (await this.read(this.k('state', key))) ?? state
      await this.publish(companyId, state)
      await this.enqueue(companyId, key, params, accounts, req.force_refresh ?? false)
      return state
    }
    try {
      return await this.build(companyId, key, params, accounts)
    } catch (err) {
      if (err instanceof MetaRateLimitedError) return this.rateLimitedFallback(key, params, accounts.length)
      throw err
    }
  }

  /**
   * Job `meta-sync`: monta e publica. Limite de uso → `MetaRateLimitedError` (o worker adia o job até `retryAt`).
   * T129 retrabalho: antes de lançar, grava no estado (até `retryAt`) e publica o mesmo fallback do sync (último pronto
   * com `rate_limited`, ou `ready` vazio com o aviso), para o GET async e o SSE saírem de `loading`/`refreshing`.
   */
  async runJob(data: MetaSyncJobData): Promise<BundleEnvelope> {
    const accounts = await this.accounts(data.companyId, data.accountIds)
    try {
      const blockedUntil = await this.blockedUntil(accounts)
      if (blockedUntil > this.now().getTime()) throw new MetaRateLimitedError(blockedUntil, 'conta em espera de limite de uso')
      return await this.build(data.companyId, data.bundleKey, data.params, accounts)
    } catch (err) {
      if (err instanceof MetaRateLimitedError) {
        const env = await this.rateLimitedFallback(data.bundleKey, data.params, accounts.length)
        const ttl = Math.min(BUNDLE_STATE_TTL_S, Math.max(1, Math.ceil((err.retryAt - this.now().getTime()) / 1000)))
        await this.save('state', data.bundleKey, env, ttl)
        await this.publish(data.companyId, env)
      }
      throw err
    }
  }

  // ---------------------------------------------------------------- gasto (dashboard)

  /**
   * Gasto Meta do período (contas incluídas no dashboard), na moeda de exibição; cache de 5 min. Conta com erro fica
   * em `errors` e fora do total.
   */
  async metaSpend(
    companyId: string,
    period: { since: string; until: string },
    opts: { adAccountIds?: string[]; displayCurrency?: string } = {},
  ): Promise<{ total: number; display_currency: string; by_account: { ad_account_id: string; fb_ad_account_id: string; currency: string | null; spend: number; spend_display: number | null }[]; errors: BundleEnvelope['errors']; warnings: string[] }> {
    const accounts = await this.accounts(companyId, [...new Set(opts.adAccountIds ?? [])].sort())
    const display = (opts.displayCurrency ?? DEFAULT_DISPLAY_CURRENCY).toUpperCase()
    const cacheKey = `${this.prefix}:spend:${bundleKey(companyId, { statusFilter: 'all', since: period.since, until: period.until, displayCurrency: display }, accounts.map((a) => a.id))}`
    const hit = await this.redis.get(cacheKey)
    if (hit) return JSON.parse(hit) as Awaited<ReturnType<MetaBundleService['metaSpend']>>
    const result: Awaited<ReturnType<MetaBundleService['metaSpend']>> = { total: 0, display_currency: display, by_account: [], errors: [], warnings: [] }
    for (const a of accounts) {
      try {
        const graph = this.opts.profiles.graph(await this.opts.profiles.accessToken(companyId, a.profileId))
        const rows = await graph.getAll<{ spend?: string }>(`${a.fbAccountId}/insights`, {
          level: 'account',
          fields: 'spend',
          time_range: JSON.stringify({ since: period.since, until: period.until }),
        })
        const spend = Math.round(rows.reduce((s, r) => s + (Number(r.spend) || 0), 0) * 100) / 100
        const rate = a.currency ? this.fx(a.currency, display) : 1
        const spendDisplay = rate === null ? null : Math.round(spend * rate * 100) / 100
        if (spendDisplay === null) result.warnings.push(`fx_rate_missing:${a.currency}->${display}`)
        else result.total = Math.round((result.total + spendDisplay) * 100) / 100
        result.by_account.push({ ad_account_id: a.id, fb_ad_account_id: a.fbAccountId, currency: a.currency, spend, spend_display: spendDisplay })
      } catch (err) {
        result.errors.push({ ad_account_id: a.id, fb_ad_account_id: a.fbAccountId, error: err instanceof Error ? err.message : String(err) })
      }
    }
    if (result.errors.length === 0) await this.redis.set(cacheKey, JSON.stringify(result), 'EX', BUNDLE_CACHE_TTL_S)
    return result
  }

  /** Limpa o cache dos bundles da empresa (ex.: conta incluída/excluída do dashboard). Não há índice: expira em 5 min. */
  async invalidate(companyId: string, req: BundleRequest): Promise<void> {
    const params = await this.params(companyId, req)
    const accounts = await this.accounts(companyId, params.adAccountIds)
    const key = bundleKey(companyId, params, accounts.map((a) => a.id))
    await this.redis.del(this.k('bundle', key))
    await this.redis.del(await this.bundleCacheKey(companyId, key))
  }

  // ---------------------------------------------------------------- montagem

  private async build(companyId: string, key: string, params: BundleParams, accounts: AccountRow[]): Promise<BundleEnvelope> {
    // T103: geração lida no início — uma edição durante a montagem não deixa este bundle (anterior a ela) no cache novo.
    const cacheKey = await this.bundleCacheKey(companyId, key)
    const env = this.empty(key, params, 'loading', accounts.length)
    const fxMissing = new Set<string>()
    for (const [i, a] of accounts.entries()) {
      try {
        const graph = this.opts.profiles.graph(await this.opts.profiles.accessToken(companyId, a.profileId))
        const rows = await fetchAccountRows(graph, a, { since: params.since, until: params.until, statusFilter: params.statusFilter, displayCurrency: params.displayCurrency, fx: this.fx, now: () => this.now().getTime() })
        env.campaign.push(...rows.campaign)
        env.adset.push(...rows.adset)
        env.ad.push(...rows.ad)
        if (rows.fxMissing && a.currency) fxMissing.add(`fx_rate_missing:${a.currency}->${params.displayCurrency}`)
      } catch (err) {
        if (err instanceof MetaRateLimitedError) {
          // A conta fica em espera; o job inteiro é adiado (não conta como falha).
          await this.redis.set(this.rateKey(a.fbAccountId), String(err.retryAt), 'PX', Math.max(1000, err.retryAt - this.now().getTime()))
          throw err
        }
        env.errors.push({ ad_account_id: a.id, fb_ad_account_id: a.fbAccountId, error: err instanceof Error ? err.message : String(err) })
      }
      env.targets_done = i + 1
      if (i + 1 < accounts.length) {
        env.status = 'partial'
        await this.save('state', key, env, BUNDLE_STATE_TTL_S)
        await this.publish(companyId, env)
      }
    }
    // T105: vendas internas por `source_id`; falha no cruzamento não derruba o bundle (aviso `internal_sales_failed`).
    if (this.opts.internalSales) {
      try {
        const joined = await this.opts.internalSales.apply(companyId, { since: params.since, until: params.until, displayCurrency: params.displayCurrency }, env)
        for (const w of joined.warnings) fxMissing.add(w)
      } catch (err) {
        fxMissing.add('internal_sales_failed')
        this.opts.logger?.warn({ err, company_id: companyId }, 'falha ao cruzar vendas internas com anúncios')
      }
    }
    env.status = 'ready'
    env.warnings = [...fxMissing]
    env.generated_at = this.now().toISOString()
    // Só bundle sem erro vai para o cache de 5 min; o "último pronto" guarda sempre (fallback de limite).
    if (env.errors.length === 0) await this.redis.set(cacheKey, JSON.stringify({ ...env, cached: false }), 'EX', BUNDLE_CACHE_TTL_S)
    await this.save('last', key, env, BUNDLE_LAST_TTL_S)
    // T129: com erro, o pronto fica no estado por pouco tempo (o GET async seguinte sai de `loading` sem novo job e
    // sem reler em laço); ao expirar, o próximo GET enfileira um job novo.
    if (env.errors.length === 0) await this.redis.del(this.k('state', key))
    else await this.save('state', key, env, BUNDLE_ERROR_TTL_S)
    await this.publish(companyId, env)
    return env
  }

  private async rateLimitedFallback(key: string, params: BundleParams, total: number): Promise<BundleEnvelope> {
    const last = await this.read(this.k('last', key))
    if (last) return withRateLimited(last)
    // T129 retrabalho: sem último pronto, `ready` vazio com o aviso (não `loading`): nada está sendo montado agora.
    return { ...this.empty(key, params, 'ready', total), warnings: ['rate_limited'] }
  }

  /**
   * T129: jobId único por geração. O fixo `bundle-<key>` colidia com o job concluído que o BullMQ retém (24 h): o
   * `add` era ignorado e o estado ficava em `loading`. A dedupe de concorrência é a trava do estado (`claimState`).
   */
  private async enqueue(companyId: string, key: string, params: BundleParams, accounts: AccountRow[], force: boolean, jobId?: string): Promise<void> {
    const id = jobId ?? `bundle-${key}-${this.now().getTime().toString(36)}${randomBytes(3).toString('hex')}`
    await this.opts.enqueue!({ companyId, bundleKey: key, params, accountIds: accounts.map((a) => a.id), force }, { jobId: id })
  }

  private async claimState(key: string, state: BundleEnvelope): Promise<boolean> {
    return (await this.redis.set(this.k('state', key), JSON.stringify({ ...state, cached: false }), 'EX', BUNDLE_STATE_TTL_S, 'NX')) === 'OK'
  }

  private async blockedUntil(accounts: AccountRow[]): Promise<number> {
    let max = 0
    for (const a of accounts) max = Math.max(max, Number(await this.redis.get(this.rateKey(a.fbAccountId))) || 0)
    return max
  }

  private async publish(companyId: string, env: BundleEnvelope): Promise<void> {
    if (!this.opts.publisher) return
    try {
      await this.opts.publisher.publish(companyId, 'meta.bundle.progress', {
        bundle_key: env.bundle_key,
        status: env.status,
        targets_done: env.targets_done,
        targets_total: env.targets_total,
        errors: env.errors,
        warnings: env.warnings,
        display_currency: env.display_currency,
        since: env.since,
        until: env.until,
        status_filter: env.status_filter,
        counts: { campaign: env.campaign.length, adset: env.adset.length, ad: env.ad.length },
      })
    } catch (err) {
      this.opts.logger?.warn({ err, company_id: companyId }, 'falha ao publicar meta.bundle.progress')
    }
  }

  private async params(companyId: string, req: BundleRequest): Promise<BundleParams> {
    const [company] = await this.db.select({ tz: companies.timeZone }).from(companies).where(eq(companies.id, companyId)).limit(1)
    try {
      return normalizeBundleParams(req, { now: this.now(), timeZone: company?.tz ?? 'America/Sao_Paulo', defaultCurrency: DEFAULT_DISPLAY_CURRENCY })
    } catch (err) {
      const e = err as { field?: string; message: string }
      throw new MetaBundleError('validation', e.message, { fields: [{ path: e.field ?? 'query', message: e.message }] })
    }
  }

  /** Contas efetivas: incluídas no dashboard ∩ filtro (ids locais); ordenadas. */
  private async accounts(companyId: string, filter: string[]): Promise<AccountRow[]> {
    const where = [eq(metaAdAccounts.companyId, companyId), eq(metaAdAccounts.includedInDashboard, true)]
    const uuids = filter.filter((id) => /^[0-9a-f-]{36}$/i.test(id))
    if (filter.length) where.push(uuids.length ? inArray(metaAdAccounts.id, uuids) : eq(metaAdAccounts.id, '00000000-0000-0000-0000-000000000000'))
    const rows = await this.db
      .select({ id: metaAdAccounts.id, fbAccountId: metaAdAccounts.fbAccountId, name: metaAdAccounts.name, currency: metaAdAccounts.currency, profileId: metaAdAccounts.profileId })
      .from(metaAdAccounts)
      .where(and(...where))
      .orderBy(asc(metaAdAccounts.id))
    return rows
  }

  private empty(key: string, p: BundleParams, status: BundleStatus, total: number): BundleEnvelope {
    return {
      bundle_key: key,
      status,
      campaign: [],
      adset: [],
      ad: [],
      targets_done: 0,
      targets_total: total,
      errors: [],
      display_currency: p.displayCurrency,
      since: p.since,
      until: p.until,
      status_filter: p.statusFilter,
      warnings: [],
      cached: false,
      generated_at: null,
    }
  }

  private async read(key: string): Promise<BundleEnvelope | null> {
    const raw = await this.redis.get(key)
    return raw ? (JSON.parse(raw) as BundleEnvelope) : null
  }

  private async save(kind: 'bundle' | 'last' | 'state', key: string, env: BundleEnvelope, ttl: number): Promise<void> {
    await this.redis.set(this.k(kind, key), JSON.stringify({ ...env, cached: false }), 'EX', ttl)
  }
}
