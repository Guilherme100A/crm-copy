// Laboratório de agentes (T79; 07 §5 itens 4–6, §6): teste ao vivo, geração de prompt e criação assistida.
// O teste ao vivo roda o turno do runtime T68 (mesmas instruções, base de conhecimento e habilidades como tools) em
// modo teste: sem WhatsApp e sem efeitos (as tools só registram o que fariam). Estado efêmero (conversa de teste,
// contador `eval_cap`, runs de criação) fica no Redis.
import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { LlmQuotaExceededError, llmTool, type LlmMessage, type LlmProvider, type LlmProviderId, type LlmRequest, type LlmResult, type LlmTool, type SttProvider } from '@crm/ai'
import { aiAgents, aiWallets, companies, type Database } from '@crm/db'
import type { Redis } from 'ioredis'
import { AiAgentsError, AiAgentsService, agentSettingsSchema, agentWriteSchema, type AgentDto } from '../ai-agents'
import { AiKnowledgeService } from '../ai-knowledge/service'
import { readSite } from '../ai-knowledge/site'
import type { KnowledgeSearch } from '../ai-runtime/runtime'
import { HISTORY_LIMIT } from '../ai-runtime/runtime'
import { canSpeak, splitReply, audioBlockReason } from '../ai-runtime/text-rules'
import type { UsageGuard } from '../ai-metering/guard'
import { DEFAULT_OUTPUT_ESTIMATE, estimateInputTokens, meterStt } from '../ai-metering/meter'
import { PricingService } from '../ai-usage/pricing'
import type { SafeHttpOptions } from '../flows/nodes/external/http'
import { generatePrompt, type PromptBlock } from './prompt'

export const AI_TEST_FEATURE = 'ai_agent_test'
export const AI_CREATE_FEATURE = 'ai_agent_create'
export const AI_TRANSCRIBE_FEATURE = 'ai_agent_transcription'
export const DEFAULT_EVAL_CAP = 200
export const TEST_HISTORY_TTL_S = 24 * 3600
export const RUN_TTL_S = 7 * 86_400
export const RUN_LOCK_TTL_S = 15 * 60
export const AI_AGENT_LAB_QUEUE = 'ai-agent-lab'
export const RUN_STAGES = ['extract', 'compose', 'persist'] as const
export type RunStage = (typeof RUN_STAGES)[number]
export const EMPTY_KNOWLEDGE_MIN_CHARS = 40
/** Compare-and-delete: apaga a trava só se o valor ainda for o run que está terminando. */
const RELEASE_LOCK_LUA = "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end"

export type AgentLabErrorCode = 'not_found' | 'validation' | 'eval_cap' | 'no_balance' | 'not_configured' | 'create_in_progress' | 'invalid_audio'

export class AgentLabError extends Error {
  constructor(
    readonly code: AgentLabErrorCode,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message)
    this.name = 'AgentLabError'
  }
}

export interface AgentLabJobData {
  runId: string
  companyId: string
}

export interface AgentRun {
  id: string
  company_id: string
  status: 'queued' | 'running' | 'completed' | 'failed'
  stage: RunStage | null
  stages_done: RunStage[]
  warnings: string[]
  agent_id: string | null
  error_message: string | null
  pitch: string
  site_url: string | null
  created_by: string | null
  created_at: string
  updated_at: string
}

export type PublicRun = Omit<AgentRun, 'company_id' | 'pitch' | 'site_url' | 'created_by'>

export interface TestMessageResult {
  blocks: { type: 'text'; text: string }[]
  audio: { requested: boolean; allowed: boolean; reason: string | null }
  skills_fired: { tool: string; action_type: string; skill_id: string | null; input: unknown }[]
  fields_filled: Record<string, string>
  collected: Record<string, string>
  handoff: { reason: string } | null
  trace: {
    model: { provider: string; model: string }
    instructions: string
    knowledge_hits: string[]
    tool_calls: { name: string; input: unknown; output: unknown }[]
    finish: string
    steps: number
  }
  charged_credits: number
  charged_tokens: number
  usage: { input_tokens: number; output_tokens: number }
  eval: { used: number; limit: number }
}

