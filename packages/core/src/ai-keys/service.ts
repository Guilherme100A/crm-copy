// Chaves de provedores de IA por empresa (T38, BYOK; 07-agentes-ia.md §3.8, 19-integracoes.md §3.3/§5.6).
// O segredo só sai do banco decifrado para `resolveCredentials`/`test`/listagens no provedor; nunca vai para DTO nem log.
// Regra da chave efetiva: entre as chaves ATIVAS do provedor na empresa vale a de `updated_at` mais recente
// (`in_use` no DTO); sem chave da empresa, vale a da plataforma (env `<PROVEDOR>_API_KEY`).
import { randomUUID } from 'node:crypto'
import { and, desc, eq, sql } from 'drizzle-orm'
import { z } from 'zod'
import { AI_KEY_PROVIDERS, aiProviderKeys, flowNodeActions, flowNodes, flows, type AiKeyProvider, type Database } from '@crm/db'
import { getCredentialsCipher, parseEncrypted, serializeEncrypted, type CredentialCipher } from '@crm/node-kit'
import type { LlmProviderId } from '@crm/ai'
import { AiAgentsService } from '../ai-agents/service'
import type { AiProviderKeys } from '../ai-agents/provider-keys'
import { AiKeysError, keyInvalid, keyNotFound, ProviderNotConfiguredError } from './errors'
import { fetchElevenLabsVoices, fetchOpenRouterModels, httpKeyProbe, type AiKeyProbe, type ModelItem, type VoiceItem } from './http'

type Env = Record<string, string | undefined>
type Row = typeof aiProviderKeys.$inferSelect

/** Chave da plataforma por provedor (lida do env a cada chamada). */
export const PLATFORM_AI_KEY_ENV: Readonly<Record<AiKeyProvider, string>> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  google: 'GOOGLE_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
  elevenlabs: 'ELEVENLABS_API_KEY',
  groq: 'GROQ_API_KEY',
}

const nameSchema = z.string().trim().min(2, 'O nome precisa ter ao menos 2 caracteres').max(80, 'O nome pode ter até 80 caracteres')

/** Aceita os nomes do produto de referência (`key_name`, `integration_token`) como apelidos de `name`/`secret`. */
const aliases = (v: unknown) => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return v
  const o = { ...(v as Record<string, unknown>) }
  if (o.name === undefined && o.key_name !== undefined) o.name = o.key_name
  if (o.secret === undefined && o.integration_token !== undefined) o.secret = o.integration_token
  delete o.key_name
  delete o.integration_token
  return o
}

export const aiKeyCreateSchema = z.preprocess(
  aliases,
  z.object({
    provider: z.enum(AI_KEY_PROVIDERS, 'Provedor inválido'),
    name: nameSchema,
    secret: z.string('Informe a chave da API').trim().min(1, 'Informe a chave da API').max(500, 'Chave longa demais'),
    active: z.boolean().optional(),
  }),
)
export type AiKeyCreateInput = z.output<typeof aiKeyCreateSchema>

export const aiKeyUpdateSchema = z.preprocess(
  aliases,
  z.object({
    provider: z.string().optional(),
    name: nameSchema.optional(),
    /** Ausente, vazio ou só espaços: mantém o segredo atual (AC-T38-02). */
    secret: z.string('Chave inválida').max(500, 'Chave longa demais').nullish(),
    active: z.boolean().optional(),
  }),
)
export type AiKeyUpdateInput = z.output<typeof aiKeyUpdateSchema>

export interface AiKeyDto {
  id: string
  provider: AiKeyProvider
  name: string
  configured: true
  /** `…abcd` (últimos 4 caracteres). */
  hint: string
  active: boolean
  /** Esta é a chave que vale hoje para o provedor na empresa (ativa e a mais recente). */
  in_use: boolean
  last_tested_at: string | null
  last_test_ok: boolean | null
  created_at: string
  updated_at: string
}

export interface ResolvedAiCredentials {
  apiKey: string
  source: 'company' | 'platform'
  /** Só quando `source === 'company'`. */
  keyId?: string
}

export interface AiKeyUsage {
  agents: { id: string; name: string }[]
  flows: { id: string; name: string }[]
}

