// Impacto de excluir um fluxo (06 §6 `deletion_impact`): runs, configurações que apontam para ele e outros fluxos
// que o chamam (`execute_flow`). As configs de conexão/horário são de outros módulos (T61, T31): eles registram uma
// fonte com `registerFlowReferenceSource` (ou a API recebe `flowReferenceSources` nas deps).
import { and, count, eq, inArray, ne, sql } from 'drizzle-orm'
import { ACTIVE_FLOW_RUN_STATUSES, flowNodeActions, flowNodes, flowRuns, flows, type Database } from '@crm/db'

export type FlowReferenceKind = 'connection_flow_config' | 'business_hour_config'

export interface FlowReference {
  kind: FlowReferenceKind
  id: string
  name?: string | null
}

export type FlowReferenceSource = (ctx: { companyId: string }, flowId: string) => readonly FlowReference[] | Promise<readonly FlowReference[]>

const sources = new Set<FlowReferenceSource>()

/** Registra uma fonte de referências a fluxos; devolve a função que desfaz o registro. */
export function registerFlowReferenceSource(source: FlowReferenceSource): () => void {
  sources.add(source)
  return () => {
    sources.delete(source)
  }
}

/** Referências que BLOQUEIAM a exclusão (configurações que dependem do fluxo). */
export const BLOCKING_REFERENCE_KINDS: readonly FlowReferenceKind[] = ['connection_flow_config', 'business_hour_config']

export interface DeletionImpact {
  active_runs: number
  total_runs: number
  connection_flow_configs: FlowReference[]
  business_hour_configs: FlowReference[]
  referenced_by_flows: { id: string; name: string; node_ids: string[] }[]
}

export async function deletionImpact(
  db: Database,
  ctx: { companyId: string },
  flowId: string,
  extra: readonly FlowReferenceSource[] = [],
): Promise<DeletionImpact> {
  const [runs] = await db
    .select({
      total: count(),
      active: sql<number>`count(*) filter (where ${inArray(flowRuns.status, [...ACTIVE_FLOW_RUN_STATUSES])})`,
    })
    .from(flowRuns)
    .where(and(eq(flowRuns.companyId, ctx.companyId), eq(flowRuns.flowId, flowId)))

  const refs: FlowReference[] = []
  for (const source of [...sources, ...extra]) refs.push(...(await source(ctx, flowId)))

  // Rascunhos de outros fluxos da empresa com `execute_flow` apontando para este.
  const callers = await db
    .select({ id: flows.id, name: flows.name, nodeKey: flowNodes.key })
    .from(flowNodeActions)
    .innerJoin(flowNodes, eq(flowNodes.id, flowNodeActions.nodeId))
    .innerJoin(flows, eq(flows.id, flowNodes.flowId))
    .where(
      and(
        eq(flowNodeActions.companyId, ctx.companyId),
        eq(flowNodeActions.type, 'execute_flow'),
        sql`${flowNodeActions.config} ->> 'target_flow_id' = ${flowId}`,
        ne(flows.id, flowId),
      ),
    )
  const byFlow = new Map<string, { id: string; name: string; node_ids: string[] }>()
  for (const c of callers) {
    const entry = byFlow.get(c.id) ?? { id: c.id, name: c.name, node_ids: [] }
    if (!entry.node_ids.includes(c.nodeKey)) entry.node_ids.push(c.nodeKey)
    byFlow.set(c.id, entry)
  }

  return {
    active_runs: Number(runs?.active ?? 0),
    total_runs: Number(runs?.total ?? 0),
    connection_flow_configs: refs.filter((r) => r.kind === 'connection_flow_config'),
    business_hour_configs: refs.filter((r) => r.kind === 'business_hour_config'),
    referenced_by_flows: [...byFlow.values()],
  }
}
