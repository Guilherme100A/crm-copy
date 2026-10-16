// Edição granular do rascunho (T28; 06 §5.2): nós, ações e arestas. Cada mutação roda numa transação que trava a
// linha do fluxo (autosaves concorrentes do mesmo fluxo não se perdem). Os ids no fio são as `key` da
// FlowDefinition (T19): o cliente pode mandar o seu; sem id, o servidor gera.
import { randomBytes } from 'node:crypto'
import { and, eq, inArray, max, or } from 'drizzle-orm'
import { flowEdges, flowNodeActions, flowNodes, flows, type Database } from '@crm/db'
import { parseHandle } from '@crm/shared/flows'
import { ApiError } from '../../lib/errors'

type Tx = Parameters<Parameters<Database['transaction']>[0]>[0]
export interface GraphCtx {
  companyId: string
}

export interface NodeDto {
  id: string
  type: string
  name: string
  description?: string
  position: { x: number; y: number }
  actions: ActionDto[]
  original_type?: string
}
export interface ActionDto {
  id: string
  type: string
  order: number
  config: Record<string, unknown>
}
export interface EdgeDto {
  id: string
  from: string
  handle: string
  to: string
}

export interface NodeInput {
  id?: string
  type: string
  name?: string
  description?: string | null
  position: { x: number; y: number }
  actions?: ActionInput[]
}
export interface ActionInput {
  id?: string
  type: string
  order?: number
  config: Record<string, unknown>
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export const genKey = (prefix: string) => `${prefix}_${randomBytes(6).toString('hex')}`
const notFound = (what: string) => new ApiError('NOT_FOUND', `${what} não encontrado(a)`)
const isUnique = (err: unknown) => {
  for (let e: unknown = err, i = 0; e && i < 4; e = (e as { cause?: unknown }).cause, i++) if ((e as { code?: unknown }).code === '23505') return true
  return false
}

type NodeRow = typeof flowNodes.$inferSelect
type ActionRow = typeof flowNodeActions.$inferSelect

const toAction = (a: ActionRow): ActionDto => ({ id: a.key, type: a.type, order: a.order, config: a.config })
function toNode(n: NodeRow, actions: ActionRow[]): NodeDto {
  return {
    id: n.key,
    type: n.type,
    name: n.name,
    ...(n.description !== null ? { description: n.description } : {}),
    position: { x: n.positionX, y: n.positionY },
    actions: actions.map(toAction),
    ...(n.originalType !== null ? { original_type: n.originalType } : {}),
  }
}

export class FlowGraph {
  constructor(private readonly db: Database) {}

  /** Trava o fluxo da empresa (404 se for de outra empresa ou não existir). */
  private async lockFlow(tx: Tx, ctx: GraphCtx, flowId: string) {
    if (!UUID_RE.test(flowId)) throw notFound('Fluxo')
    const [flow] = await tx
      .select()
      .from(flows)
      .where(and(eq(flows.id, flowId), eq(flows.companyId, ctx.companyId)))
      .for('update')
    if (!flow) throw notFound('Fluxo')
    return flow
  }

  private async node(tx: Tx, flowId: string, key: string): Promise<NodeRow> {
    const [n] = await tx
      .select()
      .from(flowNodes)
      .where(and(eq(flowNodes.flowId, flowId), eq(flowNodes.key, key)))
      .limit(1)
    if (!n) throw notFound('Nó')
    return n
  }

  private async actionsOf(tx: Tx, nodeId: string) {
    return tx.select().from(flowNodeActions).where(eq(flowNodeActions.nodeId, nodeId)).orderBy(flowNodeActions.sortIndex, flowNodeActions.order)
  }

  private touch(tx: Tx, flowId: string) {
    return tx.update(flows).set({ updatedAt: new Date() }).where(eq(flows.id, flowId))
  }

  private mutate<T>(ctx: GraphCtx, flowId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
    return this.db
      .transaction(async (tx) => {
        await this.lockFlow(tx, ctx, flowId)
        const out = await fn(tx)
        await this.touch(tx, flowId)
        return out
      })
      .catch((err: unknown) => {
        if (isUnique(err)) throw new ApiError('CONFLICT', 'Id já usado neste fluxo')
        throw err
      })
  }

