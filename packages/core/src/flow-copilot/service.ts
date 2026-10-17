// Assistente de fluxo (T93; 07-agentes-ia.md §3.9, §4 e §7): sessões por fluxo e usuário, turnos medidos pelo
// UsageGuard (T24) e ferramentas que leem e editam o rascunho aberto. Toda edição passa pela validação da T10
// (só erros NOVOS recusam, sem gravar) e, depois de gravada, publica `flow.graph_updated` com `source: 'ai'`.
import { randomUUID } from 'node:crypto'
import { and, asc, desc, eq, gte, ne } from 'drizzle-orm'
import * as z from 'zod'
import {
  LlmQuotaExceededError,
  llmTool,
  type LlmMessage,
  type LlmProvider,
  type LlmProviderId,
  type LlmRequest,
  type LlmResult,
  type LlmTool,
} from '@crm/ai'
import {
  flowCopilotMessages,
  flowCopilotSessions,
  flows,
  type Database,
  type FlowCopilotMessageStatus,
  type FlowCopilotSessionStatus,
  type FlowCopilotToolCallRecord,
} from '@crm/db'
import { nodeHandles, NODE_TYPES, validate } from '@crm/shared/flows'
import { AiAgentsService } from '../ai-agents'
import type { UsageGuard } from '../ai-metering/guard'
import { FlowStore, FlowStoreError } from '../flows/store'
import {
  applyFlowEdit,
  blockCatalog,
  describeFlow,
  EDIT_MUTATION,
  FlowEditError,
  formatValidationErrors,
  newValidationErrors,
  type FlowEdit,
} from './edits'

export type FlowCopilotErrorCode = 'not_found' | 'validation' | 'invalid_state' | 'paused_quota' | 'no_balance'

export class FlowCopilotError extends Error {
  constructor(
    readonly code: FlowCopilotErrorCode,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message)
    this.name = 'FlowCopilotError'
  }
}

/** Publicador realtime (o `RealtimePublisher` do T16 ou um espião nos testes). */
export interface CopilotPublisher {
  publish(companyId: string, type: string, data: Record<string, unknown>, opts?: { userId?: string }): Promise<unknown>
}

export interface FlowCopilotOptions {
  db: Database
  /** LLM lido a CADA turno (o harness E2E troca o FakeLlm no `replace`). Recebe a empresa do turno. */
  llm: (companyId: string) => LlmProvider
  /** Medição/cobrança (T24). `null` = sem medição (só testes). */
  guard: UsageGuard | null
  publisher: CopilotPublisher
  /** Modelo quando a empresa e a plataforma não têm preset `balanced` (default: env `FLOW_COPILOT_MODEL=provider:model`, senão Sonnet). */
  model?: { provider: string; model: string }
  /** Passos do loop de ferramentas por turno (default 8). */
  maxSteps?: number
  /** Turnos anteriores enviados ao modelo (default 20 mensagens). */
  historyLimit?: number
  logger?: { warn(obj: unknown, msg?: string): void }
}

export interface CopilotCtx {
  companyId: string
  userId: string
}

export interface CopilotSessionDto {
  id: string
  flow_id: string
  title: string
  status: FlowCopilotSessionStatus
  last_message_at: string
  created_at: string
  updated_at: string
}

export interface CopilotMessageDto {
  id: string
  session_id: string
  role: 'user' | 'assistant'
  content: string
  status: FlowCopilotMessageStatus
  client_message_id: string | null
  tool_calls: FlowCopilotToolCallRecord[]
  credits: number
  error_code: string | null
  created_at: string
}

export interface CopilotTurnResult {
  session: CopilotSessionDto
  message: CopilotMessageDto
  reply: CopilotMessageDto | null
  /** Edições gravadas no turno. */
  graph_changed: boolean
}

/** Estimativa fixa da reserva: o turno só começa com saldo positivo; o débito real vem do uso (overrun permitido, 07 §5 item 12). */
export const COPILOT_RESERVE_CREDITS = 1
export const COPILOT_FEATURE = 'flow_copilot'
export const DEFAULT_COPILOT_MODEL = { provider: 'anthropic', model: 'claude-sonnet-5-5' } as const