export interface RunPublisher {
  publish(companyId: string, type: 'ai_agent.run.updated', data: { run: PublicRun }, opts?: Record<string, unknown>): Promise<unknown>
}

export interface AgentLabServiceOptions {
  db: Database
  redis: Redis
  llm: LlmProvider
  /** Medição/cobrança (T24). `null` desliga (testes unitários). */
  guard?: UsageGuard | null
  stt?: SttProvider | ((companyId: string) => Promise<SttProvider>)
  knowledge?: KnowledgeSearch
  publisher?: RunPublisher
  evalCap?: number
  siteHttp?: SafeHttpOptions
  /** Modelo da criação assistida quando a empresa e a plataforma não têm preset `balanced` (ou env `AI_AGENT_CREATE_MODEL=provider:model`). */
  composeModel?: { provider: string; model: string }
  /** Enfileira o processamento do run. Sem ela e sem `inline`, o run fica `queued`. */
  enqueueRun?: (data: AgentLabJobData) => Promise<void>
  /** Processa o run no próprio processo, logo depois do 202 (testes/E2E). */
  inline?: boolean
  prefix?: string
  now?: () => Date
  logger?: { warn(obj: object, msg?: string): void; error(obj: object, msg?: string): void }
}

const COMPOSE_SCHEMA = z.object({
  name: z.string().min(1).max(60),
  role: z.string().max(120),
  purpose: z.string().max(4000),
  audience: z.string().max(4000),
  personality: z.enum(['seller', 'support', 'consultative', 'casual']),
  primary_goal: z.enum(['sell', 'schedule', 'answer', 'qualify']),
  example_messages: z.string().max(4000),
  business_rules: z.string().max(4000),
  never_talk_about: z.string().max(2000),
})

