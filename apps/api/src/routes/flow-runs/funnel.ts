// Funil por bloco do fluxo (MCP): runs iniciados no período e, para cada nó do rascunho atual, quantos runs passaram
// por ele (algum passo gravado no nó) e quantos pararam nele (nó atual de runs não concluídos, por status). Nós que
// aparecem nos runs mas saíram do rascunho vão em `removed_nodes`. Tudo filtrado pela empresa.
import { and, countDistinct, eq, gte, inArray, lte, sql, type SQL } from 'drizzle-orm'
import { FLOW_RUN_STATUSES, chats, flowRunSteps, flowRuns, type Database, type FlowRunStatus } from '@crm/db'
import type { FlowDefinition } from '@crm/shared/flows'

export interface FlowFunnelFilter {
  from: Date
  to: Date
  connectionId?: string
}

type StatusCounts = Partial<Record<FlowRunStatus, number>>

export interface FlowFunnelNode {
  node_key: string
  name: string
  type: string
  is_entry: boolean
  entered: number
  /** Runs não concluídos cujo nó atual é este. */
  stopped_here: number
  stopped_by_status: StatusCounts
  /** `stopped_here / entered` (0–1); `null` sem entradas. */
  drop_off_rate: number | null
}

export interface FlowFunnel {
  flow_id: string
  from: string
  to: string
  connection_id: string | null
  totals: { started: number; completed: number; failed: number; cancelled: number; active: number; by_status: StatusCounts }
  /** `completed / started` (0–1); `null` sem runs. */
  conversion_rate: number | null
  nodes: FlowFunnelNode[]
  removed_nodes: Omit<FlowFunnelNode, 'name' | 'type' | 'is_entry'>[]
}

const ACTIVE: readonly FlowRunStatus[] = ['running', 'waiting', 'paused']
const ratio = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 10_000) / 10_000 : null)

export async function flowFunnel(db: Database, companyId: string, flowId: string, def: FlowDefinition, f: FlowFunnelFilter): Promise<FlowFunnel> {
  const where: SQL[] = [eq(flowRuns.companyId, companyId), eq(flowRuns.flowId, flowId), gte(flowRuns.startedAt, f.from), lte(flowRuns.startedAt, f.to)]
  if (f.connectionId)
    where.push(inArray(flowRuns.chatId, db.select({ id: chats.id }).from(chats).where(and(eq(chats.companyId, companyId), eq(chats.connectionId, f.connectionId)))))
  const runs = and(...where)

  const byStatus = await db.select({ status: flowRuns.status, n: sql<number>`count(*)::int` }).from(flowRuns).where(runs).groupBy(flowRuns.status)
  const stopped = await db
    .select({ node: flowRuns.currentNodeKey, status: flowRuns.status, n: sql<number>`count(*)::int` })
    .from(flowRuns)
    .where(and(runs, sql`${flowRuns.status} <> 'completed'`, sql`${flowRuns.currentNodeKey} is not null`))
    .groupBy(flowRuns.currentNodeKey, flowRuns.status)
  const entered = await db
    .select({ node: flowRunSteps.nodeKey, n: countDistinct(flowRunSteps.runId) })
    .from(flowRunSteps)
    .innerJoin(flowRuns, eq(flowRuns.id, flowRunSteps.runId))
    .where(and(runs, eq(flowRunSteps.companyId, companyId)))
    .groupBy(flowRunSteps.nodeKey)

  const totalsBy: StatusCounts = {}
  for (const r of byStatus) totalsBy[r.status] = Number(r.n)
  const count = (s: FlowRunStatus) => totalsBy[s] ?? 0
  const started = FLOW_RUN_STATUSES.reduce((sum, s) => sum + count(s), 0)

  const enteredBy = new Map(entered.map((r) => [r.node, Number(r.n)]))
  const stoppedBy = new Map<string, StatusCounts>()
  for (const r of stopped) {
    const m = stoppedBy.get(r.node!) ?? {}
    m[r.status] = Number(r.n)
    stoppedBy.set(r.node!, m)
  }
  const stat = (key: string) => {
    const by = stoppedBy.get(key) ?? {}
    const here = Object.values(by).reduce((s, n) => s + (n ?? 0), 0)
    const ent = Math.max(enteredBy.get(key) ?? 0, here)
    return { node_key: key, entered: ent, stopped_here: here, stopped_by_status: by, drop_off_rate: ratio(here, ent) }
  }

  const known = new Set(def.nodes.map((n) => n.id))
  const removed = [...new Set([...enteredBy.keys(), ...stoppedBy.keys()])].filter((k) => !known.has(k)).sort()
  return {
    flow_id: flowId,
    from: f.from.toISOString(),
    to: f.to.toISOString(),
    connection_id: f.connectionId ?? null,
    totals: {
      started,
      completed: count('completed'),
      failed: count('failed'),
      cancelled: count('cancelled'),
      active: ACTIVE.reduce((s, st) => s + count(st), 0),
      by_status: totalsBy,
    },
    conversion_rate: ratio(count('completed'), started),
    nodes: def.nodes.map((n) => ({ ...stat(n.id), name: n.name, type: n.type, is_entry: n.id === def.entry })),
    removed_nodes: removed.map(stat),
  }
}
