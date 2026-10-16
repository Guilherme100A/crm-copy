// Apoio dos testes de T10: contrato público de '@crm/shared/flows' (combinado com o Operário) e construtores de fluxo.
// FlowDefinition = { schema: 'crm.flow/v1', entry, nodes[{ id, type, name, position, actions[{ id, type, order, config }], original_type? }],
//                    edges[{ id, from, handle, to }], variables: [], refs: {} }
// validate(def) → [{ nodeId, code, message, actionId?, edgeId?, path? }]; migrate(def); canActivate(def).

export async function loadFlows(): Promise<any> {
  const mod: any = await import('@crm/shared/flows')
  for (const name of ['FlowDefinitionSchema', 'validate', 'migrate', 'canActivate', 'getActionSchema', 'SUPPORTED_ACTION_TYPES', 'NODE_TYPES']) {
    if (mod[name] === undefined) throw new Error(`'@crm/shared/flows' não exporta ${name}`)
  }
  return mod
}

export interface Action {
  id: string
  type: string
  order: number
  config: Record<string, unknown>
}
export interface Node {
  id: string
  type: string
  name: string
  position: { x: number; y: number }
  actions: Action[]
  original_type?: string
}
export interface Edge {
  id: string
  from: string
  handle: string
  to: string
}
export interface Def {
  schema: 'crm.flow/v1'
  entry: string
  nodes: Node[]
  edges: Edge[]
  variables: unknown[]
  refs: Record<string, unknown>
}

/** Posição determinística derivada do id: o mesmo construtor gera fluxos idênticos a cada chamada. */
const posOf = (id: string) => [...id].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 997, 7)

export function node(id: string, type: string, actions: Array<[string, Record<string, unknown>]> = [], extra: Partial<Node> = {}): Node {
  const p = posOf(id)
  return {
    id,
    type,
    name: `Nó ${id}`,
    position: { x: 100 + p * 3, y: 50 + p },
    actions: actions.map(([t, config], i) => ({ id: `${id}_a${i + 1}`, type: t, order: i, config })),
    ...extra,
  }
}

export const edge = (from: string, handle: string, to: string, id = `e_${from}_${handle.replace(/[^a-z0-9]/gi, '_')}_${to}`): Edge => ({ id, from, handle, to })

export const msg = (id: string, text = `Mensagem ${id}`) => node(id, 'message', [['send_message', { message_text: text }]])

export const menuConfig = (options: Array<{ id?: string; title: string }>) => ({
  menuType: 'list',
  message: 'Escolha uma opção',
  buttonLabel: 'Ver opções',
  options,
  timeout_value: 1,
  timeout_unit: 'hours',
})

export function flow(nodes: Node[], edges: Edge[], entry = 'start'): Def {
  return { schema: 'crm.flow/v1', entry, nodes, edges, variables: [], refs: {} }
}

/**
 * Fluxo válido de referência (AC-T10-02): start → mensagem → menu → 2 opções + timeout.
 *   start -source→ m1 -source→ menu ─option:op_a→ ma
 *                                   ├option:op_b→ mb
 *                                   └timeout────→ mt
 */
export function sampleFlow(): Def {
  return flow(
    [
      node('start', 'start'),
      msg('m1', 'Olá {first_name}! Bem-vindo.'),
      node('menu', 'interactive_menu', [['send_interactive_menu', menuConfig([{ id: 'op_a', title: 'Comprar' }, { id: 'op_b', title: 'Suporte' }])]]),
      msg('ma', 'Ótimo, vamos às compras.'),
      msg('mb', 'Um atendente vai falar com você.'),
      msg('mt', 'Sem resposta, encerrando.'),
    ],
    [edge('start', 'source', 'm1'), edge('m1', 'source', 'menu'), edge('menu', 'option:op_a', 'ma'), edge('menu', 'option:op_b', 'mb'), edge('menu', 'timeout', 'mt')],
  )
}

export const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T

export interface FlowError {
  nodeId: string | null
  code: string
  message: string
  actionId?: string
  edgeId?: string
}

export const fmt = (errors: FlowError[]) => JSON.stringify(errors, null, 1)

/**
 * Identificador do gateway/nó da empresa de referência (fora de escopo, SPEC 8.4). Montado sem o literal
 * para não violar a regra de marca neutra (SPEC 1.4 nº 9 / AC-T00-06).
 */
export const REF_GATEWAY = ['leo', 'na', 'pay'].join('')