const createSessionSchema = z.object({ flow_id: z.uuid(), title: z.string().trim().max(120).optional() }).strict()
const updateSessionSchema = z.object({ title: z.string().trim().min(1).max(120) }).strict()
const messageSchema = z
  .object({
    content: z.string().trim().min(1).max(8000),
    client_message_id: z.string().trim().min(1).max(100).optional(),
  })
  .strict()

type SessionRow = typeof flowCopilotSessions.$inferSelect
type MessageRow = typeof flowCopilotMessages.$inferSelect

function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const r = schema.safeParse(input ?? {})
  if (!r.success)
    throw new FlowCopilotError('validation', 'Dados inválidos', {
      fields: r.error.issues.map((i) => ({ path: i.path.map(String).join('.'), message: i.message })),
    })
  return r.data
}

export const toCopilotSessionDto = (s: SessionRow): CopilotSessionDto => ({
  id: s.id,
  flow_id: s.flowId,
  title: s.title,
  status: s.status,
  last_message_at: s.lastMessageAt.toISOString(),
  created_at: s.createdAt.toISOString(),
  updated_at: s.updatedAt.toISOString(),
})

export const toCopilotMessageDto = (m: MessageRow): CopilotMessageDto => ({
  id: m.id,
  session_id: m.sessionId,
  role: m.role,
  content: m.content,
  status: m.status,
  client_message_id: m.clientMessageId,
  tool_calls: m.toolCalls,
  credits: m.credits,
  error_code: m.errorCode,
  created_at: m.createdAt.toISOString(),
})

export const COPILOT_INSTRUCTIONS = [
  'Você é o Assistente de fluxo: ajuda a montar e revisar o fluxo de atendimento por WhatsApp aberto no editor.',
  'Responda em português, de forma curta e objetiva.',
  'Use `get_flow` para ler o rascunho atual (nós, ações, saídas e erros de validação) antes de editar, e `list_block_types` para ver os blocos e ações disponíveis.',
  'Cada nó tem um `id`; cada saída (handle) é `source`, `success`, `failure`, `timeout`, `other`, `option:<id>` ou `output:<id>`, conforme o bloco.',
  'Quando uma ferramenta devolver erro de validação, a alteração NÃO foi gravada: corrija e tente de novo ou explique ao usuário.',
  'Nunca invente ids: use os devolvidos pelas ferramentas.',
].join('\n')

const READ_ONLY_NOTE =
  'O usuário não tem permissão para editar este fluxo: responda perguntas e explique como fazer, mas você não tem ferramentas de edição.'

/** Quebra o texto final em pedaços para o `copilot.delta` (a porta de LLM não tem streaming). */
export function chunkCopilotText(text: string, maxChunks = 20, minSize = 40): string[] {
  if (!text) return []
  const size = Math.max(minSize, Math.ceil(text.length / maxChunks))
  const out: string[] = []
  let rest = text
  while (rest.length > size) {
    let cut = rest.lastIndexOf(' ', size)
    if (cut <= 0) cut = size
    else cut += 1
    out.push(rest.slice(0, cut))
    rest = rest.slice(cut)
  }
  if (rest) out.push(rest)
  return out
}

export class FlowCopilotService {
  private readonly db: Database
  private readonly store: FlowStore
  private readonly agents: AiAgentsService

  constructor(private readonly opts: FlowCopilotOptions) {
    this.db = opts.db
    this.store = new FlowStore(opts.db)
    this.agents = new AiAgentsService({ db: opts.db })
  }

  // ---------------------------------------------------------------- sessões

