// Agentes de IA (T39; 07-agentes-ia.md §3–§6): CRUD, publicar/pausar, duplicar, exclusão com referências,
// avatar e mídias enviáveis, limite opcional por empresa e modelo por agente (explícito ou preset da empresa).
import { and, asc, count, desc, eq, inArray, sql } from 'drizzle-orm'
import { z } from 'zod'
import { LLM_PROVIDERS, type LlmProviderId } from '@crm/ai'
import {
  AI_AGENT_GOALS,
  AI_AGENT_PERSONALITIES,
  aiAgentMedia,
  aiAgents,
  aiAgentSettings,
  aiAgentSkills,
  aiCollectionFields,
  chats,
  companies,
  flowNodeActions,
  flowNodes,
  flows,
  platformSettings,
  type AiAgentModelRef,
  type AiAgentStatus,
  type Database,
} from '@crm/db'
import type { BlobStore } from '@crm/node-kit'
import { AVATAR_MAX_BYTES, detectImageMime, isAvatarMime } from '../auth/image'
import { agentInvalid, agentNotFound, AiAgentsError } from './errors'
import { envProviderKeys, type AiProviderKeys } from './provider-keys'
import {
  agentSettingsSchema,
  agentSkillSchema,
  collectionFieldSchema,
  DEFAULT_COLLECTION_FIELDS,
  type AgentSettings,
  type AgentSkillInput,
  type AiEngine,
  type CollectionFieldInput,
} from './settings'

export const AGENT_MEDIA_MAX_FILES = 8
export const AGENT_MEDIA_MAX_BYTES = 8 * 1024 * 1024
const MEDIA_MIME_RE = /^(image|video|audio)\/[\w.+-]+$|^application\/pdf$/
export const AVATAR_KEYS = Array.from({ length: 10 }, (_, i) => `leo-${i + 1}`)
export const ACTIVE_CHAT_STATUSES = ['waiting', 'attending'] as const
export const PRESETS_SETTING_KEY = 'ai_presets'

export const modelRefSchema = z.object({ provider: z.enum(LLM_PROVIDERS), model: z.string().trim().min(1).max(200) })

/** Corpo de criação/edição (todos opcionais). `settings` é mesclado e validado inteiro no serviço. */
export const agentWriteSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  role: z.string().max(200).optional(),
  avatar_key: z.enum(AVATAR_KEYS as [string, ...string[]]).optional(),
  primary_goal: z.enum(AI_AGENT_GOALS).optional(),
  personality: z.enum(AI_AGENT_PERSONALITIES).optional(),
  purpose: z.string().max(5000).optional(),
  audience: z.string().max(5000).optional(),
  example_messages: z.string().max(5000).optional(),
  business_rules: z.string().max(10000).optional(),
  never_talk_about: z.string().max(5000).optional(),
  use_emojis: z.boolean().optional(),
  generated_prompt: z.string().max(50000).optional(),
  prompt_edited: z.boolean().optional(),
  model: modelRefSchema.nullable().optional(),
  settings: z.record(z.string(), z.unknown()).optional(),
  skills: z.array(agentSkillSchema).max(50).optional(),
  collection_fields: z.array(collectionFieldSchema).max(30).optional(),
})
export type AgentWriteInput = z.input<typeof agentWriteSchema>

type AgentRow = typeof aiAgents.$inferSelect

export interface AgentDto {
  id: string
  name: string
  role: string
  avatar_key: string
  avatar_url: string | null
  status: AiAgentStatus
  primary_goal: string
  purpose: string
  audience: string
  personality: string
  example_messages: string
  business_rules: string
  never_talk_about: string
  use_emojis: boolean
  generated_prompt: string
  last_generated_prompt: string
  prompt_edited: boolean
  locked_blocks: unknown[]
  model: AiAgentModelRef | null
  resolved_model: AiAgentModelRef | null
  settings: AgentSettings
  skills: (AgentSkillInput & { id: string; position: number })[]
  collection_fields: (CollectionFieldInput & { id: string; position: number; variable: string })[]
  media: { id: string; title: string; filename: string | null; mime: string; size: number; url: string; created_at: string }[]
  skills_count: number
  created_at: string
  updated_at: string
}

export interface AgentReferences {
  flows: { id: string; name: string }[]
  chats: { id: string }[]
}

export interface AiAgentsServiceOptions {
  db: Database
  blobStore?: BlobStore
  providerKeys?: AiProviderKeys
}