  async addNode(ctx: GraphCtx, flowId: string, input: NodeInput): Promise<NodeDto> {
    return this.mutate(ctx, flowId, async (tx) => {
      const [last] = await tx.select({ v: max(flowNodes.sortIndex) }).from(flowNodes).where(eq(flowNodes.flowId, flowId))
      const [row] = await tx
        .insert(flowNodes)
        .values({
          companyId: ctx.companyId,
          flowId,
          key: input.id ?? genKey('node'),
          type: input.type,
          name: input.name?.trim() || 'Nó',
          description: input.description ?? null,
          positionX: input.position.x,
          positionY: input.position.y,
          sortIndex: (last?.v ?? -1) + 1,
        })
        .returning()
      const actions = (input.actions ?? []).map((a, i) => ({
        companyId: ctx.companyId,
        nodeId: row!.id,
        key: a.id ?? genKey('action'),
        type: a.type,
        order: a.order ?? i,
        config: a.config,
        sortIndex: i,
      }))
      const inserted = actions.length ? await tx.insert(flowNodeActions).values(actions).returning() : []
      return toNode(row!, inserted)
    })
  }

  async updateNode(
    ctx: GraphCtx,
    flowId: string,
    key: string,
    patch: { name?: string; description?: string | null; position?: { x: number; y: number }; type?: string },
  ): Promise<NodeDto> {
    return this.mutate(ctx, flowId, async (tx) => {
      const n = await this.node(tx, flowId, key)
      if (patch.type !== undefined && n.type === 'start' && patch.type !== 'start') throw new ApiError('CONFLICT', 'O nó Início não muda de tipo')
      const [row] = await tx
        .update(flowNodes)
        .set({
          ...(patch.name !== undefined ? { name: patch.name.trim() || 'Nó' } : {}),
          ...(patch.description !== undefined ? { description: patch.description } : {}),
          ...(patch.position ? { positionX: patch.position.x, positionY: patch.position.y } : {}),
          ...(patch.type !== undefined ? { type: patch.type } : {}),
          updatedAt: new Date(),
        })
        .where(eq(flowNodes.id, n.id))
        .returning()
      return toNode(row!, await this.actionsOf(tx, n.id))
    })
  }

  /** Exclui o nó e as arestas ligadas a ele. O nó de entrada (Início) não pode ser excluído. */
  async deleteNode(ctx: GraphCtx, flowId: string, key: string): Promise<{ removedEdgeIds: string[] }> {
    return this.mutate(ctx, flowId, async (tx) => {
      const [flow] = await tx.select({ entryKey: flows.entryKey }).from(flows).where(eq(flows.id, flowId))
      const n = await this.node(tx, flowId, key)
      if (n.type === 'start' || n.key === flow?.entryKey) throw new ApiError('CONFLICT', 'O nó Início não pode ser excluído')
      const edges = await tx
        .select({ key: flowEdges.key })
        .from(flowEdges)
        .where(and(eq(flowEdges.flowId, flowId), or(eq(flowEdges.fromNodeId, n.id), eq(flowEdges.toNodeId, n.id))))
      await tx.delete(flowNodes).where(eq(flowNodes.id, n.id))
      return { removedEdgeIds: edges.map((e) => e.key) }
    })
  }

  /** Posições em lote (arrastar vários nós). Ids desconhecidos são ignorados. */
  async setPositions(ctx: GraphCtx, flowId: string, positions: { id: string; x: number; y: number }[]): Promise<number> {
    return this.mutate(ctx, flowId, async (tx) => {
      let updated = 0
      for (const p of positions) {
        const r = await tx
          .update(flowNodes)
          .set({ positionX: p.x, positionY: p.y, updatedAt: new Date() })
          .where(and(eq(flowNodes.flowId, flowId), eq(flowNodes.key, p.id)))
          .returning({ id: flowNodes.id })
        updated += r.length
      }
      return updated
    })
  }

  async addAction(ctx: GraphCtx, flowId: string, nodeKey: string, input: ActionInput): Promise<ActionDto> {
    return this.mutate(ctx, flowId, async (tx) => {
      const n = await this.node(tx, flowId, nodeKey)
      const [last] = await tx
        .select({ order: max(flowNodeActions.order), sort: max(flowNodeActions.sortIndex) })
        .from(flowNodeActions)
        .where(eq(flowNodeActions.nodeId, n.id))
      const [row] = await tx
        .insert(flowNodeActions)
        .values({
          companyId: ctx.companyId,
          nodeId: n.id,
          key: input.id ?? genKey('action'),
          type: input.type,
          order: input.order ?? (last?.order ?? -1) + 1,
          config: input.config,
          sortIndex: (last?.sort ?? -1) + 1,
        })
        .returning()
      return toAction(row!)
    })
  }