  async listSessions(
    ctx: CopilotCtx,
    query: { flow_id?: string; include_archived?: boolean } = {},
  ): Promise<CopilotSessionDto[]> {
    const where = [eq(flowCopilotSessions.companyId, ctx.companyId), eq(flowCopilotSessions.userId, ctx.userId)]
    if (query.flow_id) {
      await this.requireFlow(ctx, query.flow_id)
      where.push(eq(flowCopilotSessions.flowId, query.flow_id))
    }
    if (!query.include_archived) where.push(ne(flowCopilotSessions.status, 'archived'))
    const rows = await this.db
      .select()
      .from(flowCopilotSessions)
      .where(and(...where))
      .orderBy(desc(flowCopilotSessions.lastMessageAt), desc(flowCopilotSessions.createdAt))
    return rows.map(toCopilotSessionDto)
  }

  async createSession(ctx: CopilotCtx, input: unknown): Promise<CopilotSessionDto> {
    const data = parse(createSessionSchema, input)
    await this.requireFlow(ctx, data.flow_id)
    const [row] = await this.db
      .insert(flowCopilotSessions)
      .values({ companyId: ctx.companyId, flowId: data.flow_id, userId: ctx.userId, title: data.title ?? '' })
      .returning()
    return toCopilotSessionDto(row!)
  }

  async getSession(ctx: CopilotCtx, id: string): Promise<CopilotSessionDto> {
    return toCopilotSessionDto(await this.requireSession(ctx, id))
  }

  async updateSession(ctx: CopilotCtx, id: string, input: unknown): Promise<CopilotSessionDto> {
    const data = parse(updateSessionSchema, input)
    await this.requireSession(ctx, id)
    return toCopilotSessionDto(await this.patch(id, { title: data.title }))
  }

  async archive(ctx: CopilotCtx, id: string): Promise<CopilotSessionDto> {
    const s = await this.requireSession(ctx, id)
    if (s.status === 'archived') return toCopilotSessionDto(s)
    return toCopilotSessionDto(await this.patch(id, { status: 'archived', statusBeforeArchive: s.status }))
  }

  async reopen(ctx: CopilotCtx, id: string): Promise<CopilotSessionDto> {
    const s = await this.requireSession(ctx, id)
    if (s.status !== 'archived') return toCopilotSessionDto(s)
    return toCopilotSessionDto(
      await this.patch(id, {
        status: s.statusBeforeArchive === 'paused_quota' ? 'paused_quota' : 'active',
        statusBeforeArchive: null,
      }),
    )
  }

  /** `paused_quota` → `active`, só com saldo (AC-T93-04). Sessão ativa volta como está. */
  async resume(ctx: CopilotCtx, id: string): Promise<CopilotSessionDto> {
    const s = await this.requireSession(ctx, id)
    if (s.status === 'archived')
      throw new FlowCopilotError('invalid_state', 'Reabra a conversa antes de continuar', { reason: 'archived' })
    if (s.status === 'active') return toCopilotSessionDto(s)
    if (this.opts.guard) {
      try {
        await this.opts.guard.reserve(ctx.companyId, { credits: COPILOT_RESERVE_CREDITS }, COPILOT_FEATURE, {
          agentId: null,
        })
      } catch (err) {
        if (err instanceof LlmQuotaExceededError)
          throw new FlowCopilotError('no_balance', 'Sem créditos de IA para continuar', {
            reason: 'paused_quota',
            session_id: s.id,
          })
        throw err
      }
    }
    return toCopilotSessionDto(await this.patch(id, { status: 'active' }))
  }

  async listMessages(ctx: CopilotCtx, sessionId: string): Promise<CopilotMessageDto[]> {
    await this.requireSession(ctx, sessionId)
    const rows = await this.db
      .select()
      .from(flowCopilotMessages)
      .where(and(eq(flowCopilotMessages.companyId, ctx.companyId), eq(flowCopilotMessages.sessionId, sessionId)))
      .orderBy(asc(flowCopilotMessages.createdAt), desc(flowCopilotMessages.role))
    return rows.map(toCopilotMessageDto)
  }

  // ---------------------------------------------------------------- turno

