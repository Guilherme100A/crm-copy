// Motor de fluxos (T25): executa a versão publicada de um fluxo para um contato, de forma idempotente sobre BullMQ.
// - Estado do run em `flow_runs`; o job `flow-step { runId, expectedSeq }` trava o run (FOR NO KEY UPDATE) e só
//   executa se `seq === expectedSeq` e o run está `running`: entregas duplicadas viram no-op.
// - Laço síncrono nó a nó até espera/fim, com no máximo 50 nós por job (`failed: loop_guard`).
// - Cada nó executado grava uma linha em `flow_run_steps` (action_key NULL); efeitos idempotentes (`ctx.once`)
//   gravam a sua linha (action_key = ação) na hora, fora da transação, para sobreviver a um crash do passo.
// - Erro do handler segue o handle `failure` se existir; senão o run fica `failed` com a mensagem.
import { and, eq, sql } from 'drizzle-orm'
import type { LlmProvider } from '@crm/ai'
import { companies, contacts, flowRunSteps, flowRuns, flowVersions, flows, type Database, type FlowRunStatus } from '@crm/db'
import type { Logger } from '@crm/node-kit'
import type { FlowDefinition, FlowNode } from '@crm/shared'
import type { WaGateway } from '@crm/wa-port'
import { isUniqueViolation } from '../../auth/errors'
import type { TemplateContact } from '../../templating/render'
import { FlowStore } from '../store/store'
import { buildContext, stepKey, type FlowRunRepo, type NodeOutcome, type StepStore, type WaitSpec } from './context'
import { dryRun, type DryRunInput, type DryRunResult } from './dry-run'
import { NodeNotImplementedError, createNodeRegistry, type NodeRegistry } from './registry'

export const MAX_STEPS_PER_JOB = 50
export const LOOP_GUARD_ERROR = 'loop_guard'

export type FlowEngineErrorCode = 'not_found' | 'flow_not_published' | 'flow_not_active' | 'contact_not_found' | 'run_active'

export class FlowEngineError extends Error {
  constructor(
    readonly code: FlowEngineErrorCode,
    message: string = code,
  ) {
    super(message)
    this.name = 'FlowEngineError'
  }
}

export interface FlowStepJobData {
  runId: string
  expectedSeq: number
}

export interface AfterNodeInfo {
  runId: string
  seq: number
  node: FlowNode
  nodeKey: string
  outcome: NodeOutcome | null
  error: unknown
}

export interface EngineHooks {
  /** Depois de cada nó, antes do commit do passo. Se lançar, o passo inteiro é desfeito (simula crash). */
  afterNode?(info: AfterNodeInfo): void | Promise<void>
}

export interface FlowEngineOptions {
  db: Database
  wa: WaGateway
  registry?: NodeRegistry
  llm?: LlmProvider
  logger?: Pick<Logger, 'debug' | 'info' | 'warn' | 'error'>
  /** Enfileira o próximo `flow-step` (worker). Sem ele, quem chama `startRun` executa `step`. */
  enqueue?: (job: FlowStepJobData) => Promise<void>
  hooks?: EngineHooks
  maxStepsPerJob?: number
  now?: () => Date
}

export interface StartRunInput {
  flowId?: string
  versionId?: string
  contactId: string
  chatId?: string | null
  trigger?: Record<string, unknown> | null
  vars?: Record<string, unknown>
}

export type StepResult =
  | { executed: false; reason: 'stale' | 'not_running' | 'not_found' }
  | { executed: true; status: FlowRunStatus; seq: number; steps: number; error?: string | null }

/** Estado que o laço lê e atualiza. */
export interface LoopState {
  runId: string
  companyId: string
  flowId: string
  contactId: string | null
  chatId: string | null
  seq: number
  currentNodeKey: string | null
  vars: Record<string, unknown>
  definition: FlowDefinition
  contact: TemplateContact | null
  timeZone?: string
}

export interface LoopResult {
  status: Extract<FlowRunStatus, 'completed' | 'failed' | 'waiting'>
  steps: number
  error?: string
  wait?: WaitSpec
  /** `jump: { flowId }`: iniciar outro fluxo depois do commit. */
  jumpFlowId?: string
}

export interface LoopDeps {
  registry: NodeRegistry
  wa: WaGateway
  llm?: LlmProvider
  log: NonNullable<FlowEngineOptions['logger']>
  store: StepStore
  repo: FlowRunRepo
  hooks?: EngineHooks
  maxSteps: number
  now?: () => Date
}

const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err))
const noopLog: LoopDeps['log'] = { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined }

