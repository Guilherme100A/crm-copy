// Simulador de fluxos (T82; 06 §4.4, §5.6): roda o RASCUNHO no dry-run do motor (mesmo laço e mesmos handlers de
// mensagem/interativos/intervalo), com um registry próprio que NUNCA chama a rede nem o banco:
// - escolha (o usuário decide o handle): condição, distribuidor, integração HTTP e bloco de IA;
// - "ainda não é simulado. Seguindo.": nós de CRM, pixel, pagamento e `unsupported`;
// - conexão de fluxo: avisa o fluxo de destino e encerra.
// Protocolo stateless: a resposta em espera devolve `wait.node_key` e as `choices`; o cliente reenvia
// `{ resume: { node_key, handle, text? }, vars, steps_so_far }` e o simulador segue a aresta (nó, handle) sem reexecutar o
// nó. O limite de 50 passos (`loop_guard` do motor) vale para o caminho inteiro (`steps_so_far` acumulado).
import {
  LOOP_GUARD_ERROR,
  MAX_STEPS_PER_JOB,
  createNodeRegistry,
  dryRun,
  interactiveHandlers,
  logicHandlers,
  messagingHandlers,
  type DryRunResult,
  type NodeContext,
  type NodeHandler,
  type NodeRegistry,
} from '@crm/core'
import { handle, nodeHandles, PAYMENT_OUTPUTS, type FlowDefinition, type FlowNode } from '@crm/shared/flows'
import type { OutgoingContent, SendRequest } from '@crm/wa-port'

export const SIMULATOR_MAX_STEPS = MAX_STEPS_PER_JOB

/** Tipos de espera do simulador (06 §4.4). */
export type SimWaitKind =
  | 'wait_response'
  | 'menu'
  | 'carousel'
  | 'smart_interval'
  | 'condition_choice'
  | 'distributor'
  | 'ai_choice'
  | 'integration_choice'

/** Nós que viram escolha do usuário (sem rede, sem banco). */
export const CHOICE_NODES = {
  condition: 'condition_choice',
  distributor: 'distributor',
  integration: 'integration_choice',
  ai: 'ai_choice',
} as const
/** Nós que só seguem em frente com o aviso "ainda não é simulado". */
export const NOT_SIMULATED_NODES = [
  'tags',
  'kanban',
  'department',
  'chat_controller',
  'manipulator',
  'approved_sale',
  'ai_agent',
  'pixel',
  'payment',
  'unsupported',
] as const

const WAIT_KIND: Record<string, SimWaitKind> = {
  wait_response: 'wait_response',
  interactive_menu: 'menu',
  menu: 'menu',
  carousel: 'carousel',
  smart_interval: 'smart_interval',
  ...CHOICE_NODES,
}

export type SimMessage = {
  /** Passo (`seq`) que enviou: ordena a conversa junto dos avisos. */
  seq: number
  node_key: string
  /** `contact` = o lead; `internal` = outro número (nó Notificação). */
  to: 'contact' | 'internal'
} & (
  | { kind: 'text'; text: string }
  | { kind: 'image' | 'video' | 'audio' | 'sticker'; url: string; caption?: string }
  | { kind: 'document'; url: string; file_name?: string; caption?: string }
  | { kind: 'contact'; name: string }
  | { kind: 'location'; name?: string; latitude: number; longitude: number }
  | { kind: 'react' | 'delete' }
)

export type SimNotice =
  | { code: 'not_simulated'; seq: number; node_key: string; node_type: string }
  | { code: 'jump_flow'; seq: number; node_key: string; target_flow_id: string }

export interface SimChoice {
  handle: string
  /** Rótulo vindo da config (título da opção, nome da saída); os handles fixos são traduzidos no cliente. */
  label?: string
  /** Existe aresta para este handle (sem ela o caminho termina). */
  connected: boolean
}

export interface SimStep {
  seq: number
  node_key: string
  node_type: string
  status: 'done' | 'failed'
  handle?: string
  error?: string | null
}

export type SimEndReason = 'completed' | 'no_start' | 'no_next' | 'failed' | 'loop_guard' | 'jump_flow'

