// Perfis Meta e contas de anúncio (T99; 11 §2.3, §3.1–3.2, §5.1): conectar por OAuth (code → token curto → token
// longo → `/me` → contas), listar sem o token, atualizar a lista de contas (upsert que preserva
// `included_in_dashboard`), marcar conta no dashboard e remover o perfil. O token longo só existe cifrado.
import { randomUUID } from 'node:crypto'
import { and, asc, eq, inArray, sql } from 'drizzle-orm'
import { metaAdAccounts, metaProfiles, type Database } from '@crm/db'
import { getCredentialsCipher, parseEncrypted, serializeEncrypted, type CredentialCipher } from '@crm/node-kit'
import { GraphClient, MetaGraphError } from '../client/graph'
import { defaultOAuthStateKey, oauthDialogUrl, signOAuthState, verifyOAuthState, type MetaConfig } from './oauth'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export const META_AD_ACCOUNT_FIELDS = 'id,account_id,name,currency,account_status'

export type MetaProfilesErrorCode = 'not_found' | 'invalid_state' | 'not_configured' | 'upstream' | 'token_invalid'

export class MetaProfilesError extends Error {
  constructor(
    readonly code: MetaProfilesErrorCode,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message)
    this.name = 'MetaProfilesError'
  }
}

export interface MetaAdAccountDto {
  id: string
  profile_id: string
  fb_account_id: string
  account_id: string
  name: string | null
  currency: string | null
  account_status: number | null
  included_in_dashboard: boolean
  updated_at: string
}

export interface MetaProfileDto {
  id: string
  fb_user_id: string
  fb_user_name: string | null
  picture_url: string | null
  active: boolean
  token_expires_at: string | null
  connected_by_user_id: string | null
  ad_accounts: MetaAdAccountDto[]
  ad_accounts_count: number
  ad_accounts_included_count: number
  created_at: string
  updated_at: string
}

type ProfileRow = typeof metaProfiles.$inferSelect
type AccountRow = typeof metaAdAccounts.$inferSelect

export interface MetaProfilesServiceOptions {
  db: Database
  config: MetaConfig
  /** Default: o cifrador de `CREDENTIALS_KEY`. */
  cipher?: Pick<CredentialCipher, 'encrypt' | 'decrypt'>
  fetch?: typeof globalThis.fetch
  /** Chave do `state` do OAuth. Default `defaultOAuthStateKey()`. */
  stateKey?: Buffer
  now?: () => Date
}

const tokenAad = (profileId: string) => `meta_profile/${profileId}/token`

const accountDto = (r: AccountRow): MetaAdAccountDto => ({
  id: r.id,
  profile_id: r.profileId,
  fb_account_id: r.fbAccountId,
  account_id: r.fbAccountId.replace(/^act_/, ''),
  name: r.name,
  currency: r.currency,
  account_status: r.accountStatus,
  included_in_dashboard: r.includedInDashboard,
  updated_at: r.updatedAt.toISOString(),
})

/** DTO do perfil: nunca inclui o token (AC-T99-04). */
function profileDto(p: ProfileRow, accounts: AccountRow[]): MetaProfileDto {
  const list = accounts.map(accountDto)
  return {
    id: p.id,
    fb_user_id: p.fbUserId,
    fb_user_name: p.fbUserName,
    picture_url: p.pictureUrl,
    active: p.active,
    token_expires_at: p.tokenExpiresAt ? p.tokenExpiresAt.toISOString() : null,
    connected_by_user_id: p.connectedByUserId,
    ad_accounts: list,
    ad_accounts_count: list.length,
    ad_accounts_included_count: list.filter((a) => a.included_in_dashboard).length,
    created_at: p.createdAt.toISOString(),
    updated_at: p.updatedAt.toISOString(),
  }
}

interface GraphAdAccount {
  id: string
  account_id?: string
  name?: string
  currency?: string
  account_status?: number
}

export class MetaProfilesService {
  private readonly db: Database
  private readonly config: MetaConfig
  private readonly now: () => Date

  constructor(private readonly opts: MetaProfilesServiceOptions) {
    this.db = opts.db
    this.config = opts.config
    this.now = opts.now ?? (() => new Date())
  }

  /** Cliente da Graph com o app configurado (`appsecret_proof` em toda chamada). */
  graph(accessToken?: string): GraphClient {
    this.assertConfigured()
    return new GraphClient({
      graphUrl: this.config.graphUrl,
      version: this.config.version,
      appSecret: this.config.appSecret,
      ...(accessToken ? { accessToken } : {}),
      ...(this.opts.fetch ? { fetch: this.opts.fetch } : {}),
    })
  }

  // ---------------------------------------------------------------- OAuth