  /**
   * Um turno: grava a mensagem do usuário, chama o LLM medido com as ferramentas (escrita só com `canEdit`,
   * AC-T93-05), emite `copilot.delta` (resultado de cada ferramenta e o texto final em pedaços) e `copilot.completed`.
   * Cota esgotada → sessão `paused_quota` e `FlowCopilotError('paused_quota')` (AC-T93-04).
   */
  async runTurn(
    ctx: CopilotCtx,
    sessionId: string,
    input: unknown,
    opts: { canEdit: boolean },
  ): Promise<CopilotTurnResult> {
    const data = parse(messageSchema, input)
    const session = await this.requireSession(ctx, sessionId)

    if (data.client_message_id) {
      const replay = await this.replay(ctx, session, data.client_message_id)
      if (replay) return replay
    }
    if (session.status === 'archived')
      throw new FlowCopilotError('invalid_state', 'Conversa arquivada: reabra para continuar', { reason: 'archived' })
    if (session.status === 'paused_quota')
      throw new FlowCopilotError('paused_quota', 'Conversa pausada por falta de créditos de IA: recarregue e retome', {
        reason: 'paused_quota',
        session_id: session.id,
      })
    await this.requireFlow(ctx, session.flowId)

    const history = await this.history(ctx, session.id)
    const [userRow] = await this.db
      .insert(flowCopilotMessages)
      .values({
        companyId: ctx.companyId,
        sessionId: session.id,
        role: 'user',
        content: data.content,
        clientMessageId: data.client_message_id ?? null,
      })
      .returning()
    const userMsg = userRow!
    await this.patch(session.id, {
      lastMessageAt: userMsg.createdAt,
      ...(session.title ? {} : { title: data.content.slice(0, 60) }),
    })

    const replyId = randomUUID()
    const flowCtx = { companyId: ctx.companyId, userId: ctx.userId }
    const records: FlowCopilotToolCallRecord[] = []
    let graphChanged = false
    const emit = (type: 'copilot.delta' | 'copilot.completed', payload: Record<string, unknown>) =>
      this.opts.publisher
        .publish(
          ctx.companyId,
          type,
          { session_id: session.id, flow_id: session.flowId, message_id: replyId, ...payload },
          { userId: ctx.userId },
        )
        .catch((err: unknown) => this.opts.logger?.warn({ err }, 'copilot realtime publish failed'))

    const track = async (name: string, input: unknown, run: () => Promise<unknown>) => {
      try {
        const output = await run()
        records.push({ name, input, ok: true, output })
        await emit('copilot.delta', { kind: 'tool', tool: name, ok: true })
        return output
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        records.push({ name, input, ok: false, output: message })
        await emit('copilot.delta', { kind: 'tool', tool: name, ok: false, error: message })
        throw err
      }
    }

    const edit = async (e: FlowEdit) =>
      track(e.op, e, async () => {
        const def = await this.store.toDefinition(flowCtx, session.flowId)
        const result = applyFlowEdit(def, e)
        const added = newValidationErrors(validate(def), validate(result.definition))
        if (added.length)
          throw new FlowEditError(
            `Alteração recusada pela validação (nada foi gravado): ${formatValidationErrors(added)}`,
          )
        try {
          await this.store.fromDefinition(flowCtx, session.flowId, result.definition)
        } catch (err) {
          if (err instanceof FlowStoreError)
            throw new FlowEditError(`Alteração recusada (nada foi gravado): ${err.message}`)
          throw err
        }
        graphChanged = true
        // Depois do commit (pendência T123/T126); actor_id nulo: o canvas do próprio usuário também recarrega (isForeign da T45).
        await this.opts.publisher
          .publish(ctx.companyId, 'flow.graph_updated', {
            flow_id: session.flowId,
            actor_id: null,
            mutation: EDIT_MUTATION[e.op],
            source: 'ai',
            session_id: session.id,
          })
          .catch((err: unknown) => this.opts.logger?.warn({ err }, 'flow.graph_updated publish failed'))
        return { ok: true, ...result.summary }
      })

    const tools = this.tools(flowCtx, session.flowId, opts.canEdit, track, edit)
    const model = await this.modelFor(ctx.companyId)
    const credits = { total: 0 }
    const req: LlmRequest = {
      model: { provider: model.provider as LlmProviderId, model: model.model },
      instructions: opts.canEdit ? COPILOT_INSTRUCTIONS : `${COPILOT_INSTRUCTIONS}\n${READ_ONLY_NOTE}`,
      messages: [...history, { role: 'user', content: [{ type: 'text', text: data.content }] }],
      tools,
      maxSteps: this.opts.maxSteps ?? 8,
      tenantId: ctx.companyId,
      agentId: session.id,
    }

    let result: LlmResult | null = null
    let errorCode: string | null = null
    try {
      result = await this.metered(ctx.companyId, credits).generate(req)
      if (result.finish === 'error') errorCode = result.error?.code ?? 'LLM_ERROR'
    } catch (err) {
      if (err instanceof LlmQuotaExceededError) {
        const paused = await this.patch(session.id, { status: 'paused_quota' })
        await this.saveReply(ctx, session.id, replyId, {
          content: '',
          status: 'failed',
          errorCode: 'paused_quota',
          records,
          credits: 0,
        })
        await emit('copilot.completed', { status: 'paused_quota', graph_changed: graphChanged })
        throw new FlowCopilotError('paused_quota', 'Sem créditos de IA: a conversa foi pausada', {
          reason: 'paused_quota',
          session_id: paused.id,
        })
      }
      this.opts.logger?.warn({ err }, 'flow copilot turn failed')
      errorCode =
        (err as { code?: unknown })?.code && typeof (err as { code: unknown }).code === 'string'
          ? (err as { code: string }).code
          : 'UPSTREAM_ERROR'
    }

    const textOut = errorCode ? '' : (result?.text ?? '')
    for (const delta of chunkCopilotText(textOut)) await emit('copilot.delta', { kind: 'text', delta })
    const reply = await this.saveReply(ctx, session.id, replyId, {
      content: textOut,
      status: errorCode ? 'failed' : 'completed',
      errorCode,
      records,
      credits: credits.total,
    })
    const updated = await this.patch(session.id, { lastMessageAt: reply.createdAt })
    await emit('copilot.completed', {
      status: errorCode ? 'failed' : 'completed',
      graph_changed: graphChanged,
      ...(errorCode ? { error_code: errorCode } : {}),
    })
    return {
      session: toCopilotSessionDto(updated),
      message: toCopilotMessageDto(userMsg),
      reply: toCopilotMessageDto(reply),
      graph_changed: graphChanged,
    }
  }