type Tx = Parameters<Parameters<Database['transaction']>[0]>[0]
type Exec = Database | Tx

const iso = (d: Date) => d.toISOString()

function zodFields(err: z.ZodError, prefix: string) {
  return err.issues.map((i) => ({ path: [prefix, ...i.path.map(String)].filter(Boolean).join('.'), message: i.message }))
}

export class AiAgentsService {
  private readonly db: Database
  private readonly blobStore?: BlobStore
  private readonly providerKeys: AiProviderKeys

  constructor(opts: AiAgentsServiceOptions) {
    this.db = opts.db
    this.blobStore = opts.blobStore
    this.providerKeys = opts.providerKeys ?? envProviderKeys()
  }

  // ---------- leitura ----------

  async list(companyId: string, opts: { status?: AiAgentStatus } = {}): Promise<{ items: AgentDto[]; quota: { used: number; limit: number | null } }> {
    const rows = await this.db
      .select()
      .from(aiAgents)
      .where(and(eq(aiAgents.companyId, companyId), opts.status ? eq(aiAgents.status, opts.status) : undefined))
      .orderBy(desc(aiAgents.createdAt), asc(aiAgents.id))
    const items = await Promise.all(rows.map((r) => this.toDto(r)))
    const used = await this.countAgents(this.db, companyId)
    return { items, quota: { used, limit: await this.agentLimit(this.db, companyId) } }
  }

  async get(companyId: string, id: string): Promise<AgentDto> {
    return this.toDto(await this.row(this.db, companyId, id))
  }

  /** Modelo efetivo: explícito, senão o preset `settings.engine` da empresa e depois da plataforma. */
  async resolveModel(companyId: string, model: AiAgentModelRef | null, engine: AiEngine): Promise<AiAgentModelRef | null> {
    if (model) return model
    const pick = (v: unknown): AiAgentModelRef | null => {
      const r = modelRefSchema.safeParse((v as Record<string, unknown> | null | undefined)?.[engine])
      return r.success ? r.data : null
    }
    const [co] = await this.db.select({ settings: companies.settings }).from(companies).where(eq(companies.id, companyId)).limit(1)
    const own = pick((co?.settings as Record<string, unknown> | undefined)?.[PRESETS_SETTING_KEY])
    if (own) return own
    const [ps] = await this.db.select({ value: platformSettings.value }).from(platformSettings).where(eq(platformSettings.key, PRESETS_SETTING_KEY)).limit(1)
    return pick(ps?.value)
  }

  // ---------- escrita ----------

  async create(companyId: string, input: AgentWriteInput = {}, actorUserId: string | null = null): Promise<AgentDto> {
    const data = this.parseWrite(input)
    const settings = this.mergeSettings({}, data.settings)
    if (data.model) await this.assertProvider(companyId, data.model.provider)
    const id = await this.db.transaction(async (tx) => {
      await this.assertBelowLimit(tx, companyId)
      const [row] = await tx
        .insert(aiAgents)
        .values({ companyId, createdByUserId: actorUserId, ...this.columns(data), model: data.model ?? null })
        .returning({ id: aiAgents.id })
      await tx.insert(aiAgentSettings).values({ agentId: row!.id, companyId, settings })
      await this.replaceSkills(tx, companyId, row!.id, data.skills ?? [])
      await this.replaceFields(tx, companyId, row!.id, data.collection_fields ?? [...DEFAULT_COLLECTION_FIELDS])
      return row!.id
    })
    return this.get(companyId, id)
  }

  async update(companyId: string, id: string, input: AgentWriteInput): Promise<AgentDto> {
    const data = this.parseWrite(input)
    await this.row(this.db, companyId, id)
    if (data.model) await this.assertProvider(companyId, data.model.provider)
    await this.db.transaction(async (tx) => {
      const patch: Partial<typeof aiAgents.$inferInsert> = { ...this.columns(data), updatedAt: new Date() }
      if (data.model !== undefined) patch.model = data.model
      // "Desfazer edição" (07 §5.5): o último prompt gerado fica guardado enquanto não for editado à mão.
      if (data.generated_prompt !== undefined && data.prompt_edited === false) patch.lastGeneratedPrompt = data.generated_prompt
      await tx.update(aiAgents).set(patch).where(and(eq(aiAgents.companyId, companyId), eq(aiAgents.id, id)))
      if (data.settings) {
        const [cur] = await tx.select({ settings: aiAgentSettings.settings }).from(aiAgentSettings).where(eq(aiAgentSettings.agentId, id))
        const settings = this.mergeSettings(cur?.settings ?? {}, data.settings)
        await tx
          .insert(aiAgentSettings)
          .values({ agentId: id, companyId, settings })
          .onConflictDoUpdate({ target: aiAgentSettings.agentId, set: { settings, updatedAt: new Date() } })
      }
      if (data.skills) await this.replaceSkills(tx, companyId, id, data.skills)
      if (data.collection_fields) await this.replaceFields(tx, companyId, id, data.collection_fields)
    })
    return this.get(companyId, id)
  }