  /** URL do Facebook Login com `state` assinado (empresa + usuário + perfil a reconectar). */
  async startOAuth(input: { companyId: string; userId: string; profileId?: string | null }): Promise<{ oauth_url: string; state: string }> {
    this.assertConfigured()
    if (input.profileId) await this.profileRow(input.companyId, input.profileId)
    const state = signOAuthState(this.stateKey(), { companyId: input.companyId, userId: input.userId, profileId: input.profileId ?? null }, this.now().getTime())
    return { oauth_url: oauthDialogUrl(this.config, state), state }
  }

  /**
   * Callback: confere o `state` (assinatura, validade, MESMA empresa e usuário da sessão), troca o `code` pelo token
   * longo, grava o perfil (upsert por usuário Meta) e busca as contas. Qualquer falha → `MetaProfilesError` e nada
   * é criado.
   */
  async completeOAuth(input: { companyId: string; userId: string; code: string | null | undefined; state: string | null | undefined }): Promise<MetaProfileDto> {
    const state = verifyOAuthState(this.stateKey(), input.state, this.now().getTime())
    if (!state || state.companyId !== input.companyId || state.userId !== input.userId) throw new MetaProfilesError('invalid_state', 'state inválido, expirado ou de outra empresa/usuário')
    if (!input.code) throw new MetaProfilesError('invalid_state', 'code ausente')
    const graph = this.graph()
    const token = await this.upstream(async () => {
      const short = await graph.get<{ access_token: string }>(
        'oauth/access_token',
        { client_id: this.config.appId, client_secret: this.config.appSecret, redirect_uri: this.config.redirectUri, code: input.code },
        { accessToken: null },
      )
      return graph.get<{ access_token: string; expires_in?: number }>(
        'oauth/access_token',
        { grant_type: 'fb_exchange_token', client_id: this.config.appId, client_secret: this.config.appSecret, fb_exchange_token: short.access_token },
        { accessToken: null },
      )
    })
    const me = await this.upstream(() => graph.get<{ id: string; name?: string; picture?: { data?: { url?: string } } }>('me', { fields: 'id,name,picture{url}' }, { accessToken: token.access_token }))
    const expiresAt = token.expires_in ? new Date(this.now().getTime() + token.expires_in * 1000) : null
    const profile = await this.upsertProfile(input.companyId, input.userId, me, token.access_token, expiresAt)
    await this.syncAccounts(profile, token.access_token)
    return this.get(input.companyId, profile.id)
  }

  // ---------------------------------------------------------------- perfis

  async list(companyId: string): Promise<MetaProfileDto[]> {
    const profiles = await this.db.select().from(metaProfiles).where(eq(metaProfiles.companyId, companyId)).orderBy(asc(metaProfiles.createdAt))
    if (!profiles.length) return []
    const accounts = await this.db
      .select()
      .from(metaAdAccounts)
      .where(and(eq(metaAdAccounts.companyId, companyId), inArray(metaAdAccounts.profileId, profiles.map((p) => p.id))))
      .orderBy(asc(metaAdAccounts.name), asc(metaAdAccounts.fbAccountId))
    return profiles.map((p) => profileDto(p, accounts.filter((a) => a.profileId === p.id)))
  }

  async get(companyId: string, id: string): Promise<MetaProfileDto> {
    const p = await this.profileRow(companyId, id)
    const accounts = await this.db.select().from(metaAdAccounts).where(eq(metaAdAccounts.profileId, p.id)).orderBy(asc(metaAdAccounts.name), asc(metaAdAccounts.fbAccountId))
    return profileDto(p, accounts)
  }

  /** Remove o perfil e as contas dele (cascata). */
  async remove(companyId: string, id: string): Promise<void> {
    const p = await this.profileRow(companyId, id)
    await this.db.delete(metaProfiles).where(eq(metaProfiles.id, p.id))
  }

  /** Busca as contas na Meta e faz upsert sem mexer em `included_in_dashboard` das existentes (AC-T99-03). */
  async refreshAdAccounts(companyId: string, id: string): Promise<MetaProfileDto> {
    const p = await this.profileRow(companyId, id)
    await this.syncAccounts(p, this.token(p))
    return this.get(companyId, id)
  }

  async setIncluded(companyId: string, adAccountId: string, included: boolean): Promise<MetaAdAccountDto> {
    if (!UUID_RE.test(adAccountId)) throw new MetaProfilesError('not_found', 'Conta de anúncio não encontrada')
    const [row] = await this.db
      .update(metaAdAccounts)
      .set({ includedInDashboard: included, updatedAt: this.now() })
      .where(and(eq(metaAdAccounts.companyId, companyId), eq(metaAdAccounts.id, adAccountId)))
      .returning()
    if (!row) throw new MetaProfilesError('not_found', 'Conta de anúncio não encontrada')
    return accountDto(row)
  }