function isOutcome(v: unknown): v is NodeOutcome {
  if (!v || typeof v !== 'object') return false
  const o = v as Record<string, unknown>
  if (typeof o.next === 'string') return true
  if (o.wait && typeof o.wait === 'object') return true
  if (o.end === true) return true
  const j = o.jump as Record<string, unknown> | undefined
  return !!j && (typeof j.nodeKey === 'string' || typeof j.flowId === 'string')
}

/**
 * Laço comum ao runner e ao dry-run: executa nós a partir de `state.currentNodeKey` até espera, fim, erro sem
 * `failure` ou o limite de passos. Muta `state` (seq, nó atual, vars).
 */
export async function runLoop(state: LoopState, deps: LoopDeps): Promise<LoopResult> {
  const { definition } = state
  const byId = new Map(definition.nodes.map((n) => [n.id, n]))
  const edgeOf = (from: string, handle: string) => definition.edges.find((e) => e.from === from && e.handle === handle)
  let steps = 0
  for (;;) {
    if (!state.currentNodeKey) return { status: 'completed', steps }
    if (steps >= deps.maxSteps) return { status: 'failed', steps, error: LOOP_GUARD_ERROR }
    const node = byId.get(state.currentNodeKey)
    if (!node) return { status: 'failed', steps, error: `node_not_found:${state.currentNodeKey}` }

    state.seq += 1
    steps += 1
    const seq = state.seq
    const ctx = buildContext({
      runId: state.runId,
      companyId: state.companyId,
      flowId: state.flowId,
      contactId: state.contactId,
      chatId: state.chatId,
      seq,
      node,
      definition,
      contact: state.contact,
      vars: state.vars,
      timeZone: state.timeZone,
      wa: deps.wa,
      llm: deps.llm,
      log: deps.log,
      repo: deps.repo,
      store: deps.store,
      now: deps.now,
    })

    let outcome: NodeOutcome | null = null
    let error: unknown = null
    try {
      const handler = deps.registry.get(node.type)
      if (!handler) throw new NodeNotImplementedError(node.type)
      const out = await handler.execute(ctx)
      if (!isOutcome(out)) throw new Error(`resultado inválido do nó ${node.type}`)
      outcome = out
    } catch (err) {
      error = err
    }

    const key = stepKey(state.runId, seq)
    const base = { key, seq, nodeKey: node.id, nodeType: node.type }
    let result: LoopResult | null = null
    if (error !== null) {
      const failure = edgeOf(node.id, 'failure')
      await deps.store.saveStep({ ...base, status: 'failed', result: { outcome: 'error', ...(failure ? { handle: 'failure' } : {}) }, error: errorMessage(error) })
      if (failure) state.currentNodeKey = failure.to
      else result = { status: 'failed', steps, error: errorMessage(error) }
    } else if (outcome && 'next' in outcome) {
      const edge = edgeOf(node.id, outcome.next)
      await deps.store.saveStep({ ...base, status: 'done', result: { outcome: 'next', handle: outcome.next } })
      state.currentNodeKey = edge?.to ?? null
    } else if (outcome && 'wait' in outcome) {
      await deps.store.saveStep({ ...base, status: 'done', result: { outcome: 'wait' } })
      result = { status: 'waiting', steps, wait: outcome.wait }
    } else if (outcome && 'end' in outcome) {
      await deps.store.saveStep({ ...base, status: 'done', result: { outcome: 'end' } })
      state.currentNodeKey = null
      result = { status: 'completed', steps }
    } else if (outcome && 'jump' in outcome) {
      const target = 'nodeKey' in outcome.jump ? outcome.jump.nodeKey : outcome.jump.flowId
      await deps.store.saveStep({ ...base, status: 'done', result: { outcome: 'jump', target } })
      if ('nodeKey' in outcome.jump) state.currentNodeKey = outcome.jump.nodeKey
      else {
        state.currentNodeKey = null
        result = { status: 'completed', steps, jumpFlowId: outcome.jump.flowId }
      }
    }

    await deps.hooks?.afterNode?.({ runId: state.runId, seq, node, nodeKey: node.id, outcome, error })
    if (result) return result
  }
}

type Tx = Parameters<Parameters<Database['transaction']>[0]>[0]

export class FlowEngine {
  private readonly db: Database
  private readonly opts: FlowEngineOptions
  readonly registry: NodeRegistry
  private readonly log: NonNullable<FlowEngineOptions['logger']>

  constructor(opts: FlowEngineOptions) {
    this.db = opts.db
    this.opts = opts
    this.registry = opts.registry ?? createNodeRegistry()
    this.log = opts.logger ?? noopLog
  }

