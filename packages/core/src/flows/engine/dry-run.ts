// Dry-run (T25): executa uma FlowDefinition com os MESMOS handlers e o mesmo laço do motor, mas com store em
// memória e um FakeWaGateway próprio. Não grava nada no banco e nunca toca o gateway real.
import { randomUUID } from 'node:crypto'
import type { LlmProvider } from '@crm/ai'
import type { FlowDefinition } from '@crm/shared'
import type { SendGroupRequest, SendRequest } from '@crm/wa-port'
import { FakeWaGateway, type FakeSentMessage } from '@crm/wa-port/testing'
import type { TemplateContact } from '../../templating/render'
import type { StepRecord, StepStore, WaitSpec } from './context'
import { createNodeRegistry, type NodeRegistry } from './registry'
import { MAX_STEPS_PER_JOB, runLoop, type LoopState } from './runner'

export interface DryRunInput {
  definition: FlowDefinition
  contact?: TemplateContact | null
  vars?: Record<string, unknown>
  registry?: NodeRegistry
  llm?: LlmProvider
  maxSteps?: number
  timeZone?: string
  companyId?: string
  now?: () => Date
}

export interface DryRunStep {
  seq: number
  node_key: string
  node_type: string
  status: StepRecord['status']
  handle?: string
  error?: string | null
}

export interface DryRunResult {
  status: 'completed' | 'failed' | 'waiting'
  error?: string
  steps: DryRunStep[]
  /** Mensagens que teriam sido enviadas (FakeWaGateway do dry-run). */
  sent: FakeSentMessage[]
  vars: Record<string, unknown>
  wait?: WaitSpec
}

const DRY_RUN_COMPANY = '00000000-0000-4000-8000-000000000000'

/** FakeWaGateway que aceita qualquer sessão (cria sob demanda, conectada). */
function dryRunGateway(): FakeWaGateway {
  const gw = new FakeWaGateway({ autoConnect: true })
  const ensure = async (sessionId: string) => {
    try {
      await gw.sessions.get(sessionId)
    } catch {
      gw.addSession({ id: sessionId, name: sessionId, state: 'STABLE' })
    }
  }
  const send = gw.send.bind(gw)
  const sendGroup = gw.sendGroup.bind(gw)
  gw.send = async (req: SendRequest) => (await ensure(req.sessionId), send(req))
  gw.sendGroup = async (req: SendGroupRequest) => (await ensure(req.sessionId), sendGroup(req))
  return gw
}

export async function dryRun(input: DryRunInput): Promise<DryRunResult> {
  const gateway = dryRunGateway()
  const steps: DryRunStep[] = []
  const actions = new Map<string, unknown>()
  const store: StepStore = {
    findAction: async (key) => (actions.has(key) ? { result: actions.get(key) } : null),
    saveAction: async (row) => {
      actions.set(row.key, row.result)
    },
    saveStep: async (row) => {
      steps.push({ seq: row.seq, node_key: row.nodeKey, node_type: row.nodeType, status: row.status, handle: row.result.handle, error: row.error ?? null })
    },
  }
  const companyId = input.companyId ?? DRY_RUN_COMPANY
  const state: LoopState = {
    runId: `dry-${randomUUID()}`,
    companyId,
    flowId: 'dry-run',
    contactId: null,
    chatId: null,
    seq: 0,
    currentNodeKey: input.definition.entry,
    vars: { ...(input.vars ?? {}) },
    definition: input.definition,
    contact: input.contact ?? null,
    timeZone: input.timeZone,
  }
  const loop = await runLoop(state, {
    registry: input.registry ?? createNodeRegistry(),
    wa: gateway,
    llm: input.llm,
    log: { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined },
    store,
    repo: { companyId, db: null, dryRun: true },
    maxSteps: input.maxSteps ?? MAX_STEPS_PER_JOB,
    now: input.now,
  })
  return {
    status: loop.status,
    ...(loop.error ? { error: loop.error } : {}),
    steps,
    sent: [...gateway.sent],
    vars: state.vars,
    ...(loop.wait ? { wait: loop.wait } : {}),
  }
}