export interface AiKeyTestResult {
  ok: boolean
  latency_ms: number
  error?: string
}

export interface AiKeysServiceOptions {
  db: Database
  /** Default: o cifrador de `CREDENTIALS_KEY` (`@crm/node-kit`). */
  cipher?: Pick<CredentialCipher, 'encrypt' | 'decrypt'>
  /** Env das chaves e URLs da plataforma, lido a cada chamada. Default `process.env`. */
  env?: Env
  /** Teste da chave (fake nos testes). Default: chamada HTTP barata ao provedor. */
  probe?: AiKeyProbe
  /** `fetch` das listagens de modelos/vozes (e do probe padrão). */
  fetch?: typeof globalThis.fetch
  now?: () => Date
}

const ERROR_MAX = 300
const iso = (d: Date | null) => (d ? d.toISOString() : null)

/** Tira toda ocorrência do segredo de um texto (mensagens de erro de provedores). */
export function redactSecret(text: string, secret: string): string {
  let out = text
  if (secret) out = out.split(secret).join('[redacted]')
  return out.length > ERROR_MAX ? `${out.slice(0, ERROR_MAX)}…` : out
}

export class AiKeysService implements AiProviderKeys {
  private readonly db: Database
  private readonly opts: AiKeysServiceOptions

  constructor(opts: AiKeysServiceOptions) {
    this.db = opts.db
    this.opts = opts
  }

  // ---------- leitura ----------

  async list(companyId: string): Promise<AiKeyDto[]> {
    const rows = await this.db
      .select()
      .from(aiProviderKeys)
      .where(eq(aiProviderKeys.companyId, companyId))
      .orderBy(desc(aiProviderKeys.updatedAt), desc(aiProviderKeys.createdAt), desc(aiProviderKeys.id))
    // Ordenado do mais recente: a primeira ativa de cada provedor é a efetiva.
    const effective = new Set<string>()
    const seen = new Set<string>()
    for (const r of rows)
      if (r.active && !seen.has(r.provider)) {
        seen.add(r.provider)
        effective.add(r.id)
      }
    return rows.map((r) => this.toDto(r, effective.has(r.id)))
  }

  async get(companyId: string, id: string): Promise<AiKeyDto> {
    const row = await this.row(companyId, id)
    return this.toDto(row, (await this.effective(companyId, row.provider))?.id === row.id)
  }

  /** Agentes e fluxos que dependem da chave (AC-T38-04). */
  async usage(companyId: string, id: string): Promise<AiKeyUsage> {
    const key = await this.row(companyId, id)
    const agents: AiKeyUsage['agents'] = []
    // Agentes guardam só provedor + modelo: usam a chave efetiva do provedor.
    if ((await this.effective(companyId, key.provider))?.id === key.id) {
      const { items } = await new AiAgentsService({ db: this.db, providerKeys: this }).list(companyId)
      for (const a of items) if (a.resolved_model?.provider === key.provider) agents.push({ id: a.id, name: a.name })
    }
    const flowRows = await this.db
      .selectDistinct({ id: flows.id, name: flows.name })
      .from(flowNodeActions)
      .innerJoin(flowNodes, eq(flowNodes.id, flowNodeActions.nodeId))
      .innerJoin(flows, eq(flows.id, flowNodes.flowId))
      .where(and(eq(flowNodeActions.companyId, companyId), sql`${flowNodeActions.config}->>'ai_integration_id' = ${id}`))
    return { agents, flows: flowRows.map((f) => ({ id: f.id, name: f.name })) }
  }

  // ---------- escrita ----------

  async create(companyId: string, input: unknown, actorUserId: string | null = null): Promise<AiKeyDto> {
    const data = parse(aiKeyCreateSchema, input)
    const id = randomUUID()
    const now = this.now()
    const [row] = await this.db
      .insert(aiProviderKeys)
      .values({
        id,
        companyId,
        provider: data.provider,
        name: data.name,
        secretEnc: this.seal(companyId, id, data.secret),
        secretHint: data.secret.slice(-4),
        active: data.active ?? true,
        createdByUserId: actorUserId,
        createdAt: now,
        updatedAt: now,
      })
      .returning()
    return this.get(companyId, row!.id)
  }

