import { z } from 'zod'
import { NODE_TYPES, UNSUPPORTED_NODE, UNSUPPORTED_NODE_TYPES } from './nodes'

// FlowDefinition v1: formato versionado e isomórfico dos fluxos (API, motor, editor, importação/exportação).
// O schema só confere a ESTRUTURA e não aplica defaults nem transformações: num fluxo válido, `parse` é a
// identidade (round-trip JSON idêntico). Configs de ação, handles e grafo são conferidos por `validate`.

export const FLOW_SCHEMA_VERSION = 'crm.flow/v1'

const id = z.string().min(1)

export const FlowPositionSchema = z.object({ x: z.number(), y: z.number() })

export const FlowActionSchema = z.object({
  id,
  type: z.string().min(1),
  order: z.number().int().min(0),
  config: z.record(z.string(), z.unknown()),
})

/** Tipos aceitos na estrutura: os suportados, `unsupported` e os fora de escopo crus (o `validate` recusa os dois últimos). */
export const FLOW_NODE_TYPE_VALUES = [...NODE_TYPES, UNSUPPORTED_NODE, ...UNSUPPORTED_NODE_TYPES] as readonly string[]

export const FlowNodeSchema = z.object({
  id,
  type: z.string().refine((t) => FLOW_NODE_TYPE_VALUES.includes(t), { message: 'node type desconhecido' }),
  name: z.string(),
  description: z.string().optional(),
  position: FlowPositionSchema,
  actions: z.array(FlowActionSchema),
  /** Só em nós `unsupported`: o `node_type` original (ex.: `kieai_integration`). */
  original_type: z.string().optional(),
})

/** Handle normalizado `kind[:id]`: `source`, `option:<id>`, `timeout`, `other`, `failure`, `success`, `output:<key>`. */
export const FlowEdgeSchema = z.object({
  id,
  from: id,
  handle: z.string().min(1),
  to: id,
})

export const FlowVariableSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  default: z.string().optional(),
})

/** Entidades externas citadas pelo fluxo (etiquetas, departamentos, fluxos, agentes…), para remapear na importação. */
export const FlowRefSchema = z.object({ id, name: z.string().optional() })
export const FlowRefsSchema = z.record(z.string(), z.array(FlowRefSchema))

export const FlowDefinitionSchema = z.object({
  schema: z.literal(FLOW_SCHEMA_VERSION),
  entry: id,
  nodes: z.array(FlowNodeSchema),
  edges: z.array(FlowEdgeSchema),
  variables: z.array(FlowVariableSchema),
  refs: FlowRefsSchema,
})

export type FlowPosition = z.infer<typeof FlowPositionSchema>
export type FlowAction = z.infer<typeof FlowActionSchema>
export type FlowNode = z.infer<typeof FlowNodeSchema>
export type FlowEdge = z.infer<typeof FlowEdgeSchema>
export type FlowVariable = z.infer<typeof FlowVariableSchema>
export type FlowRef = z.infer<typeof FlowRefSchema>
export type FlowRefs = z.infer<typeof FlowRefsSchema>
export type FlowDefinition = z.infer<typeof FlowDefinitionSchema>