  async updateAction(
    ctx: GraphCtx,
    flowId: string,
    nodeKey: string,
    actionKey: string,
    patch: { type?: string; order?: number; config?: Record<string, unknown> },
  ): Promise<ActionDto> {
    return this.mutate(ctx, flowId, async (tx) => {
      const n = await this.node(tx, flowId, nodeKey)
      const [row] = await tx
        .update(flowNodeActions)
        .set({
          ...(patch.type !== undefined ? { type: patch.type } : {}),
          ...(patch.order !== undefined ? { order: patch.order } : {}),
          ...(patch.config !== undefined ? { config: patch.config } : {}),
          updatedAt: new Date(),
        })
        .where(and(eq(flowNodeActions.nodeId, n.id), eq(flowNodeActions.key, actionKey)))
        .returning()
      if (!row) throw notFound('Ação')
      return toAction(row)
    })
  }

  async deleteAction(ctx: GraphCtx, flowId: string, nodeKey: string, actionKey: string): Promise<void> {
    await this.mutate(ctx, flowId, async (tx) => {
      const n = await this.node(tx, flowId, nodeKey)
      const r = await tx
        .delete(flowNodeActions)
        .where(and(eq(flowNodeActions.nodeId, n.id), eq(flowNodeActions.key, actionKey)))
        .returning({ id: flowNodeActions.id })
      if (!r.length) throw notFound('Ação')
    })
  }

  /**
   * Liga `from --handle--> to`. Cada handle de saída tem no máximo uma aresta (06 §3.7): ligar de novo SUBSTITUI a
   * anterior (devolve o id dela em `replacedEdgeId`). O Início não recebe arestas.
   */
  async upsertConnection(ctx: GraphCtx, flowId: string, input: { id?: string; from: string; handle: string; to: string }): Promise<{ edge: EdgeDto; replacedEdgeId: string | null }> {
    if (!parseHandle(input.handle))
      throw new ApiError('VALIDATION_ERROR', 'Handle inválido', { fields: [{ path: 'handle', message: 'use kind[:id] (ex.: source, option:<id>)' }] })
    return this.mutate(ctx, flowId, async (tx) => {
      const nodes = await tx
        .select()
        .from(flowNodes)
        .where(and(eq(flowNodes.flowId, flowId), inArray(flowNodes.key, [input.from, input.to])))
      const from = nodes.find((n) => n.key === input.from)
      const to = nodes.find((n) => n.key === input.to)
      const missing = [!from && 'from', !to && 'to'].filter((x): x is string => !!x)
      if (missing.length)
        throw new ApiError('VALIDATION_ERROR', 'Nó inexistente', { fields: missing.map((p) => ({ path: p, message: 'nó não existe neste fluxo' })) })
      if (to!.type === 'start') throw new ApiError('VALIDATION_ERROR', 'O nó Início não recebe conexões', { fields: [{ path: 'to', message: 'o Início não recebe conexões' }] })

      const [existing] = await tx
        .select()
        .from(flowEdges)
        .where(and(eq(flowEdges.fromNodeId, from!.id), eq(flowEdges.handle, input.handle)))
        .limit(1)
      if (existing && existing.toNodeId === to!.id && (!input.id || input.id === existing.key)) {
        return { edge: { id: existing.key, from: input.from, handle: input.handle, to: input.to }, replacedEdgeId: null }
      }
      if (existing) await tx.delete(flowEdges).where(eq(flowEdges.id, existing.id))
      const [last] = await tx.select({ v: max(flowEdges.sortIndex) }).from(flowEdges).where(eq(flowEdges.flowId, flowId))
      const key = input.id ?? genKey('edge')
      await tx.insert(flowEdges).values({
        companyId: ctx.companyId,
        flowId,
        key,
        fromNodeId: from!.id,
        handle: input.handle,
        toNodeId: to!.id,
        sortIndex: (last?.v ?? -1) + 1,
      })
      return { edge: { id: key, from: input.from, handle: input.handle, to: input.to }, replacedEdgeId: existing?.key ?? null }
    })
  }

  async deleteConnection(ctx: GraphCtx, flowId: string, edgeKey: string): Promise<void> {
    await this.mutate(ctx, flowId, async (tx) => {
      const r = await tx
        .delete(flowEdges)
        .where(and(eq(flowEdges.flowId, flowId), eq(flowEdges.key, edgeKey)))
        .returning({ id: flowEdges.id })
      if (!r.length) throw notFound('Conexão')
    })
  }
}