  async update(companyId: string, id: string, input: unknown): Promise<AiKeyDto> {
    const data = parse(aiKeyUpdateSchema, input)
    const row = await this.row(companyId, id)
    if (data.provider !== undefined && data.provider !== row.provider) throw keyInvalid('provider', 'O provedor não pode ser alterado depois de criado')
    const patch: Partial<typeof aiProviderKeys.$inferInsert> = {}
    if (data.name !== undefined) patch.name = data.name
    if (data.active !== undefined) patch.active = data.active
    const secret = data.secret?.trim()
    if (secret) {
      patch.secretEnc = this.seal(companyId, id, secret)
      patch.secretHint = secret.slice(-4)
      // Segredo novo: o último teste não vale mais.
      patch.lastTestedAt = null
      patch.lastTestOk = null
    }
    if (Object.keys(patch).length) {
      patch.updatedAt = this.now()
      await this.db.update(aiProviderKeys).set(patch).where(and(eq(aiProviderKeys.companyId, companyId), eq(aiProviderKeys.id, id)))
    }
    return this.get(companyId, id)
  }

  /** Exclui. Em uso por agente ou fluxo → `conflict` com as referências, a menos que `force` (AC-T38-04). */
  async remove(companyId: string, id: string, opts: { force?: boolean } = {}): Promise<{ deleted: AiKeyDto; usage: AiKeyUsage }> {
    const deleted = await this.get(companyId, id)
    const usage = await this.usage(companyId, id)
    if (!opts.force && (usage.agents.length || usage.flows.length))
      throw new AiKeysError('conflict', 'A chave está em uso; os agentes e blocos de IA que dependem dela vão falhar', { ...usage })
    await this.db.delete(aiProviderKeys).where(and(eq(aiProviderKeys.companyId, companyId), eq(aiProviderKeys.id, id)))
    return { deleted, usage }
  }

  // ---------- provedor ----------

  /** Testa a chave no provedor (AC-T38-03). Nunca lança por falha do provedor: devolve `ok: false` com erro sem a chave. */
  async test(companyId: string, id: string): Promise<AiKeyTestResult> {
    const row = await this.row(companyId, id)
    const secret = this.open(row)
    const probe = this.opts.probe ?? httpKeyProbe({ ...(this.opts.fetch ? { fetch: this.opts.fetch } : {}), env: this.env() })
    const started = performance.now()
    let result: AiKeyTestResult
    try {
      await probe({ provider: row.provider, secret, signal: AbortSignal.timeout(10_000) })
      result = { ok: true, latency_ms: Math.round(performance.now() - started) }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      result = { ok: false, latency_ms: Math.round(performance.now() - started), error: redactSecret(message || 'falha ao testar a chave', secret) }
    }
    // Teste não conta como atualização (não muda qual chave vale).
    await this.db
      .update(aiProviderKeys)
      .set({ lastTestedAt: this.now(), lastTestOk: result.ok })
      .where(and(eq(aiProviderKeys.companyId, companyId), eq(aiProviderKeys.id, id)))
    return result
  }

  /** Modelos da OpenRouter com a chave (AC-T38-06). Outros provedores → `validation` em `provider`. */
  async models(companyId: string, id: string): Promise<ModelItem[]> {
    const row = await this.row(companyId, id)
    if (row.provider !== 'openrouter') throw keyInvalid('provider', 'A lista de modelos só está disponível para chaves OpenRouter')
    return this.upstream(row, (secret) => fetchOpenRouterModels(secret, this.http()))
  }

  /** Vozes da ElevenLabs com a chave. Outros provedores → `validation` em `provider`. */
  async voices(companyId: string, id: string): Promise<VoiceItem[]> {
    const row = await this.row(companyId, id)
    if (row.provider !== 'elevenlabs') throw keyInvalid('provider', 'A lista de vozes só está disponível para chaves ElevenLabs')
    return this.upstream(row, (secret) => fetchElevenLabsVoices(secret, this.http()))
  }

  // ---------- credenciais ----------

