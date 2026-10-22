// Ferramentas MCP de fluxos (via API do CRM): catálogo de blocos (local), leitura do rascunho, criação e edição (grafo
// inteiro ou nó a nó), validação, simulação, ativação/pausa/arquivo, execuções e funil por bloco.
import { z } from 'zod'
import { FLOW_RUN_STATUSES } from '@crm/db'
import {
  ACTION_CONFIG_SCHEMAS,
  ACTION_EXAMPLES,
  FLOW_SCHEMA_VERSION,
  isNodeType,
  NODE_ACTIONS,
  NODE_TYPES,
  nodeHandles,
  type FlowDefinition,
  type FlowNode,
  type NodeType,
} from '@crm/shared/flows'
import { compact, fail, fromApi, page, text, tool, UUID, type ToolSpec } from './shared'
import type { ZodRawShape } from 'zod'

const flowId = UUID.describe('id do fluxo')
const key = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/).describe('id curto (letras, números, _ ou -)')
const position = z.object({ x: z.number(), y: z.number() }).describe('posição no editor, em px')
const config = z.record(z.string(), z.unknown()).describe('config da ação (veja get_flow_block_catalog com node_type)')
const action = z.object({ id: key.optional(), type: z.string().min(1).max(64), order: z.number().int().min(0).optional(), config })

const p = (id: string) => `/api/flows/${encodeURIComponent(id)}`

const DEFINITION_HELP = `FlowDefinition "${FLOW_SCHEMA_VERSION}": { schema: "${FLOW_SCHEMA_VERSION}", entry: <id do nó start>, nodes: [{ id, type, name, description?, position: {x,y}, actions: [{ id, type, order, config }] }], edges: [{ id, from: <id do nó>, handle, to: <id do nó> }], variables: [{ name, description?, default? }], refs: {} }. Handles de saída: "source" (saída padrão), "option:<id da opção>" (menus/botões), "timeout", "other", "failure", "success", "output:<chave>" (ex.: pagamento "output:charge_created" / "output:payment_approved"). Cada nó aceita só as ações do seu tipo e só os handles listados por get_flow_block_catalog/get_flow.`

type Example = Record<string, unknown>

function configSchema(type: string): unknown {
  const schema = (ACTION_CONFIG_SCHEMAS as Record<string, z.ZodType>)[type]
  if (!schema) return null
  try {
    return z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' })
  } catch {
    return null
  }
}

/** Nó de exemplo do tipo (ações com config de exemplo), para calcular os handles. */
function sampleNode(type: NodeType): Pick<FlowNode, 'type' | 'actions'> {
  return {
    type,
    actions: NODE_ACTIONS[type].slice(0, 1).map((a, i) => ({ id: `a${i}`, type: a, order: i, config: (ACTION_EXAMPLES as Record<string, Example>)[a] ?? {} })),
  }
}

export function blockCatalog(nodeType?: string) {
  if (nodeType === undefined)
    return {
      schema: FLOW_SCHEMA_VERSION,
      definition_format: DEFINITION_HELP,
      node_types: NODE_TYPES.map((t) => ({ type: t, actions: NODE_ACTIONS[t], handles: nodeHandles(sampleNode(t)) })),
      hint: 'Chame de novo com node_type para ver config de exemplo e JSON Schema de cada ação.',
    }
  if (!isNodeType(nodeType)) return null
  return {
    type: nodeType,
    handles: nodeHandles(sampleNode(nodeType)),
    actions: NODE_ACTIONS[nodeType].map((a) => ({ type: a, example_config: (ACTION_EXAMPLES as Record<string, Example>)[a] ?? {}, config_schema: configSchema(a) })),
  }
}

/** Handles válidos de cada nó do rascunho, para o modelo conectar sem chutar. */
function withHandles(def: FlowDefinition) {
  return { ...def, nodes: def.nodes.map((n) => ({ ...n, handles: isNodeType(n.type) ? nodeHandles(n) : [] })) }
}