  /** Token decifrado de um perfil (uso interno de outros módulos Meta, ex.: T101). */
  async accessToken(companyId: string, profileId: string): Promise<string> {
    return this.token(await this.profileRow(companyId, profileId))
  }

  // ---------------------------------------------------------------- internos

  private assertConfigured(): void {
    if (!this.config.appId || !this.config.appSecret) throw new MetaProfilesError('not_configured', 'Integração Meta não configurada (META_APP_ID/META_APP_SECRET)')
  }

  private stateKey(): Buffer {
    return this.opts.stateKey ?? defaultOAuthStateKey()
  }

  private cipher(): Pick<CredentialCipher, 'encrypt' | 'decrypt'> {
    return this.opts.cipher ?? getCredentialsCipher()
  }

  private token(p: ProfileRow): string {
    return this.cipher().decrypt<string>(parseEncrypted<string>(p.accessTokenEnc), tokenAad(p.id))
  }

  private async profileRow(companyId: string, id: string): Promise<ProfileRow> {
    if (!UUID_RE.test(id)) throw new MetaProfilesError('not_found', 'Perfil Meta não encontrado')
    const [p] = await this.db.select().from(metaProfiles).where(and(eq(metaProfiles.companyId, companyId), eq(metaProfiles.id, id))).limit(1)
    if (!p) throw new MetaProfilesError('not_found', 'Perfil Meta não encontrado')
    return p
  }

  private async upsertProfile(
    companyId: string,
    userId: string,
    me: { id: string; name?: string; picture?: { data?: { url?: string } } },
    accessToken: string,
    expiresAt: Date | null,
  ): Promise<ProfileRow> {
    const [existing] = await this.db.select().from(metaProfiles).where(and(eq(metaProfiles.companyId, companyId), eq(metaProfiles.fbUserId, me.id))).limit(1)
    const id = existing?.id ?? randomUUID()
    const values = {
      fbUserName: me.name ?? null,
      pictureUrl: me.picture?.data?.url ?? null,
      accessTokenEnc: serializeEncrypted(this.cipher().encrypt(accessToken, tokenAad(id))),
      tokenExpiresAt: expiresAt,
      active: true,
      connectedByUserId: userId,
      updatedAt: this.now(),
    }
    if (existing) {
      const [row] = await this.db.update(metaProfiles).set(values).where(eq(metaProfiles.id, id)).returning()
      return row!
    }
    const [row] = await this.db.insert(metaProfiles).values({ id, companyId, fbUserId: me.id, ...values }).returning()
    return row!
  }

  private async syncAccounts(p: ProfileRow, accessToken: string): Promise<void> {
    const accounts = await this.upstream(
      () => this.graph(accessToken).getAll<GraphAdAccount>('me/adaccounts', { fields: META_AD_ACCOUNT_FIELDS, limit: 100 }),
      p,
    )
    const now = this.now()
    for (const a of accounts) {
      if (!a?.id) continue
      const fbAccountId = a.id.startsWith('act_') ? a.id : `act_${a.account_id ?? a.id}`
      await this.db
        .insert(metaAdAccounts)
        .values({ companyId: p.companyId, profileId: p.id, fbAccountId, name: a.name ?? null, currency: a.currency ?? null, accountStatus: a.account_status ?? null })
        .onConflictDoUpdate({
          target: [metaAdAccounts.profileId, metaAdAccounts.fbAccountId],
          // `included_in_dashboard` fica como está (escolha da empresa).
          set: { name: a.name ?? null, currency: a.currency ?? null, accountStatus: a.account_status ?? null, updatedAt: now },
        })
    }
    await this.db.update(metaProfiles).set({ updatedAt: sql`now()` }).where(eq(metaProfiles.id, p.id))
  }

  /** Erros da Graph → domínio; token inválido desativa o perfil (precisa reconectar). */
  private async upstream<T>(fn: () => Promise<T>, profile?: ProfileRow): Promise<T> {
    try {
      return await fn()
    } catch (err) {
      if (!(err instanceof MetaGraphError)) throw err
      if (err.isTokenError) {
        if (profile) await this.db.update(metaProfiles).set({ active: false, updatedAt: this.now() }).where(eq(metaProfiles.id, profile.id))
        throw new MetaProfilesError('token_invalid', 'Token da Meta inválido ou expirado: reconecte o perfil', { graph_code: err.code, fbtrace_id: err.fbtraceId })
      }
      throw new MetaProfilesError('upstream', `Falha na Graph da Meta: ${err.message}`, { graph_code: err.code, status: err.status, fbtrace_id: err.fbtraceId })
    }
  }
}