  /** Ferramentas do turno. Sem `flows.edit` só as de leitura existem (AC-T93-05). */
  private tools(
    flowCtx: { companyId: string; userId: string },
    flowId: string,
    canEdit: boolean,
    track: (name: string, input: unknown, run: () => Promise<unknown>) => Promise<unknown>,
    edit: (e: FlowEdit) => Promise<unknown>,
  ): LlmTool[] {
    const handle = z
      .string()
      .min(1)
      .describe('Saída do nó: source, success, failure, timeout, other, option:<id> ou output:<id>')
    const config = z.record(z.string(), z.unknown())
    const read: LlmTool[] = [
      llmTool({
        name: 'get_flow',
        description:
          'Lê o rascunho atual do fluxo: nós (id, tipo, nome, ações, saídas), conexões e erros de validação.',
        input: z.object({}),
        execute: (input) =>
          track('get_flow', input, async () => {
            const def = await this.store.toDefinition(flowCtx, flowId)
            return describeFlow(def, validate(def), nodeHandles)
          }),
      }),
      llmTool({
        name: 'list_block_types',
        description: 'Lista os tipos de bloco que podem ser criados e as ações aceitas em cada um.',
        input: z.object({}),
        execute: (input) => track('list_block_types', input, async () => blockCatalog()),
      }),
    ]
    if (!canEdit) return read
    const creatable = NODE_TYPES.filter((t) => t !== 'start') as [string, ...string[]]
    const write: LlmTool[] = [
      llmTool({
        name: 'create_node',
        description: 'Cria um bloco (opcionalmente com ações e ligado à saída de outro nó).',
        input: z.object({
          type: z.enum(creatable),
          name: z.string().max(120).optional(),
          position: z.object({ x: z.number(), y: z.number() }).optional(),
          actions: z
            .array(z.object({ type: z.string().min(1), config }))
            .max(20)
            .optional(),
          connect_from: z.object({ node_id: z.string().min(1), handle }).optional(),
        }),
        execute: (input) => edit({ op: 'create_node', ...input }),
      }),
      llmTool({
        name: 'update_action',
        description:
          'Edita a config de uma ação de um nó (mescla os campos; `replace: true` substitui a config inteira).',
        input: z.object({
          node_id: z.string().min(1),
          action_id: z.string().min(1),
          config,
          replace: z.boolean().optional(),
        }),
        execute: (input) => edit({ op: 'update_action', ...input }),
      }),
      llmTool({
        name: 'connect',
        description: 'Liga a saída (handle) de um nó a outro nó; se a saída já estava ligada, troca o destino.',
        input: z.object({ from: z.string().min(1), handle, to: z.string().min(1) }),
        execute: (input) => edit({ op: 'connect', ...input }),
      }),
      llmTool({
        name: 'disconnect',
        description: 'Remove a conexão de uma saída de um nó.',
        input: z.object({ from: z.string().min(1), handle }),
        execute: (input) => edit({ op: 'disconnect', ...input }),
      }),
      llmTool({
        name: 'delete_node',
        description: 'Remove um nó e as conexões dele (o nó Início não pode ser removido).',
        input: z.object({ node_id: z.string().min(1) }),
        execute: (input) => edit({ op: 'delete_node', ...input }),
      }),
    ]
    return [...read, ...write]
  }