export interface SimulationResult {
  status: 'waiting' | 'finished'
  steps: SimStep[]
  messages: SimMessage[]
  notices: SimNotice[]
  vars: Record<string, unknown>
  /** Passos do caminho inteiro (reenvie como `steps_so_far`). */
  steps_total: number
  wait?: { node_key: string; node_type: string; kind: SimWaitKind; choices: SimChoice[] }
  end?: { reason: SimEndReason; node_key?: string; handle?: string; error?: string }
  /** `loop_guard` quando o caminho passou de 50 passos (AC-T82-03). */
  interrupted?: typeof LOOP_GUARD_ERROR
}

export interface SimulateInput {
  resume?: { node_key: string; handle: string; text?: string }
  vars?: Record<string, unknown>
  steps_so_far?: number
}

export class SimulateError extends Error {
  constructor(
    readonly code: 'unknown_node' | 'invalid_handle',
    message: string,
  ) {
    super(message)
    this.name = 'SimulateError'
  }
}

type Config = Record<string, unknown>
const configOf = (node: Pick<FlowNode, 'actions'>, ...types: string[]): Config =>
  (node.actions.find((a) => types.includes(a.type))?.config ?? {}) as Config
const list = (v: unknown): Config[] =>
  Array.isArray(v) ? v.filter((x): x is Config => !!x && typeof x === 'object') : []
const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined)
const noSleep = async () => undefined

/** Rótulos de `option:<id>` / `output:<key>` a partir da config do nó. */
function choiceLabels(node: FlowNode): Map<string, string> {
  const labels = new Map<string, string>()
  const put = (h: string, label: unknown) => {
    const l = str(label)
    if (l && !labels.has(h)) labels.set(h, l)
  }
  for (const o of list(configOf(node, 'send_interactive_menu', 'send_option_list').options))
    if (typeof o.id === 'string') put(handle.option(o.id), o.title)
  for (const card of list(configOf(node, 'send_carousel').carousel))
    for (const b of list(card.buttons))
      if (b.type === 'REPLY' && typeof b.id === 'string') put(handle.option(b.id), b.text)
  for (const o of list(configOf(node, 'distribute_contacts').outputs))
    if (typeof o.id === 'string') put(handle.output(o.id), o.name ?? o.id)
  const ai = configOf(node, 'ai_call')
  for (const o of list(ai.output_conditions))
    if (typeof o.output_key === 'string') put(handle.output(o.output_key), o.prompt ?? o.output_key)
  return labels
}

export function choicesOf(node: FlowNode, def: FlowDefinition): SimChoice[] {
  const labels = choiceLabels(node)
  const hasEdge = (h: string) => def.edges.some((e) => e.from === node.id && e.handle === h)
  return nodeHandles(node).map((h) => ({
    handle: h,
    ...(labels.has(h) ? { label: labels.get(h) } : {}),
    connected: hasEdge(h),
  }))
}

const PREFERRED = [
  handle.source,
  handle.success,
  handle.output(PAYMENT_OUTPUTS.chargeCreated),
  handle.output(PAYMENT_OUTPUTS.paymentApproved),
]

/** Handle seguido por um nó não simulado: o primeiro ligado na ordem de preferência (nunca `failure`). */
export function passThroughHandle(node: FlowNode, def: FlowDefinition): string {
  const hs = nodeHandles(node).filter((h) => h !== handle.failure)
  const ordered = [...PREFERRED.filter((h) => hs.includes(h)), ...hs.filter((h) => !PREFERRED.includes(h))]
  return ordered.find((h) => def.edges.some((e) => e.from === node.id && e.handle === h)) ?? ordered[0] ?? handle.source
}

