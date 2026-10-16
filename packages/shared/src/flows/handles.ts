import type { FlowAction, FlowNode } from './definition'
import { isNodeType, type NodeType } from './nodes'

// Handles de saída normalizados `kind[:id]` (SPEC T10). Os ids vêm da config (opção, saída, botão), nunca da posição.
export const HANDLE_KINDS = ['source', 'option', 'timeout', 'other', 'failure', 'success', 'output'] as const
export type HandleKind = (typeof HANDLE_KINDS)[number]

const WITH_ID: ReadonlySet<HandleKind> = new Set(['option', 'output'])

export const handle = {
  source: 'source',
  timeout: 'timeout',
  other: 'other',
  failure: 'failure',
  success: 'success',
  option: (id: string) => `option:${id}`,
  output: (key: string) => `output:${key}`,
} as const

export interface ParsedHandle {
  kind: HandleKind
  id?: string
}

/** `option:abc` → `{ kind: 'option', id: 'abc' }`; formato inválido → `null`. */
export function parseHandle(value: string): ParsedHandle | null {
  const i = value.indexOf(':')
  const kind = (i < 0 ? value : value.slice(0, i)) as HandleKind
  if (!(HANDLE_KINDS as readonly string[]).includes(kind)) return null
  if (i < 0) return WITH_ID.has(kind) ? null : { kind }
  const id = value.slice(i + 1)
  if (!WITH_ID.has(kind) || !id || /[\s:]/.test(id)) return null
  return { kind, id }
}

// Saídas fixas do Pagamento (06 §3.6): cobrança criada e pagamento aprovado; `error` → `failure`.
export const PAYMENT_OUTPUTS = { chargeCreated: 'charge_created', paymentApproved: 'payment_approved' } as const
// Saídas do comprovante no Bloco de IA, na ordem de prioridade (06 §3.6).
export const AI_RECEIPT_OUTPUTS = ['comprovante', 'comprovante_pix_errada', 'comprovante_nome_errado'] as const

type Config = Record<string, unknown>
const actionOf = (node: Pick<FlowNode, 'actions'>, type: string): FlowAction | undefined => node.actions.find((a) => a.type === type)
const configOf = (node: Pick<FlowNode, 'actions'>, ...types: string[]): Config => {
  for (const t of types) {
    const a = actionOf(node, t)
    if (a) return a.config
  }
  return {}
}
const list = (v: unknown): Config[] => (Array.isArray(v) ? v.filter((x): x is Config => !!x && typeof x === 'object') : [])
const ids = (items: Config[], key = 'id'): string[] => items.map((x) => x[key]).filter((v): v is string => typeof v === 'string' && v.length > 0)
const unique = (xs: string[]) => [...new Set(xs)]

/** Ids das opções do menu na ordem atual da config (só as que já têm id). */
export const menuOptionIds = (node: Pick<FlowNode, 'actions'>) => ids(list(configOf(node, 'send_interactive_menu', 'send_option_list').options))

/** Handles de saída que o nó oferece, derivados do tipo e da config. Reordenar opções não muda o conjunto. */
export function nodeHandles(node: Pick<FlowNode, 'type' | 'actions'>): string[] {
  if (!isNodeType(node.type)) return []
  const type: NodeType = node.type
  switch (type) {
    case 'connection_flow':
      return []
    case 'interactive_menu':
    case 'menu':
      return [...unique(menuOptionIds(node)).map(handle.option), handle.other, handle.timeout]
    case 'carousel': {
      const cards = list(configOf(node, 'send_carousel').carousel)
      const replies = cards.flatMap((c) => list(c.buttons)).filter((b) => b.type === 'REPLY')
      return [...unique(ids(replies)).map(handle.option), handle.other, handle.timeout]
    }
    case 'wait_response':
      return configOf(node, 'wait_for_response').wait_indefinitely === true ? [handle.source] : [handle.source, handle.timeout]
    case 'condition':
    case 'integration':
      return [handle.success, handle.failure]
    // T104: `source` mantém válidos os fluxos já salvos; `success`/`failure` seguem o resultado do envio CAPI.
    case 'pixel':
      return [handle.source, handle.success, handle.failure]
    case 'distributor':
      return unique(ids(list(configOf(node, 'distribute_contacts').outputs))).map(handle.output)
    case 'ai': {
      const c = configOf(node, 'ai_call')
      const conditions = ids(list(c.output_conditions), 'output_key')
      const receipt = c.understand_receipt === true
      if (!receipt && conditions.length === 0) return [handle.success, handle.failure]
      const keys: string[] = []
      if (receipt) {
        keys.push(AI_RECEIPT_OUTPUTS[0])
        if (c.validate_receipt_pix_key === true) keys.push(AI_RECEIPT_OUTPUTS[1])
        if (c.validate_receipt_recipient === true) keys.push(AI_RECEIPT_OUTPUTS[2])
      }
      keys.push(...conditions)
      if (typeof c.fallback_output_key === 'string' && c.fallback_output_key) keys.push(c.fallback_output_key)
      return [...unique(keys).map(handle.output), handle.failure]
    }
    case 'payment':
      return [handle.output(PAYMENT_OUTPUTS.chargeCreated), handle.output(PAYMENT_OUTPUTS.paymentApproved), handle.failure]
    default:
      return [handle.source]
  }
}

/**
 * Handles que só disparam depois de um evento externo (resposta, prazo, webhook).
 * Um ciclo no grafo só é aceito se passar por uma aresta com um desses handles.
 */
export function isWaitingHandle(nodeType: string, value: string): boolean {
  const parsed = parseHandle(value)
  if (!parsed) return false
  switch (nodeType) {
    case 'wait_response':
    case 'interactive_menu':
    case 'menu':
      return true
    case 'carousel':
      // `other` é o fallback que segue logo após o envio, sem esperar.
      return parsed.kind === 'option' || parsed.kind === 'timeout'
    case 'smart_interval':
      return parsed.kind === 'source'
    case 'payment':
      return value === handle.output(PAYMENT_OUTPUTS.paymentApproved)
    default:
      return false
  }
}

/**
 * Converte um handle do editor da referência para o formato normalizado.
 * `option-<i>` (índice) precisa dos ids das opções, por isso recebe `optionIds`.
 */
export function normalizeLegacyHandle(value: string, optionIds: readonly string[] = []): string {
  if (parseHandle(value)) return value
  const m = /^option-(\d+)$/.exec(value)
  if (m) {
    const id = optionIds[Number(m[1])]
    return id ? handle.option(id) : value
  }
  const prefixed: Array<[RegExp, (id: string) => string]> = [
    [/^carousel-reply-(.+)$/, handle.option],
    [/^template-btn-(.+)$/, handle.option],
    [/^output-(.+)$/, handle.output],
  ]
  for (const [re, make] of prefixed) {
    const p = re.exec(value)
    if (p?.[1]) return make(p[1])
  }
  const fixed: Record<string, string> = {
    'menu-other': handle.other,
    'carousel-fallback': handle.other,
    'template-other': handle.other,
    'carousel-timeout': handle.timeout,
    'template-timeout': handle.timeout,
    'client-response': handle.source,
    'template-delivery-failed': handle.failure,
    error: handle.failure,
    charge_created: handle.output(PAYMENT_OUTPUTS.chargeCreated),
    payment_approved: handle.output(PAYMENT_OUTPUTS.paymentApproved),
  }
  return fixed[value] ?? value
}
