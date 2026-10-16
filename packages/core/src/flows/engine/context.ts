// Contexto de execução de um nó (T25): o que o `NodeHandler` recebe e o que pode devolver.
// Efeitos externos idempotentes passam por `ctx.once(actionId, fn)` (ou `ctx.wa.send(req, { actionId })`): a chave
// `hash(runId, seq, actionId)` é gravada em `flow_run_steps` assim que o efeito acontece, e o retry do mesmo passo
// devolve o resultado salvo em vez de repetir o efeito.
import { createHash } from 'node:crypto'
import type { LlmProvider } from '@crm/ai'
import type { Logger } from '@crm/node-kit'
import type { FlowDefinition, FlowNode } from '@crm/shared'
import type { SendGroupRequest, SendRequest, WaGateway } from '@crm/wa-port'
import { render, type TemplateContact } from '../../templating/render'

/** Espera (o motor de timers/respostas é da T30): o run fica `waiting` com este estado salvo em `flow_runs.wait`. */
export type WaitSpec = Record<string, unknown>

/** Resultado de um nó. `next` sem aresta para o handle = fim do caminho (run `completed`). */
export type NodeOutcome =
  | { next: string }
  | { wait: WaitSpec }
  | { end: true }
  | { jump: { nodeKey: string } }
  | { jump: { flowId: string } }

export interface NodeHandler {
  execute(ctx: NodeContext): NodeOutcome | Promise<NodeOutcome>
}

/** Executor de SQL do passo (a transação do job no runner real; ausente no dry-run). */
export interface FlowRunRepo {
  companyId: string
  /** Transação do passo (`null` no dry-run: nada é gravado). */
  db: unknown
  dryRun: boolean
}

export interface SendOptions {
  /** Torna o envio idempotente no passo (mesma ação no mesmo `seq` → sem novo envio no retry). */
  actionId?: string
}

/** WaGateway com `send`/`sendGroup` idempotentes por `actionId`. */
export type FlowWa = Omit<WaGateway, 'send' | 'sendGroup'> & {
  send(req: SendRequest, opts?: SendOptions): ReturnType<WaGateway['send']>
  sendGroup(req: SendGroupRequest, opts?: SendOptions): ReturnType<WaGateway['sendGroup']>
}

export interface NodeContext {
  runId: string
  companyId: string
  flowId: string
  contactId: string | null
  chatId: string | null
  /** Sequência deste passo (cada nó executado incrementa o `seq` do run). */
  seq: number
  node: FlowNode
  definition: FlowDefinition
  contact: TemplateContact | null
  /** Variáveis do run (persistidas ao fim do job). */
  vars: Record<string, unknown>
  setVar(name: string, value: unknown): void
  /** Interpola `{variáveis}` com contato, variáveis do run e sistema (T11), no fuso da empresa. */
  render(template: string): string
  wa: FlowWa
  llm?: LlmProvider
  log: Pick<Logger, 'debug' | 'info' | 'warn' | 'error'>
  repo: FlowRunRepo
  /** `hash(runId, seq, actionId)`: chave estável do efeito desta ação neste passo (para APIs externas também). */
  idempotencyKey(actionId: string): string
  /** Executa `fn` uma vez por (passo, ação); no retry devolve o resultado gravado. O resultado precisa ser JSON. */
  once<T>(actionId: string, fn: () => Promise<T>): Promise<T>
}

/** `sha256("<runId>:<seq>:<actionId>")` em hex. */
export function idempotencyKey(runId: string, seq: number, actionId: string): string {
  return createHash('sha256').update(`${runId}:${seq}:${actionId}`, 'utf8').digest('hex')
}

/** Chave da linha do nó em `flow_run_steps` (não colide com a de nenhuma ação). */
export function stepKey(runId: string, seq: number): string {
  return idempotencyKey(runId, seq, '#node')
}

/** Onde o motor lê/grava os efeitos já feitos e os passos (banco no runner, memória no dry-run). */
export interface StepStore {
  findAction(key: string): Promise<{ result: unknown } | null>
  saveAction(row: { key: string; seq: number; nodeKey: string; actionKey: string; result: unknown }): Promise<void>
  saveStep(row: StepRecord): Promise<void>
}

export interface StepRecord {
  key: string
  seq: number
  nodeKey: string
  nodeType: string
  status: 'done' | 'failed'
  result: { outcome: 'next' | 'wait' | 'end' | 'jump' | 'error'; handle?: string; target?: string }
  error?: string | null
}

export interface BuildContextInput {
  runId: string
  companyId: string
  flowId: string
  contactId: string | null
  chatId: string | null
  seq: number
  node: FlowNode
  definition: FlowDefinition
  contact: TemplateContact | null
  vars: Record<string, unknown>
  timeZone?: string
  wa: WaGateway
  llm?: LlmProvider
  log: NodeContext['log']
  repo: FlowRunRepo
  store: StepStore
  now?: () => Date
}

export function buildContext(input: BuildContextInput): NodeContext {
  const { runId, seq, store, node } = input
  const key = (actionId: string) => idempotencyKey(runId, seq, actionId)
  const once = async <T>(actionId: string, fn: () => Promise<T>): Promise<T> => {
    const k = key(actionId)
    const done = await store.findAction(k)
    if (done) return done.result as T
    const result = await fn()
    await store.saveAction({ key: k, seq, nodeKey: node.id, actionKey: actionId, result: toJson(result) })
    return result
  }
  const ctx: NodeContext = {
    runId,
    companyId: input.companyId,
    flowId: input.flowId,
    contactId: input.contactId,
    chatId: input.chatId,
    seq,
    node,
    definition: input.definition,
    contact: input.contact,
    vars: input.vars,
    setVar: (name, value) => {
      input.vars[name] = value
    },
    render: (template) => render(template, { contact: input.contact, vars: input.vars, now: input.now }, { timeZone: input.timeZone }),
    wa: wrapGateway(input.wa, once),
    llm: input.llm,
    log: input.log,
    repo: input.repo,
    idempotencyKey: key,
    once,
  }
  return ctx
}

/** JSON puro (o resultado vai para jsonb): `undefined` vira `null`, datas viram ISO. */
function toJson(value: unknown): unknown {
  return value === undefined ? null : JSON.parse(JSON.stringify(value))
}

function wrapGateway(gateway: WaGateway, once: NodeContext['once']): FlowWa {
  return new Proxy(gateway, {
    get(target, prop) {
      if (prop === 'send')
        return (req: SendRequest, opts?: SendOptions) => (opts?.actionId ? once(opts.actionId, () => target.send(req)) : target.send(req))
      if (prop === 'sendGroup')
        return (req: SendGroupRequest, opts?: SendOptions) => (opts?.actionId ? once(opts.actionId, () => target.sendGroup(req)) : target.sendGroup(req))
      const value = Reflect.get(target, prop, target) as unknown
      return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value
    },
  }) as unknown as FlowWa
}