  /** Nomes das ferramentas disponíveis para o usuário (UI e testes). */
  static toolNames(canEdit: boolean): string[] {
    const read = ['get_flow', 'list_block_types']
    return canEdit ? [...read, 'create_node', 'update_action', 'connect', 'disconnect', 'delete_node'] : read
  }

  // ---------------------------------------------------------------- apoio

  /** LLM medido (reserve → generate → commit/fail) com estimativa fixa e captura dos créditos do turno. */
  private metered(companyId: string, captured: { total: number }): LlmProvider {
    const guard = this.opts.guard
    const llm = this.opts.llm(companyId)
    if (!guard) return llm
    return {
      async generate<T>(req: LlmRequest<T>): Promise<LlmResult<T>> {
        const base = {
          provider: req.model.provider,
          model: req.model.model,
          kind: 'llm' as const,
          feature: COPILOT_FEATURE,
          agentId: null,
          companyId,
        }
        const r = await guard.reserve(companyId, { credits: COPILOT_RESERVE_CREDITS }, COPILOT_FEATURE, {
          agentId: null,
          requestId: randomUUID(),
        })
        let result: LlmResult<T>
        try {
          result = await llm.generate(req)
        } catch (err) {
          await guard.fail({ ...base, requestId: r.requestId, error: err })
          throw err
        }
        if (result.finish === 'error') {
          await guard.fail({
            ...base,
            requestId: r.requestId,
            usage: result.usage,
            error: { code: result.error?.code ?? 'LLM_ERROR' },
          })
          return result
        }
        const c = await guard.commit({ ...base, requestId: r.requestId, usage: result.usage })
        captured.total += c.credits
        return result
      },
    }
  }

  private async modelFor(companyId: string): Promise<{ provider: string; model: string }> {
    const preset = await this.agents.resolveModel(companyId, null, 'balanced')
    if (preset) return preset
    if (this.opts.model) return this.opts.model
    const env = process.env.FLOW_COPILOT_MODEL?.trim()
    const at = env ? env.indexOf(':') : -1
    return env && at > 0 ? { provider: env.slice(0, at), model: env.slice(at + 1) } : DEFAULT_COPILOT_MODEL
  }