  /** draft|paused → active. Exige prompt e modelo resolvido com chave configurada (AC-T39-02/06). */
  async publish(companyId: string, id: string): Promise<AgentDto> {
    const agent = await this.get(companyId, id)
    if (agent.status === 'active') throw new AiAgentsError('invalid_transition', 'O agente já está publicado', { from: agent.status, to: 'active' })
    if (!agent.generated_prompt.trim()) throw agentInvalid('generated_prompt', 'Gere ou escreva o prompt antes de publicar', 'prompt_required')
    if (!agent.resolved_model) throw agentInvalid('model', 'Nenhum modelo configurado para o agente', 'model_required')
    await this.assertProvider(companyId, agent.resolved_model.provider as LlmProviderId)
    await this.setStatus(companyId, id, 'active')
    return this.get(companyId, id)
  }

  /** active → paused. */
  async pause(companyId: string, id: string): Promise<AgentDto> {
    const agent = await this.get(companyId, id)
    if (agent.status !== 'active') throw new AiAgentsError('invalid_transition', 'Só um agente publicado pode ser pausado', { from: agent.status, to: 'paused' })
    await this.setStatus(companyId, id, 'paused')
    return this.get(companyId, id)
  }

  /** Cópia em rascunho com settings, habilidades, campos de coleta e mídias (AC-T39-04). */
  async duplicate(companyId: string, id: string, actorUserId: string | null = null): Promise<AgentDto> {
    const src = await this.get(companyId, id)
    const srcRow = await this.row(this.db, companyId, id)
    const newId = await this.db.transaction(async (tx) => {
      await this.assertBelowLimit(tx, companyId)
      const { id: _id, createdAt: _c, updatedAt: _u, status: _s, name, ...rest } = srcRow
      const [row] = await tx
        .insert(aiAgents)
        .values({ ...rest, name: `${name} (cópia)`.slice(0, 80), status: 'draft', createdByUserId: actorUserId })
        .returning({ id: aiAgents.id })
      await tx.insert(aiAgentSettings).values({ agentId: row!.id, companyId, settings: src.settings })
      await this.replaceSkills(tx, companyId, row!.id, src.skills)
      await this.replaceFields(tx, companyId, row!.id, src.collection_fields)
      const media = await tx.select().from(aiAgentMedia).where(and(eq(aiAgentMedia.companyId, companyId), eq(aiAgentMedia.agentId, id)))
      if (media.length)
        await tx.insert(aiAgentMedia).values(media.map(({ id: _m, createdAt: _mc, ...m }) => ({ ...m, agentId: row!.id })))
      return row!.id
    })
    return this.get(companyId, newId)
  }

  /** Fluxos cujo nó "Agente IA" aponta para o agente e chats ativos atendidos por ele. */
  async references(companyId: string, id: string): Promise<AgentReferences> {
    const flowRows = await this.db
      .selectDistinct({ id: flows.id, name: flows.name })
      .from(flowNodeActions)
      .innerJoin(flowNodes, eq(flowNodes.id, flowNodeActions.nodeId))
      .innerJoin(flows, eq(flows.id, flowNodes.flowId))
      .where(
        and(
          eq(flowNodeActions.companyId, companyId),
          eq(flowNodeActions.type, 'control_ai_agent'),
          sql`${flowNodeActions.config}->>'agent_id' = ${id}`,
        ),
      )
      .orderBy(asc(flows.name))
    const chatRows = await this.db
      .select({ id: chats.id })
      .from(chats)
      .where(and(eq(chats.companyId, companyId), eq(chats.aiAgentId, id), inArray(chats.status, [...ACTIVE_CHAT_STATUSES])))
    return { flows: flowRows, chats: chatRows }
  }

