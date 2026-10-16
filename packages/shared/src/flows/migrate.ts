import { FLOW_SCHEMA_VERSION, type FlowDefinition, type FlowNode } from './definition'
import { menuOptionIds, normalizeLegacyHandle } from './handles'
import { isNodeType, UNSUPPORTED_NODE } from './nodes'

// Atualiza definições antigas/importadas para o formato atual (`crm.flow/v1`). Determinístico e idempotente:
// num fluxo já atualizado devolve uma cópia igual. Nunca altera o objeto recebido.

type Loose = Record<string, unknown>

const LEGACY_ACTIONS: Readonly<Record<string, string>> = { send_option_list: 'send_interactive_menu' }
const MENU_ACTIONS = new Set(['send_interactive_menu', 'send_option_list'])

export function migrate(input: unknown): FlowDefinition {
  const def = JSON.parse(JSON.stringify(input ?? {})) as Loose
  if (def.schema === undefined) def.schema = FLOW_SCHEMA_VERSION
  if (!Array.isArray(def.nodes)) def.nodes = []
  if (!Array.isArray(def.edges)) def.edges = []
  if (def.variables === undefined) def.variables = []
  if (def.refs === undefined) def.refs = {}

  const optionIdsByNode = new Map<string, string[]>()
  for (const node of def.nodes as FlowNode[]) {
    migrateNode(node)
    if (node.type === 'interactive_menu') optionIdsByNode.set(node.id, menuOptionIds(node))
  }
  for (const edge of def.edges as Array<{ from: string; handle: string }>) {
    if (typeof edge.handle === 'string') edge.handle = normalizeLegacyHandle(edge.handle, optionIdsByNode.get(edge.from) ?? [])
  }
  return def as FlowDefinition
}

function migrateNode(node: FlowNode) {
  if (!Array.isArray(node.actions)) node.actions = []
  if (node.type === 'menu') {
    // Menu legado → Menu interativo, com a mesma config e as mesmas conexões ("Copiar para bloco Menu").
    node.type = 'interactive_menu'
    for (const action of node.actions) action.type = LEGACY_ACTIONS[action.type] ?? action.type
  }
  if (node.type !== UNSUPPORTED_NODE && !isNodeType(node.type)) {
    node.original_type = node.type
    node.type = UNSUPPORTED_NODE
    return
  }
  if (node.type === 'interactive_menu') {
    for (const action of node.actions) if (MENU_ACTIONS.has(action.type)) assignOptionIds(action.config)
  }
}

/** Opções sem id recebem `option_<n>` (posição 1-based), sem colidir com ids existentes. O id passa a ser estável. */
function assignOptionIds(config: Loose | undefined) {
  if (!config || !Array.isArray(config.options)) return
  const options = config.options as Loose[]
  const taken = new Set(options.map((o) => o?.id).filter((v): v is string => typeof v === 'string' && v.length > 0))
  options.forEach((option, i) => {
    if (!option || typeof option !== 'object' || (typeof option.id === 'string' && option.id)) return
    let id = `option_${i + 1}`
    for (let n = 2; taken.has(id); n++) id = `option_${i + 1}_${n}`
    taken.add(id)
    option.id = id
  })
}