function toMessage(seq: number, nodeKey: string, nodeType: string, req: SendRequest): SimMessage {
  const base = {
    seq,
    node_key: nodeKey,
    to: nodeType === 'notification' ? ('internal' as const) : ('contact' as const),
  }
  const c: OutgoingContent = req.content
  if ('text' in c) return { ...base, kind: 'text', text: c.text }
  if ('image' in c) return { ...base, kind: 'image', url: c.image.url, ...(c.caption ? { caption: c.caption } : {}) }
  if ('video' in c) return { ...base, kind: 'video', url: c.video.url, ...(c.caption ? { caption: c.caption } : {}) }
  if ('audio' in c) return { ...base, kind: 'audio', url: c.audio.url }
  if ('sticker' in c) return { ...base, kind: 'sticker', url: c.sticker.url }
  if ('document' in c)
    return {
      ...base,
      kind: 'document',
      url: c.document.url,
      ...(c.fileName ? { file_name: c.fileName } : {}),
      ...(c.caption ? { caption: c.caption } : {}),
    }
  if ('contact' in c) return { ...base, kind: 'contact', name: c.contact.displayName }
  if ('location' in c)
    return {
      ...base,
      kind: 'location',
      latitude: c.location.latitude,
      longitude: c.location.longitude,
      ...(c.location.name ? { name: c.location.name } : {}),
    }
  return { ...base, kind: 'react' in c ? 'react' : 'delete' }
}

interface Recorder {
  messages: SimMessage[]
  notices: SimNotice[]
}

/** Intercepta os envios do nó para montar a transcrição (com o nó de origem); o envio segue para o gateway fake. */
function recording(handler: NodeHandler, rec: Recorder): NodeHandler {
  return {
    execute(ctx) {
      const wa = new Proxy(ctx.wa, {
        get(target, prop, receiver) {
          if (prop === 'send')
            return (req: SendRequest, opts?: { actionId?: string }) => {
              rec.messages.push(toMessage(ctx.seq, ctx.node.id, ctx.node.type, req))
              return target.send(req, opts)
            }
          return Reflect.get(target, prop, receiver) as unknown
        },
      })
      return handler.execute({ ...ctx, wa } as NodeContext)
    },
  }
}

/** Espera de escolha: o motor para (`waiting`) e o cliente escolhe um dos handles do nó. */
const choiceHandler: NodeHandler = {
  execute(ctx) {
    if (nodeHandles(ctx.node).length === 0) throw new Error('invalid_config: nó sem saídas')
    return { wait: { kind: 'simulator_choice' } }
  },
}

/**
 * Registry do simulador: o padrão do motor com os grupos que tocam rede/banco trocados. Um por simulação (os avisos e
 * a transcrição ficam no `rec` desta chamada).
 */
export function simulatorRegistry(rec: Recorder): NodeRegistry {
  const registry = createNodeRegistry()
  const real: Record<string, NodeHandler> = {
    ...messagingHandlers({ sleep: noSleep }),
    ...interactiveHandlers({ sleep: noSleep }),
    smart_interval: logicHandlers({ timeZone: async () => 'America/Sao_Paulo' }).smart_interval,
  }
  for (const [type, h] of Object.entries(real)) registry.register(type, recording(h, rec))
  for (const type of Object.keys(CHOICE_NODES)) registry.register(type, choiceHandler)
  for (const type of NOT_SIMULATED_NODES)
    registry.register(type, {
      execute(ctx) {
        rec.notices.push({ code: 'not_simulated', seq: ctx.seq, node_key: ctx.node.id, node_type: ctx.node.type })
        return { next: passThroughHandle(ctx.node, ctx.definition) }
      },
    })
  registry.register('connection_flow', {
    execute(ctx) {
      const target = String((configOf(ctx.node, 'execute_flow').target_flow_id as string | undefined) ?? '').trim()
      if (!target) throw new Error('invalid_config: fluxo de destino não informado')
      rec.notices.push({ code: 'jump_flow', seq: ctx.seq, node_key: ctx.node.id, target_flow_id: target })
      return { end: true }
    },
  })
  return registry
}