  /** Com referências → `conflict` com `references`, a menos que `force` (AC-T39-05). */
  async delete(companyId: string, id: string, opts: { force?: boolean } = {}): Promise<void> {
    await this.row(this.db, companyId, id)
    const refs = await this.references(companyId, id)
    if (!opts.force && (refs.flows.length || refs.chats.length))
      throw new AiAgentsError('conflict', 'O agente está em uso por fluxos ou conversas ativas', { references: refs })
    await this.db.transaction(async (tx) => {
      // Conversas deixam de ter agente; os fluxos ficam apontando para um agente inexistente (como na referência).
      await tx.update(chats).set({ aiAgentId: null }).where(and(eq(chats.companyId, companyId), eq(chats.aiAgentId, id)))
      await tx.delete(aiAgents).where(and(eq(aiAgents.companyId, companyId), eq(aiAgents.id, id)))
    })
  }

  // ---------- avatar e mídias ----------

  async setAvatar(companyId: string, id: string, bytes: Uint8Array): Promise<AgentDto> {
    await this.row(this.db, companyId, id)
    if (bytes.byteLength > AVATAR_MAX_BYTES) throw new AiAgentsError('payload_too_large', 'Imagem acima de 5 MB')
    const mime = detectImageMime(bytes)
    if (!isAvatarMime(mime)) throw new AiAgentsError('unsupported_media', 'Use uma imagem JPEG, PNG ou WebP')
    const blob = await this.store().put(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength), mime)
    await this.db.update(aiAgents).set({ avatarBlobKey: blob.key, updatedAt: new Date() }).where(and(eq(aiAgents.companyId, companyId), eq(aiAgents.id, id)))
    return this.get(companyId, id)
  }

  async removeAvatar(companyId: string, id: string): Promise<AgentDto> {
    await this.row(this.db, companyId, id)
    await this.db.update(aiAgents).set({ avatarBlobKey: null, updatedAt: new Date() }).where(and(eq(aiAgents.companyId, companyId), eq(aiAgents.id, id)))
    return this.get(companyId, id)
  }

  async readAvatar(companyId: string, id: string): Promise<{ bytes: Buffer; mime: string } | null> {
    const row = await this.row(this.db, companyId, id)
    if (!row.avatarBlobKey) return null
    return this.readBlob(row.avatarBlobKey)
  }

  async addMedia(companyId: string, id: string, input: { bytes: Uint8Array; mime: string; title?: string; filename?: string | null }): Promise<AgentDto> {
    await this.row(this.db, companyId, id)
    if (input.bytes.byteLength > AGENT_MEDIA_MAX_BYTES) throw new AiAgentsError('payload_too_large', 'Arquivo acima de 8 MB')
    const mime = (input.mime || '').split(';')[0]!.trim().toLowerCase()
    if (!MEDIA_MIME_RE.test(mime)) throw new AiAgentsError('unsupported_media', 'Envie imagem, vídeo, áudio ou PDF')
    const title = (input.title?.trim() || input.filename?.trim() || 'arquivo').slice(0, 120)
    await this.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`ai_agent_media:${id}`}))`)
      const [c] = await tx.select({ n: count() }).from(aiAgentMedia).where(eq(aiAgentMedia.agentId, id))
      if ((c?.n ?? 0) >= AGENT_MEDIA_MAX_FILES)
        throw new AiAgentsError('limit_reached', `No máximo ${AGENT_MEDIA_MAX_FILES} arquivos por agente`, { limit: AGENT_MEDIA_MAX_FILES, used: c?.n ?? 0 })
      const blob = await this.store().put(Buffer.from(input.bytes.buffer, input.bytes.byteOffset, input.bytes.byteLength), mime)
      await tx.insert(aiAgentMedia).values({ companyId, agentId: id, title, filename: input.filename ?? null, blobKey: blob.key, mime, size: blob.size })
    })
    return this.get(companyId, id)
  }

  async removeMedia(companyId: string, id: string, mediaId: string): Promise<AgentDto> {
    await this.row(this.db, companyId, id)
    const res = await this.db
      .delete(aiAgentMedia)
      .where(and(eq(aiAgentMedia.companyId, companyId), eq(aiAgentMedia.agentId, id), eq(aiAgentMedia.id, mediaId)))
      .returning({ id: aiAgentMedia.id })
    if (!res.length) throw new AiAgentsError('not_found', 'Arquivo não encontrado')
    return this.get(companyId, id)
  }

  async readMedia(companyId: string, id: string, mediaId: string): Promise<{ bytes: Buffer; mime: string; filename: string | null } | null> {
    const [m] = await this.db
      .select()
      .from(aiAgentMedia)
      .where(and(eq(aiAgentMedia.companyId, companyId), eq(aiAgentMedia.agentId, id), eq(aiAgentMedia.id, mediaId)))
      .limit(1)
    if (!m) return null
    const blob = await this.readBlob(m.blobKey)
    return blob ? { ...blob, mime: m.mime, filename: m.filename } : null
  }

  // ---------- internos ----------

  private store(): BlobStore {
    if (!this.blobStore) throw new Error('AiAgentsService: blobStore não configurado')
    return this.blobStore
  }

  private async readBlob(key: string): Promise<{ bytes: Buffer; mime: string } | null> {
    const [bytes, head] = await Promise.all([this.store().get(key), this.store().head(key)])
    return bytes && head ? { bytes, mime: head.mime } : null
  }

  private parseWrite(input: unknown): z.output<typeof agentWriteSchema> {
    const r = agentWriteSchema.safeParse(input ?? {})
    if (!r.success) throw new AiAgentsError('validation', 'Dados inválidos', { fields: zodFields(r.error, '') })
    const keys = r.data.collection_fields?.map((f) => f.key) ?? []
    const dup = keys.find((k, i) => keys.indexOf(k) !== i)
    if (dup) throw agentInvalid(`collection_fields.${keys.lastIndexOf(dup)}.key`, `Campo "${dup}" repetido`)
    return r.data
  }

  private mergeSettings(current: Record<string, unknown>, patch: Record<string, unknown> | undefined): AgentSettings {
    const r = agentSettingsSchema.safeParse({ ...current, ...(patch ?? {}) })
    if (!r.success) throw new AiAgentsError('validation', 'Configurações inválidas', { fields: zodFields(r.error, 'settings') })
    return r.data
  }

  private columns(d: z.output<typeof agentWriteSchema>): Partial<typeof aiAgents.$inferInsert> {
    const out: Partial<typeof aiAgents.$inferInsert> = {}
    const map: [keyof typeof d, keyof typeof aiAgents.$inferInsert][] = [
      ['name', 'name'],
      ['role', 'role'],
      ['avatar_key', 'avatarKey'],
      ['primary_goal', 'primaryGoal'],
      ['personality', 'personality'],
      ['purpose', 'purpose'],
      ['audience', 'audience'],
      ['example_messages', 'exampleMessages'],
      ['business_rules', 'businessRules'],
      ['never_talk_about', 'neverTalkAbout'],
      ['use_emojis', 'useEmojis'],
      ['generated_prompt', 'generatedPrompt'],
      ['prompt_edited', 'promptEdited'],
    ]
    for (const [from, to] of map) if (d[from] !== undefined) (out as Record<string, unknown>)[to] = d[from]
    return out
  }

  private async assertProvider(companyId: string, provider: LlmProviderId): Promise<void> {
    if (!(await this.providerKeys.isConfigured({ companyId, provider })))
      throw agentInvalid('model', `Provedor ${provider} sem chave configurada (empresa nem plataforma)`, 'provider_not_configured')
  }

  private async row(exec: Exec, companyId: string, id: string): Promise<AgentRow> {
    if (!z.uuid().safeParse(id).success) throw agentNotFound()
    const [row] = await exec.select().from(aiAgents).where(and(eq(aiAgents.companyId, companyId), eq(aiAgents.id, id))).limit(1)
    if (!row) throw agentNotFound()
    return row
  }

  private async setStatus(companyId: string, id: string, status: AiAgentStatus): Promise<void> {
    await this.db.update(aiAgents).set({ status, updatedAt: new Date() }).where(and(eq(aiAgents.companyId, companyId), eq(aiAgents.id, id)))
  }

  private async countAgents(exec: Exec, companyId: string): Promise<number> {
    const [c] = await exec.select({ n: count() }).from(aiAgents).where(eq(aiAgents.companyId, companyId))
    return c?.n ?? 0
  }

  /** `companies.settings.limits.ai_agents` (número); ausente/null = ilimitado (SPEC 3.3). */
  private async agentLimit(exec: Exec, companyId: string): Promise<number | null> {
    const [c] = await exec.select({ settings: companies.settings }).from(companies).where(eq(companies.id, companyId)).limit(1)
    const v = ((c?.settings as { limits?: { ai_agents?: unknown } } | undefined)?.limits ?? {}).ai_agents
    return typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : null
  }

  /** Serializa criações concorrentes por empresa e confere o limite (AC-T39-03). */
  private async assertBelowLimit(tx: Tx, companyId: string): Promise<void> {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`ai_agents:${companyId}`}))`)
    const limit = await this.agentLimit(tx, companyId)
    if (limit === null) return
    const used = await this.countAgents(tx, companyId)
    if (used >= limit) throw new AiAgentsError('limit_reached', 'Limite de agentes da empresa atingido', { limit, used })
  }

  private async replaceSkills(tx: Tx, companyId: string, agentId: string, skills: AgentSkillInput[]): Promise<void> {
    await tx.delete(aiAgentSkills).where(eq(aiAgentSkills.agentId, agentId))
    if (!skills.length) return
    await tx.insert(aiAgentSkills).values(
      skills.map((s, position) => ({
        companyId,
        agentId,
        position,
        enabled: s.enabled,
        whenText: s.when_text,
        actionType: s.action_type,
        actionParams: s.action_params as Record<string, unknown>,
        scheduleMode: s.schedule_mode,
        silenceAmount: s.silence_amount,
        silenceUnit: s.silence_unit,
      })),
    )
  }

  private async replaceFields(tx: Tx, companyId: string, agentId: string, fields: CollectionFieldInput[]): Promise<void> {
    await tx.delete(aiCollectionFields).where(eq(aiCollectionFields.agentId, agentId))
    if (!fields.length) return
    await tx.insert(aiCollectionFields).values(fields.map((f, position) => ({ companyId, agentId, key: f.key, label: f.label, enabled: f.enabled, position })))
  }

  private async toDto(row: AgentRow): Promise<AgentDto> {
    const [settingsRow, skills, fields, media] = await Promise.all([
      this.db.select({ settings: aiAgentSettings.settings }).from(aiAgentSettings).where(eq(aiAgentSettings.agentId, row.id)),
      this.db.select().from(aiAgentSkills).where(eq(aiAgentSkills.agentId, row.id)).orderBy(asc(aiAgentSkills.position)),
      this.db.select().from(aiCollectionFields).where(eq(aiCollectionFields.agentId, row.id)).orderBy(asc(aiCollectionFields.position)),
      this.db.select().from(aiAgentMedia).where(eq(aiAgentMedia.agentId, row.id)).orderBy(asc(aiAgentMedia.createdAt)),
    ])
    const settings = agentSettingsSchema.parse(settingsRow[0]?.settings ?? {})
    const base = `/api/ai-agents/${row.id}`
    return {
      id: row.id,
      name: row.name,
      role: row.role,
      avatar_key: row.avatarKey,
      avatar_url: row.avatarBlobKey ? `${base}/avatar?v=${row.avatarBlobKey.slice(0, 12)}` : null,
      status: row.status,
      primary_goal: row.primaryGoal,
      purpose: row.purpose,
      audience: row.audience,
      personality: row.personality,
      example_messages: row.exampleMessages,
      business_rules: row.businessRules,
      never_talk_about: row.neverTalkAbout,
      use_emojis: row.useEmojis,
      generated_prompt: row.generatedPrompt,
      last_generated_prompt: row.lastGeneratedPrompt,
      prompt_edited: row.promptEdited,
      locked_blocks: row.lockedBlocks,
      model: row.model ?? null,
      resolved_model: await this.resolveModel(row.companyId, row.model ?? null, settings.engine),
      settings,
      skills: skills.map((s) => ({
        id: s.id,
        position: s.position,
        enabled: s.enabled,
        when_text: s.whenText,
        action_type: s.actionType,
        action_params: s.actionParams,
        schedule_mode: s.scheduleMode,
        silence_amount: s.silenceAmount,
        silence_unit: s.silenceUnit,
      })) as AgentDto['skills'],
      collection_fields: fields.map((f) => ({ id: f.id, key: f.key, label: f.label, enabled: f.enabled, position: f.position, variable: `{${f.key}}` })),
      media: media.map((m) => ({ id: m.id, title: m.title, filename: m.filename, mime: m.mime, size: m.size, url: `${base}/media/${m.id}`, created_at: iso(m.createdAt) })),
      skills_count: skills.length,
      created_at: iso(row.createdAt),
      updated_at: iso(row.updatedAt),
    }
  }
}