export const flowsTools: readonly ToolSpec<ZodRawShape>[] = [
  tool({
    name: 'get_flow_block_catalog',
    title: 'Catálogo de blocos de fluxo',
    description: `Tipos de bloco (nó) do editor de fluxos, ações aceitas por tipo e handles de saída. Com node_type: config de exemplo e JSON Schema de cada ação. Use antes de criar ou editar nós. ${DEFINITION_HELP}`,
    input: { node_type: z.string().max(64).optional().describe('tipo de nó (ex.: message, menu, payment, pixel)') },
    perm: 'flows.view',
    run: async ({ node_type }) => {
      const cat = blockCatalog(node_type)
      return cat ? text(cat) : fail({ error: 'unknown_node_type', node_types: NODE_TYPES })
    },
  }),
  tool({
    name: 'get_flow',
    title: 'Ver fluxo',
    description: 'Fluxo (nome, status, versão publicada) e o rascunho completo (FlowDefinition), com os handles válidos de cada nó.',
    input: { id: flowId },
    perm: 'flows.view',
    run: async ({ id }, api) => {
      const res = await api.request('GET', `${p(id)}/editor-bundle`)
      if (res.status !== 200) return fromApi(res)
      const body = res.body as { flow: unknown; definition: FlowDefinition }
      return text({ flow: body.flow, definition: withHandles(body.definition) })
    },
  }),
  tool({
    name: 'validate_flow',
    title: 'Validar fluxo',
    description: 'Valida o rascunho como na ativação: { valid, errors[] } com código, mensagem e nó de cada erro. Não altera nada.',
    input: { id: flowId },
    perm: 'flows.view',
    run: async ({ id }, api) => fromApi(await api.request('POST', `${p(id)}/validate`)),
  }),
  tool({
    name: 'simulate_flow',
    title: 'Simular fluxo',
    description:
      'Roda o rascunho em modo de teste (nada é enviado nem gravado) e devolve a transcrição, o caminho e a espera atual. Para continuar uma espera, passe resume com o node_key e o handle escolhido (e text para resposta digitada), além de vars e steps_so_far devolvidos pela simulação anterior.',
    input: {
      id: flowId,
      resume: z.object({ node_key: z.string().min(1).max(128), handle: z.string().min(1).max(200), text: z.string().max(4000).optional() }).optional(),
      vars: z.record(z.string(), z.unknown()).optional().describe('variáveis do contato/run'),
      steps_so_far: z.number().int().min(0).max(10_000).optional(),
    },
    perm: 'flows.view',
    run: async ({ id, ...body }, api) => fromApi(await api.request('POST', `${p(id)}/simulate`, { body: compact(body) })),
  }),
  tool({
    name: 'get_flow_deletion_impact',
    title: 'Impacto de excluir fluxo',
    description: 'Configurações (conexões, horários) que usam o fluxo e seriam afetadas pela exclusão.',
    input: { id: flowId },
    perm: 'flows.view',
    run: async ({ id }, api) => fromApi(await api.request('GET', `${p(id)}/deletion-impact`)),
  }),
  tool({
    name: 'list_flow_runs',
    title: 'Listar execuções do fluxo',
    description: 'Execuções (runs) do fluxo, mais recentes primeiro: contato, chat, status, nó atual, erro e datas.',
    input: {
      id: flowId,
      status: z.enum(FLOW_RUN_STATUSES).optional(),
      ...page,
    },
    perm: 'flows.view',
    run: async ({ id, ...query }, api) => fromApi(await api.request('GET', `${p(id)}/runs`, { query })),
  }),
  tool({
    name: 'get_flow_run',
    title: 'Ver execução',
    description: 'Uma execução com todos os passos (nó, ação, status, resultado, erro), em ordem.',
    input: { run_id: UUID.describe('id da execução') },
    perm: 'flows.view',
    run: async ({ run_id }, api) => fromApi(await api.request('GET', `/api/flow-runs/${encodeURIComponent(run_id)}`)),
  }),
  tool({
    name: 'get_flow_funnel',
    title: 'Funil do fluxo',
    description:
      'Funil por bloco no período (padrão: últimos 30 dias, máx. 366): runs iniciados, concluídos, com falha, cancelados e ativos, conversão (concluídos/iniciados) e, por nó do rascunho, quantos runs entraram, quantos pararam ali (por status) e a taxa de abandono. removed_nodes: nós que não existem mais no rascunho.',
    input: {
      id: flowId,
      from: z.iso.datetime({ offset: true }).optional().describe('início (ISO 8601)'),
      to: z.iso.datetime({ offset: true }).optional().describe('fim (ISO 8601)'),
      connection_id: UUID.optional().describe('só runs de chats desta conexão'),
    },
    perm: 'flows.view',
    run: async ({ id, ...query }, api) => fromApi(await api.request('GET', `${p(id)}/funnel`, { query })),
  }),

  // ---------------------------------------------------------------- escrita
  tool({
    name: 'create_flow',
    title: 'Criar fluxo',
    description: 'Cria um fluxo em rascunho (já com o nó start). Depois monte o grafo com save_flow_definition ou add_flow_node/connect_nodes.',
    input: { name: z.string().trim().min(1).max(120).optional(), description: z.string().max(2000).nullish(), folder_id: UUID.nullish() },
    perm: 'flows.edit',
    kind: 'write',
    run: async (body, api) => fromApi(await api.request('POST', '/api/flows', { body: compact(body) })),
  }),
  tool({
    name: 'update_flow',
    title: 'Editar fluxo',
    description: 'Muda nome e/ou descrição; com folder_id (ou null para a raiz) move o fluxo de pasta.',
    input: { id: flowId, name: z.string().trim().min(1).max(120).optional(), description: z.string().max(2000).nullish(), folder_id: UUID.nullish() },
    perm: 'flows.edit',
    kind: 'write',
    run: async ({ id, folder_id, ...patch }, api) => {
      let res = null
      if (patch.name !== undefined || patch.description !== undefined) {
        res = await api.request('PATCH', p(id), { body: compact(patch) })
        if (res.status !== 200) return fromApi(res)
      }
      if (folder_id !== undefined) res = await api.request('POST', `${p(id)}/move`, { body: { folder_id } })
      return res ? fromApi(res) : fail({ error: 'nothing_to_update' })
    },
  }),
  tool({
    name: 'duplicate_flow',
    title: 'Duplicar fluxo',
    description: 'Cria uma cópia em rascunho do fluxo ("<nome> (cópia)"), com o mesmo grafo.',
    input: { id: flowId },
    perm: 'flows.edit',
    kind: 'write',
    run: async ({ id }, api) => fromApi(await api.request('POST', `${p(id)}/duplicate`)),
  }),
  tool({
    name: 'delete_flow',
    title: 'Excluir fluxo',
    description:
      'Exclui o fluxo e suas execuções. Se configurações usam o fluxo, a API recusa (409 com a lista); force=true desvincula essas configurações e exclui. Confira get_flow_deletion_impact antes.',
    input: { id: flowId, force: z.boolean().optional() },
    perm: 'flows.delete',
    kind: 'destructive',
    run: async ({ id, force }, api) => fromApi(await api.request('DELETE', p(id), { query: force ? { force: 1 } : {} })),
  }),
  tool({
    name: 'save_flow_definition',
    title: 'Salvar grafo do fluxo',
    description: `Substitui TODO o rascunho do fluxo pela definição enviada (nós, ações, arestas, entry, variáveis). Confere só a estrutura; rode validate_flow depois. ${DEFINITION_HELP}`,
    input: {
      id: flowId,
      definition: z
        .object({
          schema: z.literal(FLOW_SCHEMA_VERSION).optional(),
          entry: z.string().min(1),
          nodes: z.array(z.record(z.string(), z.unknown())),
          edges: z.array(z.record(z.string(), z.unknown())),
          variables: z.array(z.record(z.string(), z.unknown())).optional(),
          refs: z.record(z.string(), z.unknown()).optional(),
        })
        .passthrough(),
    },
    perm: 'flows.edit',
    kind: 'write',
    run: async ({ id, definition }, api) =>
      fromApi(await api.request('PUT', `${p(id)}/definition`, { body: { variables: [], refs: {}, ...definition, schema: FLOW_SCHEMA_VERSION } })),
  }),
  tool({
    name: 'add_flow_node',
    title: 'Adicionar bloco',
    description: 'Adiciona um nó ao rascunho, com ações opcionais. Conecte-o com connect_nodes.',
    input: {
      id: flowId,
      node_id: key.optional().describe('id do nó (gerado se omitido)'),
      type: z.string().min(1).max(64).describe('tipo do nó (get_flow_block_catalog)'),
      name: z.string().max(120).optional(),
      description: z.string().max(2000).nullish(),
      position,
      actions: z.array(action).max(50).optional(),
    },
    perm: 'flows.edit',
    kind: 'write',
    run: async ({ id, node_id, ...node }, api) => fromApi(await api.request('POST', `${p(id)}/nodes`, { body: compact({ ...node, id: node_id }) })),
  }),
  tool({
    name: 'update_flow_node',
    title: 'Editar bloco',
    description: 'Muda nome, descrição, posição ou tipo de um nó.',
    input: { id: flowId, node_id: key, name: z.string().max(120).optional(), description: z.string().max(2000).nullish(), position: position.optional(), type: z.string().min(1).max(64).optional() },
    perm: 'flows.edit',
    kind: 'write',
    run: async ({ id, node_id, ...patch }, api) => fromApi(await api.request('PATCH', `${p(id)}/nodes/${encodeURIComponent(node_id)}`, { body: compact(patch) })),
  }),
  tool({
    name: 'delete_flow_node',
    title: 'Remover bloco',
    description: 'Remove um nó e as conexões ligadas a ele.',
    input: { id: flowId, node_id: key },
    perm: 'flows.edit',
    kind: 'destructive',
    run: async ({ id, node_id }, api) => fromApi(await api.request('DELETE', `${p(id)}/nodes/${encodeURIComponent(node_id)}`)),
  }),
  tool({
    name: 'add_node_action',
    title: 'Adicionar ação ao bloco',
    description: 'Adiciona uma ação a um nó (o tipo precisa ser aceito pelo tipo do nó).',
    input: { id: flowId, node_id: key, action_id: key.optional(), type: z.string().min(1).max(64), order: z.number().int().min(0).optional(), config },
    perm: 'flows.edit',
    kind: 'write',
    run: async ({ id, node_id, action_id, ...a }, api) =>
      fromApi(await api.request('POST', `${p(id)}/nodes/${encodeURIComponent(node_id)}/actions`, { body: compact({ ...a, id: action_id }) })),
  }),
  tool({
    name: 'update_node_action',
    title: 'Editar ação do bloco',
    description: 'Muda tipo, ordem ou config de uma ação (config substitui a anterior inteira).',
    input: { id: flowId, node_id: key, action_id: key, type: z.string().min(1).max(64).optional(), order: z.number().int().min(0).optional(), config: config.optional() },
    perm: 'flows.edit',
    kind: 'write',
    run: async ({ id, node_id, action_id, ...patch }, api) =>
      fromApi(await api.request('PATCH', `${p(id)}/nodes/${encodeURIComponent(node_id)}/actions/${encodeURIComponent(action_id)}`, { body: compact(patch) })),
  }),
  tool({
    name: 'delete_node_action',
    title: 'Remover ação do bloco',
    description: 'Remove uma ação de um nó.',
    input: { id: flowId, node_id: key, action_id: key },
    perm: 'flows.edit',
    kind: 'destructive',
    run: async ({ id, node_id, action_id }, api) =>
      fromApi(await api.request('DELETE', `${p(id)}/nodes/${encodeURIComponent(node_id)}/actions/${encodeURIComponent(action_id)}`)),
  }),
  tool({
    name: 'connect_nodes',
    title: 'Conectar blocos',
    description: 'Liga a saída (handle) de um nó a outro nó. Uma saída tem um destino só: conectar de novo substitui a conexão anterior.',
    input: { id: flowId, from: key.describe('nó de origem'), handle: z.string().min(1).max(130).describe('saída: source, option:<id>, timeout, other, failure, success, output:<chave>'), to: key.describe('nó de destino'), edge_id: key.optional() },
    perm: 'flows.edit',
    kind: 'write',
    run: async ({ id, edge_id, ...edge }, api) => fromApi(await api.request('POST', `${p(id)}/connections`, { body: compact({ ...edge, id: edge_id }) })),
  }),
  tool({
    name: 'disconnect_nodes',
    title: 'Desconectar blocos',
    description: 'Remove uma conexão (aresta) pelo id (veja edges em get_flow).',
    input: { id: flowId, edge_id: key },
    perm: 'flows.edit',
    kind: 'destructive',
    run: async ({ id, edge_id }, api) => fromApi(await api.request('DELETE', `${p(id)}/connections/${encodeURIComponent(edge_id)}`)),
  }),
  tool({
    name: 'activate_flow',
    title: 'Ativar fluxo',
    description: 'Valida o rascunho, publica como nova versão e ativa (retoma execuções pausadas). Com erros, recusa e devolve a lista.',
    input: { id: flowId },
    perm: 'flows.edit',
    kind: 'write',
    run: async ({ id }, api) => fromApi(await api.request('POST', `${p(id)}/activate`)),
  }),
  tool({
    name: 'pause_flow',
    title: 'Pausar fluxo',
    description: 'Pausa o fluxo: novas execuções param de começar e as que esperam ficam congeladas até reativar.',
    input: { id: flowId },
    perm: 'flows.edit',
    kind: 'write',
    run: async ({ id }, api) => fromApi(await api.request('POST', `${p(id)}/pause`)),
  }),
  tool({
    name: 'archive_flow',
    title: 'Arquivar fluxo',
    description: 'Arquiva o fluxo (sai da lista principal).',
    input: { id: flowId },
    perm: 'flows.edit',
    kind: 'write',
    run: async ({ id }, api) => fromApi(await api.request('POST', `${p(id)}/archive`)),
  }),
  tool({
    name: 'unarchive_flow',
    title: 'Desarquivar fluxo',
    description: 'Tira do arquivo (volta pausado se já foi publicado, senão rascunho).',
    input: { id: flowId },
    perm: 'flows.edit',
    kind: 'write',
    run: async ({ id }, api) => fromApi(await api.request('POST', `${p(id)}/unarchive`)),
  }),
  tool({
    name: 'trigger_flow',
    title: 'Disparar fluxo no chat',
    description: 'Inicia o fluxo ATIVO para o contato de um chat, agora. Cancela a execução ativa anterior desse contato. Envia mensagens reais.',
    input: { id: flowId, chat_id: UUID.describe('id do chat') },
    perm: 'flows.run',
    kind: 'write',
    run: async ({ id, chat_id }, api) => fromApi(await api.request('POST', `${p(id)}/trigger`, { body: { chat_id } })),
  }),
  tool({
    name: 'cancel_flow_run',
    title: 'Cancelar execução',
    description: 'Cancela uma execução em andamento ou em espera.',
    input: { run_id: UUID },
    perm: 'flows.run',
    kind: 'write',
    run: async ({ run_id }, api) => fromApi(await api.request('POST', `/api/flow-runs/${encodeURIComponent(run_id)}/cancel`)),
  }),
]