/** Variáveis ao seguir uma resposta: limpa a marca de espera do nó e grava a resposta (como o nó faria). */
function answerVars(
  node: FlowNode,
  chosen: string,
  text: string | undefined,
  vars: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...vars, __await: null, __replies: [] }
  if (!(node.type in WAIT_KIND) || chosen === handle.timeout) return out
  const label = choiceLabels(node).get(chosen)
  const reply = text ?? label
  if (reply === undefined) return out
  if (node.type === 'wait_response') {
    out.last_user_message = reply
    out.response = reply
  }
  const field = str(configOf(node, 'save_user_data').field_name)
  if (field && (reply.trim() || configOf(node, 'save_user_data').save_empty === true)) out[field] = reply
  return out
}

/** Nó onde o caminho parou (destino do último passo), para marcar o `loop_guard`. */
function nextNodeOf(def: FlowDefinition, last: SimStep | undefined): string | undefined {
  if (!last?.handle) return undefined
  return def.edges.find((e) => e.from === last.node_key && e.handle === last.handle)?.to
}

export async function simulate(definition: FlowDefinition, input: SimulateInput = {}): Promise<SimulationResult> {
  const before = Math.max(0, input.steps_so_far ?? 0)
  const rec: Recorder = { messages: [], notices: [] }
  const byId = new Map(definition.nodes.map((n) => [n.id, n]))
  let vars = { ...(input.vars ?? {}) }
  let entry: string | undefined = definition.entry

  const finished = (
    end: NonNullable<SimulationResult['end']>,
    extra: Partial<SimulationResult> = {},
  ): SimulationResult => ({
    status: 'finished',
    steps: [],
    messages: [],
    notices: [],
    vars,
    steps_total: before,
    end,
    ...extra,
  })

  if (input.resume) {
    const node = byId.get(input.resume.node_key)
    if (!node) throw new SimulateError('unknown_node', 'nó não encontrado no rascunho')
    if (!nodeHandles(node).includes(input.resume.handle))
      throw new SimulateError('invalid_handle', 'handle não existe neste nó')
    vars = answerVars(node, input.resume.handle, input.resume.text, vars)
    entry = definition.edges.find((e) => e.from === node.id && e.handle === input.resume!.handle)?.to
    if (!entry) return finished({ reason: 'no_next', node_key: node.id, handle: input.resume.handle })
  } else if (!entry || !byId.has(entry)) {
    return finished({ reason: 'no_start' })
  }

  const result: DryRunResult = await dryRun({
    definition: { ...definition, entry },
    vars,
    registry: simulatorRegistry(rec),
    maxSteps: Math.max(0, SIMULATOR_MAX_STEPS - before),
  })
  const steps: SimStep[] = result.steps.map((s) => ({ ...s, seq: before + s.seq }))
  const last = steps.at(-1)
  const shift = <T extends { seq: number }>(xs: T[]) => xs.map((x) => ({ ...x, seq: before + x.seq }))
  const base = {
    steps,
    messages: shift(rec.messages),
    notices: shift(rec.notices),
    vars: result.vars,
    steps_total: before + steps.length,
  }

  if (result.status === 'waiting' && last) {
    const node = byId.get(last.node_key)!
    return {
      status: 'waiting',
      ...base,
      wait: {
        node_key: node.id,
        node_type: node.type,
        kind: WAIT_KIND[node.type] ?? 'wait_response',
        choices: choicesOf(node, definition),
      },
    }
  }
  if (result.error === LOOP_GUARD_ERROR) {
    const at = nextNodeOf(definition, last) ?? entry
    return { status: 'finished', ...base, interrupted: LOOP_GUARD_ERROR, end: { reason: 'loop_guard', node_key: at } }
  }
  if (result.status === 'failed')
    return {
      status: 'finished',
      ...base,
      end: { reason: 'failed', ...(last ? { node_key: last.node_key } : {}), error: result.error },
    }
  const jump = rec.notices.find((n) => n.code === 'jump_flow')
  if (jump && last?.node_key === jump.node_key)
    return { status: 'finished', ...base, end: { reason: 'jump_flow', node_key: jump.node_key } }
  if (last?.handle && !nextNodeOf(definition, last))
    return { status: 'finished', ...base, end: { reason: 'no_next', node_key: last.node_key, handle: last.handle } }
  return { status: 'finished', ...base, end: { reason: 'completed', ...(last ? { node_key: last.node_key } : {}) } }
}