  /** Cria o run na versão publicada (a última, ou `versionId`) e enfileira o 1º passo. */
  async startRun(ctx: { companyId: string }, input: StartRunInput): Promise<{ runId: string; expectedSeq: number }> {
    const version = await this.resolveVersion(ctx.companyId, input)
    const [contact] = await this.db
      .select({ id: contacts.id })
      .from(contacts)
      .where(and(eq(contacts.id, input.contactId), eq(contacts.companyId, ctx.companyId)))
      .limit(1)
    if (!contact) throw new FlowEngineError('contact_not_found', 'Contato não encontrado')
    const definition = version.definition as unknown as FlowDefinition
    let runId: string
    try {
      const [row] = await this.db
        .insert(flowRuns)
        .values({
          companyId: ctx.companyId,
          flowId: version.flowId,
          versionId: version.id,
          version: version.version,
          contactId: input.contactId,
          chatId: input.chatId ?? null,
          status: 'running',
          currentNodeKey: definition.entry,
          seq: 0,
          vars: input.vars ?? {},
          trigger: input.trigger ?? null,
        })
        .returning({ id: flowRuns.id })
      runId = row!.id
    } catch (err) {
      if (isUniqueViolation(err, 'flow_runs_active_contact_uq')) throw new FlowEngineError('run_active', 'O contato já está em um fluxo')
      throw err
    }
    await this.opts.enqueue?.({ runId, expectedSeq: 0 })
    return { runId, expectedSeq: 0 }
  }

  /** Executa o passo `expectedSeq` do run (o que o job `flow-step` chama). Entrega repetida/atrasada = no-op. */
  async step(runId: string, expectedSeq: number): Promise<StepResult> {
    let jumpFlowId: string | undefined
    let companyId = ''
    let contactId = ''
    let chatId: string | null = null
    const result = await this.db.transaction(async (tx): Promise<StepResult> => {
      const [run] = await tx.select().from(flowRuns).where(sql`${flowRuns.id}::text = ${runId}`).for('no key update').limit(1)
      if (!run) return { executed: false, reason: 'not_found' }
      if (run.status !== 'running') return { executed: false, reason: 'not_running' }
      if (run.seq !== expectedSeq) return { executed: false, reason: 'stale' }
      companyId = run.companyId
      contactId = run.contactId
      chatId = run.chatId

      const definition = await this.loadDefinition(tx, run.versionId)
      const state: LoopState = {
        runId: run.id,
        companyId: run.companyId,
        flowId: run.flowId,
        contactId: run.contactId,
        chatId: run.chatId,
        seq: run.seq,
        currentNodeKey: run.currentNodeKey ?? definition.entry,
        vars: { ...(run.vars ?? {}) },
        definition,
        contact: await this.loadContact(tx, run.companyId, run.contactId),
        timeZone: await this.companyTimeZone(tx, run.companyId),
      }
      const loop = await runLoop(state, {
        registry: this.registry,
        wa: this.opts.wa,
        llm: this.opts.llm,
        log: this.log,
        store: this.dbStore(tx, run.companyId, run.id),
        repo: { companyId: run.companyId, db: tx, dryRun: false },
        hooks: this.opts.hooks,
        maxSteps: this.opts.maxStepsPerJob ?? MAX_STEPS_PER_JOB,
        now: this.opts.now,
      })
      const finished = loop.status === 'completed' || loop.status === 'failed'
      await tx
        .update(flowRuns)
        .set({
          status: loop.status,
          seq: state.seq,
          currentNodeKey: state.currentNodeKey,
          vars: state.vars,
          wait: loop.wait ?? null,
          error: loop.error ?? null,
          finishedAt: finished ? (this.opts.now?.() ?? new Date()) : null,
          updatedAt: sql`now()`,
        })
        .where(eq(flowRuns.id, run.id))
      jumpFlowId = loop.jumpFlowId
      return { executed: true, status: loop.status, seq: state.seq, steps: loop.steps, error: loop.error ?? null }
    })
    if (result.executed && jumpFlowId) {
      try {
        await this.startRun({ companyId }, { flowId: jumpFlowId, contactId, chatId, trigger: { kind: 'connection_flow', from_run_id: runId } })
      } catch (err) {
        this.log.warn({ err, runId, flowId: jumpFlowId }, 'could not start the target flow of connection_flow')
      }
    }
    return result
  }