  /** Histórico em texto (turnos concluídos), do mais antigo ao mais novo. */
  private async history(ctx: CopilotCtx, sessionId: string): Promise<LlmMessage[]> {
    const rows = await this.db
      .select()
      .from(flowCopilotMessages)
      .where(
        and(
          eq(flowCopilotMessages.companyId, ctx.companyId),
          eq(flowCopilotMessages.sessionId, sessionId),
          eq(flowCopilotMessages.status, 'completed'),
        ),
      )
      .orderBy(desc(flowCopilotMessages.createdAt))
      .limit(this.opts.historyLimit ?? 20)
    return rows
      .reverse()
      .filter((m) => m.content)
      .map((m) => ({ role: m.role, content: [{ type: 'text' as const, text: m.content }] }))
  }

  private async replay(
    ctx: CopilotCtx,
    session: SessionRow,
    clientMessageId: string,
  ): Promise<CopilotTurnResult | null> {
    const [msg] = await this.db
      .select()
      .from(flowCopilotMessages)
      .where(
        and(eq(flowCopilotMessages.sessionId, session.id), eq(flowCopilotMessages.clientMessageId, clientMessageId)),
      )
      .limit(1)
    if (!msg) return null
    const [reply] = await this.db
      .select()
      .from(flowCopilotMessages)
      .where(
        and(
          eq(flowCopilotMessages.sessionId, session.id),
          eq(flowCopilotMessages.role, 'assistant'),
          gte(flowCopilotMessages.createdAt, msg.createdAt),
        ),
      )
      .orderBy(asc(flowCopilotMessages.createdAt))
      .limit(1)
    return {
      session: toCopilotSessionDto(session),
      message: toCopilotMessageDto(msg),
      reply: reply ? toCopilotMessageDto(reply) : null,
      graph_changed: false,
    }
  }

  private async saveReply(
    ctx: CopilotCtx,
    sessionId: string,
    id: string,
    r: {
      content: string
      status: FlowCopilotMessageStatus
      errorCode: string | null
      records: FlowCopilotToolCallRecord[]
      credits: number
    },
  ): Promise<MessageRow> {
    const [row] = await this.db
      .insert(flowCopilotMessages)
      .values({
        id,
        companyId: ctx.companyId,
        sessionId,
        role: 'assistant',
        content: r.content,
        status: r.status,
        errorCode: r.errorCode,
        toolCalls: r.records,
        credits: r.credits,
      })
      .returning()
    return row!
  }

  private async patch(id: string, set: Partial<typeof flowCopilotSessions.$inferInsert>): Promise<SessionRow> {
    const [row] = await this.db
      .update(flowCopilotSessions)
      .set({ ...set, updatedAt: new Date() })
      .where(eq(flowCopilotSessions.id, id))
      .returning()
    return row!
  }

  private async requireSession(ctx: CopilotCtx, id: string): Promise<SessionRow> {
    if (!z.uuid().safeParse(id).success) throw new FlowCopilotError('not_found', 'Conversa não encontrada')
    const [row] = await this.db
      .select()
      .from(flowCopilotSessions)
      .where(
        and(
          eq(flowCopilotSessions.id, id),
          eq(flowCopilotSessions.companyId, ctx.companyId),
          eq(flowCopilotSessions.userId, ctx.userId),
        ),
      )
      .limit(1)
    if (!row) throw new FlowCopilotError('not_found', 'Conversa não encontrada')
    return row
  }

  private async requireFlow(ctx: CopilotCtx, flowId: string): Promise<void> {
    if (!z.uuid().safeParse(flowId).success) throw new FlowCopilotError('not_found', 'Fluxo não encontrado')
    const [row] = await this.db
      .select({ id: flows.id })
      .from(flows)
      .where(and(eq(flows.id, flowId), eq(flows.companyId, ctx.companyId)))
      .limit(1)
    if (!row) throw new FlowCopilotError('not_found', 'Fluxo não encontrado')
  }
}