const testInputSchema = z.object({ text: z.string().trim().min(1, 'Escreva a mensagem').max(4000), draft: z.record(z.string(), z.unknown()).nullish() })
const runInputSchema = z
  .object({
    pitch: z.string().trim().max(8000).default(''),
    site_url: z
      .string()
      .trim()
      .max(2000)
      .refine((u) => /^https?:\/\//i.test(u) && URL.canParse(u), 'Link inválido')
      .nullish()
      .or(z.literal('')),
  })
  .superRefine((v, ctx) => {
    if (!v.site_url && v.pitch.length < 10) ctx.addIssue({ code: 'custom', path: ['pitch'], message: 'Conte o que você vende (ao menos 10 caracteres) ou informe o site' })
    if (v.pitch && v.pitch.length < 10) ctx.addIssue({ code: 'custom', path: ['pitch'], message: 'Ao menos 10 caracteres' })
  })

const invalid = (fields: { path: string; message: string }[], extra: Record<string, unknown> = {}) => new AgentLabError('validation', 'Dados inválidos', { fields, ...extra })
const issues = (e: z.ZodError) => e.issues.map((i) => ({ path: i.path.map(String).join('.'), message: i.message }))

export class AgentLabService {
  private readonly agents: AiAgentsService
  private readonly prefix: string

  constructor(private readonly opts: AgentLabServiceOptions) {
    this.agents = new AiAgentsService({ db: opts.db })
    this.prefix = opts.prefix ?? 'crm:ai-agent-lab'
  }

  get evalCap(): number {
    return this.opts.evalCap ?? DEFAULT_EVAL_CAP
  }

  // ================================================================ teste ao vivo (AC-T79-01/02)

  async testMessage(companyId: string, agentId: string, userId: string | null, input: unknown): Promise<TestMessageResult> {
    const parsed = testInputSchema.safeParse(input ?? {})
    if (!parsed.success) throw invalid(issues(parsed.error))
    const agent = this.applyDraft(await this.getAgent(companyId, agentId), parsed.data.draft ?? null)
    const model = await this.agents.resolveModel(companyId, agent.model, agent.settings.engine)
    if (!model) throw new AgentLabError('not_configured', 'O agente não tem modelo de IA configurado', { reason: 'not_configured' })
    const prompt = agent.generated_prompt.trim() || generatePrompt(agent, agent.locked_blocks).prompt

    // eval_cap: reserva uma vaga do dia antes do LLM; sem saldo devolve a vaga.
    const evalKey = await this.evalKey(companyId)
    const used = await this.opts.redis.incr(evalKey)
    if (used === 1) await this.opts.redis.expire(evalKey, 2 * 86_400)
    if (used > this.evalCap) {
      await this.opts.redis.decr(evalKey)
      throw new AgentLabError('eval_cap', 'Limite diário de testes atingido', { reason: 'eval_cap', limit: this.evalCap, used: used - 1 })
    }

    const convKey = this.testKey(companyId, agentId, userId)
    const conv = await this.readJson<{ history: LlmMessage[]; collected: Record<string, string> }>(convKey) ?? { history: [], collected: {} }
    const knowledge = this.opts.knowledge ?? new AiKnowledgeService({ db: this.opts.db }).asKnowledgeSearch()
    const hits = await knowledge.search({ companyId, agentId, query: parsed.data.text }).catch(() => [] as string[])
    const instructions = this.instructions(agent, prompt, conv.collected, hits)

    const fired: TestMessageResult['skills_fired'] = []
    const filled: Record<string, string> = {}
    const toolCalls: TestMessageResult['trace']['tool_calls'] = []
    const effects = { audio: false, handoff: null as { reason: string } | null }
    const tools = this.testTools(agent, fired, filled, toolCalls, effects)
    const captured = { credits: 0 }
    const llm = this.metered(AI_TEST_FEATURE, companyId, agentId, captured)
    const userMessage: LlmMessage = { role: 'user', content: [{ type: 'text', text: parsed.data.text }] }
    let result
    try {
      result = await llm.generate({
        model: { provider: model.provider as LlmProviderId, model: model.model },
        instructions,
        messages: [...conv.history, userMessage],
        tools,
        tenantId: companyId,
        agentId,
      })
    } catch (err) {
      if (err instanceof LlmQuotaExceededError) {
        await this.opts.redis.decr(evalKey)
        throw new AgentLabError('no_balance', 'Sem créditos de IA para testar', { reason: 'no_balance' })
      }
      throw err
    }
    const text = result.finish === 'error' ? '' : result.text.trim()
    const providerData = [...result.steps].reverse().find((s) => s.providerData !== undefined)?.providerData
    const assistant: LlmMessage = { role: 'assistant', content: [{ type: 'text', text: result.text }], ...(providerData !== undefined ? { providerData } : {}) }
    const collected = { ...conv.collected, ...filled }
    await this.writeJson(convKey, { history: [...conv.history, userMessage, assistant].slice(-HISTORY_LIMIT), collected }, TEST_HISTORY_TTL_S)

    const audioAllowed = effects.audio && canSpeak(text)
    const parts = !text ? [] : audioAllowed ? [text] : agent.settings.split_messages ? splitReply(text) : [text]
    const usage = result.usage
    return {
      blocks: parts.map((t) => ({ type: 'text' as const, text: t })),
      audio: { requested: effects.audio, allowed: audioAllowed, reason: effects.audio && !audioAllowed ? (audioBlockReason(text) ?? 'empty') : null },
      skills_fired: fired,
      fields_filled: filled,
      collected,
      handoff: effects.handoff,
      trace: { model: { provider: model.provider, model: model.model }, instructions, knowledge_hits: hits, tool_calls: toolCalls, finish: result.finish, steps: result.steps.length },
      charged_credits: captured.credits,
      charged_tokens: (usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0),
      usage: { input_tokens: usage?.inputTokens ?? 0, output_tokens: usage?.outputTokens ?? 0 },
      eval: { used, limit: this.evalCap },
    }
  }

  /** "Limpar conversa": zera o teste sem mexer no cadastro. */
  async resetTest(companyId: string, agentId: string, userId: string | null): Promise<void> {
    await this.getAgent(companyId, agentId)
    await this.opts.redis.del(this.testKey(companyId, agentId, userId))
  }

  /** Testes já usados hoje (fuso da empresa). */
  async evalUsage(companyId: string): Promise<{ used: number; limit: number }> {
    const raw = await this.opts.redis.get(await this.evalKey(companyId))
    return { used: Number(raw ?? 0), limit: this.evalCap }
  }

  // ================================================================ geração de prompt (AC-T79-03)

  async generatePrompt(companyId: string, agentId: string): Promise<{ agent: AgentDto; prompt: string; blocks: PromptBlock[] }> {
    const agent = await this.getAgent(companyId, agentId)
    const { prompt, blocks } = generatePrompt(agent, agent.locked_blocks)
    await this.opts.db
      .update(aiAgents)
      .set({ generatedPrompt: prompt, lastGeneratedPrompt: prompt, promptEdited: false, updatedAt: this.now() })
      .where(eq(aiAgents.id, agent.id))
    return { agent: await this.agents.get(companyId, agentId), prompt, blocks }
  }

  // ================================================================ criação assistida (AC-T79-04)

  async createRun(companyId: string, userId: string | null, input: unknown): Promise<PublicRun> {
    const parsed = runInputSchema.safeParse(input ?? {})
    if (!parsed.success) throw invalid(issues(parsed.error))
    const id = randomUUID()
    const lock = this.lockKey(companyId)
    let ok = await this.opts.redis.set(lock, id, 'EX', RUN_LOCK_TTL_S, 'NX')
    if (ok !== 'OK') {
      const current = await this.opts.redis.get(lock)
      // A trava sumiu entre o SET e o GET (run anterior acabou de terminar): tenta de novo uma vez.
      if (current === null) ok = await this.opts.redis.set(lock, id, 'EX', RUN_LOCK_TTL_S, 'NX')
      if (ok !== 'OK')
        throw new AgentLabError('create_in_progress', 'Já existe uma criação em andamento', { reason: 'create_in_progress', run_id: current ?? (await this.opts.redis.get(lock)) })
    }
    const now = this.now().toISOString()
    const run: AgentRun = {
      id,
      company_id: companyId,
      status: 'queued',
      stage: null,
      stages_done: [],
      warnings: [],
      agent_id: null,
      error_message: null,
      pitch: parsed.data.pitch,
      site_url: parsed.data.site_url || null,
      created_by: userId,
      created_at: now,
      updated_at: now,
    }
    await this.saveRun(run)
    if (this.opts.inline)
      setImmediate(() => {
        this.processRun(id).catch((err) => this.opts.logger?.error({ err, runId: id }, 'ai-agent-lab: falha no run'))
      })
    else if (this.opts.enqueueRun) {
      try {
        await this.opts.enqueueRun({ runId: id, companyId })
      } catch (err) {
        await this.finish(run, 'failed', 'enqueue_failed')
        throw err
      }
    }
    return publicRun(run)
  }

  async getRun(companyId: string, runId: string): Promise<PublicRun> {
    const run = await this.loadRun(runId)
    if (!run || run.company_id !== companyId) throw new AgentLabError('not_found', 'Criação não encontrada')
    return publicRun(run)
  }

  /** Job: extract → compose → persist. Falha de negócio vira `failed` com código; não relança. */
  async processRun(runId: string): Promise<PublicRun | null> {
    const run = await this.loadRun(runId)
    if (!run || run.status === 'completed' || run.status === 'failed') return run ? publicRun(run) : null
    try {
      // extract
      await this.stage(run, 'extract')
      let siteText = ''
      if (run.site_url) {
        try {
          const pages = await readSite(run.site_url, this.opts.siteHttp ? { http: this.opts.siteHttp } : {})
          siteText = pages.map((p) => [p.title, p.text].filter(Boolean).join('\n')).join('\n\n').trim()
        } catch (err) {
          this.opts.logger?.warn({ err, runId }, 'ai-agent-lab: site não lido')
        }
        if (!siteText) run.warnings.push('site_unread')
      }
      const material = [run.pitch, siteText.slice(0, 20_000)].filter(Boolean).join('\n\n')
      if (material.replace(/\s+/g, ' ').trim().length < EMPTY_KNOWLEDGE_MIN_CHARS) run.warnings.push('empty_knowledge')
      run.stages_done.push('extract')

      // compose
      await this.stage(run, 'compose')
      const model = await this.composeModelFor(run.company_id)
      if (!model) return this.finish(run, 'failed', 'not_configured')
      let composed: z.output<typeof COMPOSE_SCHEMA>
      try {
        const res = await this.metered(AI_CREATE_FEATURE, run.company_id, null, { credits: 0 }).generate({
          model: { provider: model.provider as LlmProviderId, model: model.model },
          instructions:
            'Você monta agentes de atendimento por WhatsApp. A partir do material, preencha os campos do agente em português do Brasil, ' +
            'com frases curtas e concretas. Não invente preços nem promessas que não estejam no material.',
          messages: [{ role: 'user', content: [{ type: 'text', text: material || '(sem material: monte um agente genérico de vendas)' }] }],
          output: COMPOSE_SCHEMA,
          tenantId: run.company_id,
          agentId: '',
        })
        const parsed = COMPOSE_SCHEMA.safeParse(res.object)
        if (res.finish === 'error' || !parsed.success) return this.finish(run, 'failed', 'compose_failed')
        composed = parsed.data
      } catch (err) {
        if (err instanceof LlmQuotaExceededError) return this.finish(run, 'failed', 'no_balance')
        throw err
      }
      run.stages_done.push('compose')

      // persist
      await this.stage(run, 'persist')
      const { prompt } = generatePrompt({ ...composed, use_emojis: true })
      let agent: AgentDto
      try {
        agent = await this.agents.create(run.company_id, { ...composed, generated_prompt: prompt }, run.created_by)
      } catch (err) {
        if (err instanceof AiAgentsError && err.code === 'limit_reached') return this.finish(run, 'failed', 'limit_reached')
        throw err
      }
      await this.opts.db.update(aiAgents).set({ lastGeneratedPrompt: prompt }).where(eq(aiAgents.id, agent.id))
      const knowledge = new AiKnowledgeService({ db: this.opts.db })
      if (run.site_url && siteText) await knowledge.create(run.company_id, agent.id, { kind: 'site', url: run.site_url }).catch((err) => this.opts.logger?.warn({ err, runId }, 'ai-agent-lab: fonte site'))
      if (run.pitch) await knowledge.create(run.company_id, agent.id, { kind: 'text', title: 'O que vendemos', body: run.pitch }).catch((err) => this.opts.logger?.warn({ err, runId }, 'ai-agent-lab: fonte pitch'))
      run.stages_done.push('persist')
      run.agent_id = agent.id
      return this.finish(run, 'completed', null)
    } catch (err) {
      this.opts.logger?.error({ err, runId }, 'ai-agent-lab: erro no run')
      return this.finish(run, 'failed', 'request_failed')
    }
  }

  /** Estimativa da criação assistida: créditos da chamada de montagem contra o saldo. */
  async estimate(companyId: string, input: unknown): Promise<{ estimated_tokens: number; estimated_credits: number | null; available_credits: number; enough: boolean }> {
    const parsed = runInputSchema.safeParse(input ?? {})
    if (!parsed.success) throw invalid(issues(parsed.error))
    const inputTokens = Math.ceil((parsed.data.pitch.length + (parsed.data.site_url ? 20_000 : 0) + 600) / 4)
    const outputTokens = 1500
    const [w] = await this.opts.db.select({ balance: aiWallets.balanceCredits }).from(aiWallets).where(eq(aiWallets.companyId, companyId)).limit(1)
    const available = Number(w?.balance ?? 0)
    let credits: number | null = null
    const model = await this.composeModelFor(companyId)
    if (model) {
      try {
        credits = (await new PricingService({ db: this.opts.db }).costOf({ provider: model.provider, model: model.model, inputTokens, outputTokens }, this.now(), { companyId })).credits
      } catch {
        credits = null
      }
    }
    return { estimated_tokens: inputTokens + outputTokens, estimated_credits: credits, available_credits: available, enough: credits === null ? available > 0 : available >= credits }
  }

  /** Ditado do pitch (07 §5 item 4): STT medido. */
  async transcribe(companyId: string, audio: Uint8Array, mime: string): Promise<{ text: string }> {
    if (!audio.byteLength || !/^(audio|video)\//.test(mime)) throw new AgentLabError('invalid_audio', 'Áudio inválido', { reason: 'invalid_audio' })
    const stt = typeof this.opts.stt === 'function' ? await this.opts.stt(companyId) : this.opts.stt
    if (!stt) throw new AgentLabError('not_configured', 'Transcrição indisponível', { reason: 'not_configured' })
    const provider = this.opts.guard ? meterStt(stt, { guard: this.opts.guard, feature: AI_TRANSCRIBE_FEATURE, companyId }) : stt
    try {
      const res = await provider.transcribe({ audio, mime, language: 'pt' })
      return { text: res.text.trim() }
    } catch (err) {
      if (err instanceof LlmQuotaExceededError) throw new AgentLabError('no_balance', 'Sem créditos de IA', { reason: 'no_balance' })
      throw new AgentLabError('invalid_audio', 'Não foi possível transcrever o áudio', { reason: 'invalid_audio' })
    }
  }

  // ================================================================ internos

  private async getAgent(companyId: string, agentId: string): Promise<AgentDto> {
    try {
      return await this.agents.get(companyId, agentId)
    } catch (err) {
      if (err instanceof AiAgentsError && err.code === 'not_found') throw new AgentLabError('not_found', 'Agente não encontrado')
      throw err
    }
  }

  /** Modelo da montagem: preset `balanced` da empresa/plataforma, senão `composeModel`, senão `AI_AGENT_CREATE_MODEL`. */
  private async composeModelFor(companyId: string): Promise<{ provider: string; model: string } | null> {
    const preset = await this.agents.resolveModel(companyId, null, 'balanced')
    if (preset) return preset
    if (this.opts.composeModel) return this.opts.composeModel
    const env = process.env.AI_AGENT_CREATE_MODEL?.trim()
    const at = env ? env.indexOf(':') : -1
    return env && at > 0 ? { provider: env.slice(0, at), model: env.slice(at + 1) } : null
  }

  /** Sobrepõe o rascunho não salvo (validado como o save do agente) só para este teste. */
  private applyDraft(agent: AgentDto, draft: Record<string, unknown> | null): AgentDto {
    if (!draft) return agent
    const r = agentWriteSchema.safeParse(draft)
    if (!r.success) throw invalid(issues(r.error).map((f) => ({ ...f, path: `draft.${f.path}` })))
    const d = r.data
    const out: AgentDto = { ...agent }
    for (const k of ['name', 'role', 'primary_goal', 'personality', 'purpose', 'audience', 'example_messages', 'business_rules', 'never_talk_about', 'use_emojis', 'generated_prompt'] as const)
      if (d[k] !== undefined) (out as unknown as Record<string, unknown>)[k] = d[k]
    if (d.model !== undefined) out.model = d.model
    if (d.settings) {
      const s = agentSettingsSchema.safeParse({ ...agent.settings, ...d.settings })
      if (!s.success) throw invalid(issues(s.error).map((f) => ({ ...f, path: `draft.settings.${f.path}` })))
      out.settings = s.data
    }
    if (d.skills) out.skills = d.skills.map((s, i) => ({ ...s, id: (s as { id?: string }).id ?? '', position: i }))
    if (d.collection_fields) out.collection_fields = d.collection_fields.map((f, i) => ({ ...f, id: '', position: i, variable: `{{agent.${f.key}}}` }))
    return out
  }

  /** Mesmas instruções do runtime T68: prompt + campos de coleta + emojis + base de conhecimento. */
  private instructions(agent: AgentDto, prompt: string, collected: Record<string, string>, hits: string[]): string {
    const parts = [prompt]
    const fields = agent.collection_fields.filter((f) => f.enabled)
    if (fields.length) parts.push(`Colete com naturalidade e grave com a tool fill_field: ${fields.map((f) => `${f.key} (${f.label})${collected[f.key] ? ` = já coletado` : ''}`).join(', ')}.`)
    parts.push(agent.use_emojis ? 'Use no máximo 1 emoji por mensagem.' : 'Não use emojis.')
    if (hits.length) parts.push(`Base de conhecimento (use se for relevante):\n${hits.map((h) => `- ${h}`).join('\n')}`)
    return parts.join('\n\n')
  }

  /** Habilidades como tools (mesmos nomes do runtime T68), sem efeito: só registram. */
  private testTools(
    agent: AgentDto,
    fired: TestMessageResult['skills_fired'],
    filled: Record<string, string>,
    calls: TestMessageResult['trace']['tool_calls'],
    effects: { audio: boolean; handoff: { reason: string } | null },
  ): LlmTool[] {
    const list: LlmTool[] = []
    const names = new Map<string, number>()
    const nameFor = (base: string) => {
      const n = (names.get(base) ?? 0) + 1
      names.set(base, n)
      return n === 1 ? base : `${base}_${n}`
    }
    const record = (tool: string, actionType: string, skillId: string | null, input: unknown, output: unknown) => {
      fired.push({ tool, action_type: actionType, skill_id: skillId || null, input })
      calls.push({ name: tool, input, output })
      return output
    }
    for (const skill of agent.skills.filter((s) => s.enabled)) {
      const params = (skill.action_params ?? {}) as Record<string, unknown>
      const desc = skill.when_text || skill.action_type
      const type = skill.action_type as string
      const add = (base: string, description: string, input: z.ZodObject, onFire?: () => void) => {
        const name = nameFor(base)
        list.push(
          llmTool({
            name,
            description,
            input,
            execute: async (args: unknown) => {
              onFire?.()
              return record(name, type, skill.id, args, { ok: true, test_mode: true })
            },
          }),
        )
      }
      if (type === 'transfer_human') add('transfer_human', `Transferir para um atendente humano. Quando: ${desc}`, z.object({ reason: z.string().max(500).optional() }), () => (effects.handoff = { reason: 'transfer_human' }))
      else if (type === 'apply_label') add('apply_label', `${params.mode === 'remove' ? 'Remover' : 'Aplicar'} etiqueta. Quando: ${desc}`, z.object({}))
      else if (type === 'trigger_flow') add('trigger_flow', `Disparar um fluxo. Quando: ${desc}`, z.object({}), () => (effects.handoff = params.return_to_agent ? effects.handoff : { reason: 'flow' }))
      else if (type === 'close_conversation') add('close_conversation', `Encerrar a conversa. Quando: ${desc}`, z.object({}), () => (effects.handoff = { reason: 'closed' }))
      else if (type === 'move_card') add('move_card', `Mover o card no CRM/Kanban. Quando: ${desc}`, z.object({}))
    }
    const fields = agent.collection_fields.filter((f) => f.enabled).map((f) => f.key)
    if (fields.length)
      list.push(
        llmTool({
          name: 'fill_field',
          description: 'Grava um dado do cliente quando ele aparecer na conversa.',
          input: z.object({ key: z.enum(fields as [string, ...string[]]), value: z.string().min(1).max(500) }),
          execute: async ({ key, value }) => {
            filled[key] = value
            const skill = agent.skills.find((s) => s.enabled && s.action_type === 'fill_field')
            return record('fill_field', 'fill_field', skill?.id ?? null, { key, value }, { ok: true, test_mode: true })
          },
        }),
      )
    if (agent.settings.audio_choice_enabled)
      list.push(
        llmTool({
          name: 'send_audio',
          description: agent.settings.audio_guidance?.trim() || 'Responder com áudio (nota de voz) em vez de texto.',
          input: z.object({}),
          execute: async () => {
            effects.audio = true
            calls.push({ name: 'send_audio', input: {}, output: { ok: true } })
            return { ok: true }
          },
        }),
      )
    return list
  }

  /**
   * LLM medido (reserve → generate → commit/fail, como o `meterLlm` da T24) com o `agent_id` explícito (nulo na
   * criação assistida, quando o agente ainda não existe) e captura dos créditos debitados. Sem guard, chama direto.
   */
  private metered(feature: string, companyId: string, agentId: string | null, captured: { credits: number }): LlmProvider {
    const guard = this.opts.guard
    const llm = this.opts.llm
    if (!guard) return llm
    return {
      async generate<T>(req: LlmRequest<T>): Promise<LlmResult<T>> {
        const base = { provider: req.model.provider, model: req.model.model, kind: 'llm' as const, feature, agentId, companyId }
        const estimate = { provider: base.provider, model: base.model, usage: { inputTokens: estimateInputTokens(req as LlmRequest), outputTokens: req.maxOutputTokens ?? DEFAULT_OUTPUT_ESTIMATE } }
        const r = await guard.reserve(companyId, estimate, feature, { agentId, requestId: randomUUID() })
        let result: LlmResult<T>
        try {
          result = await llm.generate(req)
        } catch (err) {
          await guard.fail({ ...base, requestId: r.requestId, error: err })
          throw err
        }
        if (result.finish === 'error') {
          await guard.fail({ ...base, requestId: r.requestId, usage: result.usage, error: { code: 'LLM_ERROR' } })
          return result
        }
        const c = await guard.commit({ ...base, requestId: r.requestId, usage: result.usage })
        captured.credits += c.credits
        return result
      },
    }
  }

  private async stage(run: AgentRun, stage: RunStage): Promise<void> {
    run.status = 'running'
    run.stage = stage
    await this.saveRun(run)
  }

  private async finish(run: AgentRun, status: 'completed' | 'failed', error: string | null): Promise<PublicRun> {
    run.status = status
    run.error_message = error
    if (status === 'failed') run.agent_id = null
    // Libera a trava ANTES de gravar/publicar o status final: quem vê o run concluído pode criar outro na hora.
    await this.releaseLock(run.company_id, run.id)
    await this.saveRun(run)
    return publicRun(run)
  }

  /** Compare-and-delete atômico: só apaga a trava se ela ainda for deste run. */
  private async releaseLock(companyId: string, runId: string): Promise<void> {
    await this.opts.redis.eval(RELEASE_LOCK_LUA, 1, this.lockKey(companyId), runId)
  }

  private async saveRun(run: AgentRun): Promise<void> {
    run.updated_at = this.now().toISOString()
    await this.writeJson(this.runKey(run.id), run, RUN_TTL_S)
    try {
      await this.opts.publisher?.publish(run.company_id, 'ai_agent.run.updated', { run: publicRun(run) })
    } catch (err) {
      this.opts.logger?.warn({ err, runId: run.id }, 'ai-agent-lab: realtime')
    }
  }

  private async loadRun(id: string): Promise<AgentRun | null> {
    if (!z.uuid().safeParse(id).success) return null
    return this.readJson<AgentRun>(this.runKey(id))
  }

  private async evalKey(companyId: string): Promise<string> {
    const [co] = await this.opts.db.select({ tz: companies.timeZone }).from(companies).where(eq(companies.id, companyId)).limit(1)
    const day = new Intl.DateTimeFormat('en-CA', { timeZone: co?.tz || 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(this.now())
    return `${this.prefix}:eval:${companyId}:${day}`
  }

  private testKey = (companyId: string, agentId: string, userId: string | null) => `${this.prefix}:test:${companyId}:${agentId}:${userId ?? 'anon'}`
  private runKey = (id: string) => `${this.prefix}:run:${id}`
  private lockKey = (companyId: string) => `${this.prefix}:active:${companyId}`

  private async readJson<T>(key: string): Promise<T | null> {
    const raw = await this.opts.redis.get(key)
    return raw ? (JSON.parse(raw) as T) : null
  }

  private async writeJson(key: string, value: unknown, ttlS: number): Promise<void> {
    await this.opts.redis.set(key, JSON.stringify(value), 'EX', ttlS)
  }

  private now = () => this.opts.now?.() ?? new Date()
}

function publicRun(r: AgentRun): PublicRun {
  return {
    id: r.id,
    status: r.status,
    stage: r.stage,
    stages_done: [...r.stages_done],
    warnings: [...new Set(r.warnings)],
    agent_id: r.agent_id,
    error_message: r.error_message,
    created_at: r.created_at,
    updated_at: r.updated_at,
  }
}