  /** Dry-run do RASCUNHO do fluxo (só leitura no banco; gateway fake próprio). */
  async dryRun(ctx: { companyId: string; userId?: string | null }, input: Omit<DryRunInput, 'definition'> & { flowId: string }): Promise<DryRunResult> {
    const { flowId, ...rest } = input
    const definition = await new FlowStore(this.db).toDefinition({ companyId: ctx.companyId, userId: ctx.userId ?? null }, flowId)
    return dryRun({ registry: this.registry, llm: this.opts.llm, ...rest, definition })
  }

  private async resolveVersion(companyId: string, input: StartRunInput) {
    if (input.versionId) {
      const [v] = await this.db
        .select()
        .from(flowVersions)
        .where(and(sql`${flowVersions.id}::text = ${input.versionId}`, eq(flowVersions.companyId, companyId)))
        .limit(1)
      if (!v) throw new FlowEngineError('not_found', 'Versão não encontrada')
      return v
    }
    if (!input.flowId) throw new FlowEngineError('not_found', 'Informe flowId ou versionId')
    const [flow] = await this.db
      .select({ id: flows.id, status: flows.status, publishedVersion: flows.publishedVersion })
      .from(flows)
      .where(and(sql`${flows.id}::text = ${input.flowId}`, eq(flows.companyId, companyId)))
      .limit(1)
    if (!flow) throw new FlowEngineError('not_found', 'Fluxo não encontrado')
    if (flow.status === 'paused' || flow.status === 'archived') throw new FlowEngineError('flow_not_active', 'Fluxo pausado ou arquivado')
    if (!flow.publishedVersion) throw new FlowEngineError('flow_not_published', 'Fluxo sem versão publicada')
    const [v] = await this.db
      .select()
      .from(flowVersions)
      .where(and(eq(flowVersions.flowId, flow.id), eq(flowVersions.version, flow.publishedVersion)))
      .limit(1)
    if (!v) throw new FlowEngineError('flow_not_published', 'Fluxo sem versão publicada')
    return v
  }

  private async loadDefinition(tx: Tx, versionId: string | null): Promise<FlowDefinition> {
    if (!versionId) throw new Error('run sem versão')
    const [v] = await tx.select({ definition: flowVersions.definition }).from(flowVersions).where(eq(flowVersions.id, versionId)).limit(1)
    if (!v) throw new Error('versão do run não encontrada')
    return v.definition as unknown as FlowDefinition
  }

  private async loadContact(tx: Tx, companyId: string, contactId: string): Promise<TemplateContact | null> {
    const [c] = await tx
      .select({ name: contacts.name, phone: contacts.phoneE164, email: contacts.email, createdAt: contacts.createdAt, customFields: contacts.customFields })
      .from(contacts)
      .where(and(eq(contacts.id, contactId), eq(contacts.companyId, companyId)))
      .limit(1)
    if (!c) return null
    return { full_name: c.name, phone_number: c.phone ? c.phone.replace(/^\+/, '') : null, email: c.email, created_at: c.createdAt, custom_fields: c.customFields }
  }

  private async companyTimeZone(tx: Tx, companyId: string): Promise<string | undefined> {
    const [c] = await tx.select({ tz: companies.timeZone }).from(companies).where(eq(companies.id, companyId)).limit(1)
    return c?.tz
  }

  /**
   * Passos na transação do job; efeitos (`saveAction`) commitados na hora por outra conexão, para que um crash
   * depois do efeito não o repita. A trava do run é FOR NO KEY UPDATE: a FK de `flow_run_steps` (KEY SHARE) passa.
   */
  private dbStore(tx: Tx, companyId: string, runId: string): StepStore {
    return {
      findAction: async (key) => {
        const [row] = await this.db
          .select({ result: flowRunSteps.result })
          .from(flowRunSteps)
          .where(and(eq(flowRunSteps.idempotencyKey, key), eq(flowRunSteps.status, 'done')))
          .limit(1)
        return row ? { result: row.result } : null
      },
      saveAction: async (row) => {
        await this.db
          .insert(flowRunSteps)
          .values({ companyId, runId, seq: row.seq, nodeKey: row.nodeKey, actionKey: row.actionKey, status: 'done', idempotencyKey: row.key, result: row.result })
          .onConflictDoNothing({ target: flowRunSteps.idempotencyKey })
      },
      saveStep: async (row) => {
        await tx
          .insert(flowRunSteps)
          .values({
            companyId,
            runId,
            seq: row.seq,
            nodeKey: row.nodeKey,
            actionKey: null,
            status: row.status,
            idempotencyKey: row.key,
            result: { ...row.result, node_type: row.nodeType },
            error: row.error ?? null,
          })
      },
    }
  }
}