  /** Chave efetiva da empresa para o provedor; senão a da plataforma; sem nenhuma → `ProviderNotConfiguredError` (AC-T38-05). */
  async resolveCredentials(companyId: string, provider: AiKeyProvider): Promise<ResolvedAiCredentials> {
    const row = await this.effective(companyId, provider)
    if (row) return { apiKey: this.open(row), source: 'company', keyId: row.id }
    const platform = this.env()[PLATFORM_AI_KEY_ENV[provider]]?.trim()
    if (platform) return { apiKey: platform, source: 'platform' }
    throw new ProviderNotConfiguredError(provider)
  }

  /** Credencial de uma chave específica (blocos de IA de fluxo com `ai_integration_id`). Inexistente ou de outra empresa → `not_found`. */
  async credentialsForKey(companyId: string, keyId: string): Promise<{ apiKey: string; provider: AiKeyProvider; keyId: string }> {
    const row = await this.row(companyId, keyId)
    return { apiKey: this.open(row), provider: row.provider, keyId: row.id }
  }

  /** `AiProviderKeys` da T39: provedor com chave da empresa (ativa) ou da plataforma. */
  async isConfigured(input: { companyId: string; provider: LlmProviderId }): Promise<boolean> {
    if (await this.effective(input.companyId, input.provider)) return true
    return Boolean(this.env()[PLATFORM_AI_KEY_ENV[input.provider]]?.trim())
  }

  // ---------- internos ----------

  private async row(companyId: string, id: string): Promise<Row> {
    if (!z.uuid().safeParse(id).success) throw keyNotFound()
    const [row] = await this.db
      .select()
      .from(aiProviderKeys)
      .where(and(eq(aiProviderKeys.companyId, companyId), eq(aiProviderKeys.id, id)))
      .limit(1)
    if (!row) throw keyNotFound()
    return row
  }

  private async effective(companyId: string, provider: AiKeyProvider): Promise<Row | undefined> {
    const [row] = await this.db
      .select()
      .from(aiProviderKeys)
      .where(and(eq(aiProviderKeys.companyId, companyId), eq(aiProviderKeys.provider, provider), eq(aiProviderKeys.active, true)))
      .orderBy(desc(aiProviderKeys.updatedAt), desc(aiProviderKeys.createdAt), desc(aiProviderKeys.id))
      .limit(1)
    return row
  }

  private async upstream<T>(row: Row, fn: (secret: string) => Promise<T>): Promise<T> {
    const secret = this.open(row)
    try {
      return await fn(secret)
    } catch (err) {
      if (err instanceof AiKeysError) throw new AiKeysError(err.code, redactSecret(err.message, secret), err.details)
      throw new AiKeysError('upstream', `falha ao chamar ${row.provider}`, { provider: row.provider })
    }
  }

  private toDto(r: Row, inUse: boolean): AiKeyDto {
    return {
      id: r.id,
      provider: r.provider,
      name: r.name,
      configured: true,
      hint: `…${r.secretHint}`,
      active: r.active,
      in_use: inUse,
      last_tested_at: iso(r.lastTestedAt),
      last_test_ok: r.lastTestOk,
      created_at: r.createdAt.toISOString(),
      updated_at: r.updatedAt.toISOString(),
    }
  }

  private aad = (companyId: string, id: string) => `ai-key/${companyId}/${id}`
  private cipher = () => this.opts.cipher ?? getCredentialsCipher()
  private seal = (companyId: string, id: string, secret: string) => serializeEncrypted(this.cipher().encrypt(secret, this.aad(companyId, id)))
  private open = (r: Row) => this.cipher().decrypt<string>(parseEncrypted<string>(r.secretEnc), this.aad(r.companyId, r.id))
  private env = (): Env => this.opts.env ?? process.env
  private http = () => ({ ...(this.opts.fetch ? { fetch: this.opts.fetch } : {}), env: this.env() })
  private now = () => this.opts.now?.() ?? new Date()
}

function parse<T extends z.ZodType>(schema: T, input: unknown): z.output<T> {
  const r = schema.safeParse(input ?? {})
  if (!r.success)
    throw new AiKeysError('validation', 'Dados inválidos', { fields: r.error.issues.map((i) => ({ path: i.path.map(String).join('.'), message: i.message })) })
  return r.data
}

