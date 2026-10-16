// FlowStore (T19): pastas, fluxos, rascunho ↔ FlowDefinition e versões publicadas. Toda query filtra pela
// empresa do contexto (SPEC 3.3); recurso de outra empresa → NOT_FOUND.
import {
  flowEdges,
  flowFolders,
  flowNodeActions,
  flowNodes,
  flows,
  flowVersions,
  FLOW_FOLDER_COLORS,
  type Database,
  type FlowFolderColor,
  type FlowStatus,
} from '@crm/db'
import { FlowDefinitionSchema, FLOW_SCHEMA_VERSION, type FlowDefinition } from '@crm/shared/flows'
import { and, asc, desc, eq, inArray, isNull, max, sql } from 'drizzle-orm'
import { FlowStoreError, uniqueViolation } from './errors'

export interface FlowCtx {
  companyId: string
  userId?: string | null
}

type Tx = Parameters<Parameters<Database['transaction']>[0]>[0]
type Exec = Database | Tx

export type FlowFolderRow = typeof flowFolders.$inferSelect
export type FlowRow = typeof flows.$inferSelect

export interface FlowVersionView {
  id: string
  flowId: string
  version: number
  definition: FlowDefinition
  publishedByUserId: string | null
  createdAt: Date
}

export interface CreateFolderInput {
  name: string
  color?: FlowFolderColor
  parentFolderId?: string | null
  position?: number
}
export type UpdateFolderInput = Partial<CreateFolderInput>

export interface CreateFlowInput {
  name?: string
  description?: string | null
  folderId?: string | null
  status?: FlowStatus
  position?: number
}
export type UpdateFlowInput = Partial<CreateFlowInput>

export const DEFAULT_FLOW_NAME = 'Novo Fluxo'
export const START_NODE_KEY = 'start'
/** Nó START inicial no canvas (06 §3.3). */
export const START_NODE_POSITION = { x: 1200, y: 800 } as const

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const notFound = (what: string, id: string) => new FlowStoreError('NOT_FOUND', `${what} ${id} não encontrado`)

/** Definição de um fluxo novo: só o nó Início. */
export function emptyFlowDefinition(): FlowDefinition {
  return {
    schema: FLOW_SCHEMA_VERSION,
    entry: START_NODE_KEY,
    nodes: [{ id: START_NODE_KEY, type: 'start', name: 'Início', position: { ...START_NODE_POSITION }, actions: [] }],
    edges: [],
    variables: [],
    refs: {},
  }
}

export class FlowStore {
  constructor(private readonly db: Database) {}

  // ---------------------------------------------------------------- pastas

  async createFolder(ctx: FlowCtx, input: CreateFolderInput): Promise<FlowFolderRow> {
    this.assertFolderInput(input)
    if (input.parentFolderId) await this.requireFolder(this.db, ctx, input.parentFolderId)
    const [row] = await this.db
      .insert(flowFolders)
      .values({
        companyId: ctx.companyId,
        name: input.name.trim(),
        color: input.color ?? 'blue',
        parentFolderId: input.parentFolderId ?? null,
        position: input.position ?? 0,
      })
      .returning()
    return row!
  }

  async getFolder(ctx: FlowCtx, id: string): Promise<FlowFolderRow> {
    return this.requireFolder(this.db, ctx, id)
  }

  async listFolders(ctx: FlowCtx, opts: { parentFolderId?: string | null } = {}): Promise<FlowFolderRow[]> {
    const where = [eq(flowFolders.companyId, ctx.companyId)]
    if (opts.parentFolderId === null) where.push(isNull(flowFolders.parentFolderId))
    else if (opts.parentFolderId) where.push(eq(flowFolders.parentFolderId, opts.parentFolderId))
    return this.db
      .select()
      .from(flowFolders)
      .where(and(...where))
      .orderBy(asc(flowFolders.position), asc(flowFolders.createdAt))
  }

  /** Atualiza a pasta. Mover para si mesma ou para uma descendente → CONFLICT. */
  async updateFolder(ctx: FlowCtx, id: string, input: UpdateFolderInput): Promise<FlowFolderRow> {
    this.assertFolderInput(input)
    return this.db.transaction(async (tx) => {
      await this.requireFolder(tx, ctx, id, true)
      if (input.parentFolderId) await this.assertNotDescendant(tx, ctx, id, input.parentFolderId)
      const set: Partial<typeof flowFolders.$inferInsert> = { updatedAt: new Date() }
      if (input.name !== undefined) set.name = input.name.trim()
      if (input.color !== undefined) set.color = input.color
      if (input.parentFolderId !== undefined) set.parentFolderId = input.parentFolderId
      if (input.position !== undefined) set.position = input.position
      const [row] = await tx
        .update(flowFolders)
        .set(set)
        .where(and(eq(flowFolders.id, id), eq(flowFolders.companyId, ctx.companyId)))
        .returning()
      return row!
    })
  }

  moveFolder(ctx: FlowCtx, id: string, parentFolderId: string | null): Promise<FlowFolderRow> {
    return this.updateFolder(ctx, id, { parentFolderId })
  }

  /** Remove a pasta; subpastas e fluxos dela vão para "Sem pasta" (FK `set null`). */
  async deleteFolder(ctx: FlowCtx, id: string): Promise<void> {
    await this.requireFolder(this.db, ctx, id)
    await this.db.delete(flowFolders).where(and(eq(flowFolders.id, id), eq(flowFolders.companyId, ctx.companyId)))
  }

  // ---------------------------------------------------------------- fluxos

  /** Cria o fluxo já com o nó Início (06 §3.3). */
  async createFlow(ctx: FlowCtx, input: CreateFlowInput = {}): Promise<FlowRow> {
    if (input.folderId) await this.requireFolder(this.db, ctx, input.folderId)
    const name = input.name?.trim() || DEFAULT_FLOW_NAME
    return this.db.transaction(async (tx) => {
      const [flow] = await tx
        .insert(flows)
        .values({
          companyId: ctx.companyId,
          name,
          description: input.description ?? null,
          folderId: input.folderId ?? null,
          status: input.status ?? 'active',
          position: input.position ?? 0,
          entryKey: START_NODE_KEY,
          createdByUserId: ctx.userId ?? null,
        })
        .returning()
      await this.writeGraph(tx, ctx, flow!.id, emptyFlowDefinition())
      return flow!
    })
  }

  async getFlow(ctx: FlowCtx, id: string): Promise<FlowRow> {
    return this.requireFlow(this.db, ctx, id)
  }

  async listFlows(ctx: FlowCtx, opts: { folderId?: string | null; status?: FlowStatus } = {}): Promise<FlowRow[]> {
    const where = [eq(flows.companyId, ctx.companyId)]
    if (opts.folderId === null) where.push(isNull(flows.folderId))
    else if (opts.folderId) where.push(eq(flows.folderId, opts.folderId))
    if (opts.status) where.push(eq(flows.status, opts.status))
    // Ordem da lista da referência: pasta, posição, criação (06 §3.1).
    return this.db
      .select()
      .from(flows)
      .where(and(...where))
      .orderBy(asc(flows.folderId), asc(flows.position), asc(flows.createdAt))
  }

  async updateFlow(ctx: FlowCtx, id: string, input: UpdateFlowInput): Promise<FlowRow> {
    await this.requireFlow(this.db, ctx, id)
    if (input.folderId) await this.requireFolder(this.db, ctx, input.folderId)
    const set: Partial<typeof flows.$inferInsert> = { updatedAt: new Date() }
    if (input.name !== undefined) {
      if (!input.name.trim()) throw new FlowStoreError('VALIDATION_ERROR', 'nome do fluxo é obrigatório', { field: 'name' })
      set.name = input.name.trim()
    }
    if (input.description !== undefined) set.description = input.description
    if (input.folderId !== undefined) set.folderId = input.folderId
    if (input.status !== undefined) set.status = input.status
    if (input.position !== undefined) set.position = input.position
    const [row] = await this.db
      .update(flows)
      .set(set)
      .where(and(eq(flows.id, id), eq(flows.companyId, ctx.companyId)))
      .returning()
    return row!
  }

  async deleteFlow(ctx: FlowCtx, id: string): Promise<void> {
    await this.requireFlow(this.db, ctx, id)
    await this.db.delete(flows).where(and(eq(flows.id, id), eq(flows.companyId, ctx.companyId)))
  }

  // ---------------------------------------------------------------- rascunho ↔ FlowDefinition

  /** Rascunho atual como FlowDefinition (ids = `key` de nós, ações e arestas). */
  async toDefinition(ctx: FlowCtx, flowId: string): Promise<FlowDefinition> {
    const flow = await this.requireFlow(this.db, ctx, flowId)
    return this.readGraph(this.db, flow)
  }

  /**
   * Substitui todo o rascunho pela definição (nós, ações, arestas, entry, variáveis, refs) numa transação.
   * Confere só a estrutura (rascunho pode estar incompleto); `validate` semântico fica para a ativação.
   */
  async fromDefinition(ctx: FlowCtx, flowId: string, input: unknown): Promise<FlowDefinition> {
    const parsed = FlowDefinitionSchema.safeParse(input)
    if (!parsed.success) {
      throw new FlowStoreError('VALIDATION_ERROR', 'FlowDefinition inválida', {
        fields: parsed.error.issues.map((i) => ({ path: i.path.map(String).join('.'), message: i.message })),
      })
    }
    const def = parsed.data
    assertGraphReferences(def)
    try {
      return await this.db.transaction(async (tx) => {
        const flow = await this.requireFlow(tx, ctx, flowId, true)
        await tx.delete(flowNodes).where(and(eq(flowNodes.flowId, flow.id), eq(flowNodes.companyId, ctx.companyId)))
        await this.writeGraph(tx, ctx, flow.id, def)
        const [updated] = await tx
          .update(flows)
          .set({ entryKey: def.entry, variables: def.variables, refs: def.refs, updatedAt: new Date() })
          .where(eq(flows.id, flow.id))
          .returning()
        return this.readGraph(tx, updated!)
      })
    } catch (err) {
      const constraint = uniqueViolation(err)
      if (constraint !== undefined) throw new FlowStoreError('CONFLICT', 'definição com chave repetida', { constraint })
      throw err
    }
  }

  // ---------------------------------------------------------------- versões

  /** Grava o rascunho atual como versão imutável com número sequencial por fluxo (1, 2, …). */
  async publish(ctx: FlowCtx, flowId: string): Promise<FlowVersionView> {
    return this.db.transaction(async (tx) => {
      // A trava na linha do fluxo serializa publicações concorrentes do mesmo fluxo.
      const flow = await this.requireFlow(tx, ctx, flowId, true)
      const definition = await this.readGraph(tx, flow)
      const [last] = await tx.select({ v: max(flowVersions.version) }).from(flowVersions).where(eq(flowVersions.flowId, flow.id))
      const version = (last?.v ?? 0) + 1
      const [row] = await tx
        .insert(flowVersions)
        .values({ companyId: ctx.companyId, flowId: flow.id, version, definition, publishedByUserId: ctx.userId ?? null })
        .returning()
      await tx.update(flows).set({ publishedVersion: version, updatedAt: new Date() }).where(eq(flows.id, flow.id))
      return toVersionView(row!)
    })
  }

  /** Versão publicada (sem `version` = a última). */
  async getVersion(ctx: FlowCtx, flowId: string, version?: number): Promise<FlowVersionView> {
    await this.requireFlow(this.db, ctx, flowId)
    const where = [eq(flowVersions.flowId, flowId), eq(flowVersions.companyId, ctx.companyId)]
    if (version !== undefined) where.push(eq(flowVersions.version, version))
    const [row] = await this.db
      .select()
      .from(flowVersions)
      .where(and(...where))
      .orderBy(desc(flowVersions.version))
      .limit(1)
    if (!row) throw new FlowStoreError('NOT_FOUND', version === undefined ? `fluxo ${flowId} sem versão publicada` : `versão ${version} não encontrada`)
    return toVersionView(row)
  }

  async listVersions(ctx: FlowCtx, flowId: string): Promise<FlowVersionView[]> {
    await this.requireFlow(this.db, ctx, flowId)
    const rows = await this.db
      .select()
      .from(flowVersions)
      .where(and(eq(flowVersions.flowId, flowId), eq(flowVersions.companyId, ctx.companyId)))
      .orderBy(asc(flowVersions.version))
    return rows.map(toVersionView)
  }

  // ---------------------------------------------------------------- internos

  private assertFolderInput(input: UpdateFolderInput): void {
    if (input.name !== undefined && !input.name.trim()) throw new FlowStoreError('VALIDATION_ERROR', 'nome da pasta é obrigatório', { field: 'name' })
    if (input.color !== undefined && !(FLOW_FOLDER_COLORS as readonly string[]).includes(input.color)) {
      throw new FlowStoreError('VALIDATION_ERROR', `cor inválida: ${input.color}`, { field: 'color' })
    }
  }

  private async requireFolder(exec: Exec, ctx: FlowCtx, id: string, lock = false): Promise<FlowFolderRow> {
    if (!UUID_RE.test(id)) throw notFound('pasta', id)
    const q = exec
      .select()
      .from(flowFolders)
      .where(and(eq(flowFolders.id, id), eq(flowFolders.companyId, ctx.companyId)))
    const [row] = lock ? await q.for('update') : await q
    if (!row) throw notFound('pasta', id)
    return row
  }

  private async requireFlow(exec: Exec, ctx: FlowCtx, id: string, lock = false): Promise<FlowRow> {
    if (!UUID_RE.test(id)) throw notFound('fluxo', id)
    const q = exec
      .select()
      .from(flows)
      .where(and(eq(flows.id, id), eq(flows.companyId, ctx.companyId)))
    const [row] = lock ? await q.for('update') : await q
    if (!row) throw notFound('fluxo', id)
    return row
  }

  /** `parentId` não pode ser a própria pasta nem uma descendente dela (06 §3.2). */
  private async assertNotDescendant(exec: Exec, ctx: FlowCtx, folderId: string, parentId: string): Promise<void> {
    if (parentId === folderId) throw new FlowStoreError('CONFLICT', 'a pasta não pode ser pai de si mesma')
    await this.requireFolder(exec, ctx, parentId)
    // Sobe a partir do novo pai; se chegar à pasta movida, o novo pai é descendente dela.
    const rows = await exec.execute<{ id: string }>(sql`
      with recursive up(id, parent_folder_id, depth) as (
        select id, parent_folder_id, 0 from crm.flow_folders where id = ${parentId} and company_id = ${ctx.companyId}
        union all
        select f.id, f.parent_folder_id, up.depth + 1
          from crm.flow_folders f join up on f.id = up.parent_folder_id
         where f.company_id = ${ctx.companyId} and up.depth < 1000
      )
      select id from up where id = ${folderId} limit 1`)
    if (rows.rows.length > 0) throw new FlowStoreError('CONFLICT', 'a pasta não pode ser movida para uma subpasta dela mesma')
  }

  private async writeGraph(tx: Tx, ctx: FlowCtx, flowId: string, def: FlowDefinition): Promise<void> {
    if (def.nodes.length === 0) return
    const nodeRows = await tx
      .insert(flowNodes)
      .values(
        def.nodes.map((n, i) => ({
          companyId: ctx.companyId,
          flowId,
          key: n.id,
          type: n.type,
          originalType: n.original_type ?? null,
          name: n.name,
          description: n.description ?? null,
          positionX: n.position.x,
          positionY: n.position.y,
          sortIndex: i,
        })),
      )
      .returning({ id: flowNodes.id, key: flowNodes.key })
    const idOf = new Map(nodeRows.map((r) => [r.key, r.id]))
    const actions = def.nodes.flatMap((n) =>
      n.actions.map((a, i) => ({ companyId: ctx.companyId, nodeId: idOf.get(n.id)!, key: a.id, type: a.type, order: a.order, config: a.config, sortIndex: i })),
    )
    if (actions.length) await tx.insert(flowNodeActions).values(actions)
    if (def.edges.length) {
      await tx.insert(flowEdges).values(
        def.edges.map((e, i) => ({
          companyId: ctx.companyId,
          flowId,
          key: e.id,
          fromNodeId: idOf.get(e.from)!,
          handle: e.handle,
          toNodeId: idOf.get(e.to)!,
          sortIndex: i,
        })),
      )
    }
  }

  private async readGraph(exec: Exec, flow: FlowRow): Promise<FlowDefinition> {
    const nodes = await exec
      .select()
      .from(flowNodes)
      .where(and(eq(flowNodes.flowId, flow.id), eq(flowNodes.companyId, flow.companyId)))
      .orderBy(asc(flowNodes.sortIndex), asc(flowNodes.createdAt))
    const nodeIds = nodes.map((n) => n.id)
    const actions = nodeIds.length
      ? await exec
          .select()
          .from(flowNodeActions)
          .where(and(inArray(flowNodeActions.nodeId, nodeIds), eq(flowNodeActions.companyId, flow.companyId)))
          .orderBy(asc(flowNodeActions.sortIndex), asc(flowNodeActions.order))
      : []
    const edges = await exec
      .select()
      .from(flowEdges)
      .where(and(eq(flowEdges.flowId, flow.id), eq(flowEdges.companyId, flow.companyId)))
      .orderBy(asc(flowEdges.sortIndex), asc(flowEdges.createdAt))
    const keyOf = new Map(nodes.map((n) => [n.id, n.key]))
    return {
      schema: FLOW_SCHEMA_VERSION,
      entry: flow.entryKey,
      // Chaves na ordem do FlowNodeSchema: o JSON do round-trip sai idêntico.
      nodes: nodes.map((n) => ({
        id: n.key,
        type: n.type,
        name: n.name,
        ...(n.description !== null ? { description: n.description } : {}),
        position: { x: n.positionX, y: n.positionY },
        actions: actions.filter((a) => a.nodeId === n.id).map((a) => ({ id: a.key, type: a.type, order: a.order, config: a.config })),
        ...(n.originalType !== null ? { original_type: n.originalType } : {}),
      })),
      edges: edges.map((e) => ({ id: e.key, from: keyOf.get(e.fromNodeId)!, handle: e.handle, to: keyOf.get(e.toNodeId)! })),
      variables: flow.variables as FlowDefinition['variables'],
      refs: flow.refs as FlowDefinition['refs'],
    }
  }
}

/** Ids únicos e arestas apontando para nós existentes (pré-requisito das FKs). */
function assertGraphReferences(def: FlowDefinition): void {
  const fields: { path: string; message: string }[] = []
  const nodeIds = new Set<string>()
  def.nodes.forEach((n, i) => {
    if (nodeIds.has(n.id)) fields.push({ path: `nodes.${i}.id`, message: `id de nó repetido: ${n.id}` })
    nodeIds.add(n.id)
    const actionIds = new Set<string>()
    n.actions.forEach((a, j) => {
      if (actionIds.has(a.id)) fields.push({ path: `nodes.${i}.actions.${j}.id`, message: `id de ação repetido: ${a.id}` })
      actionIds.add(a.id)
    })
  })
  const edgeIds = new Set<string>()
  def.edges.forEach((e, i) => {
    if (edgeIds.has(e.id)) fields.push({ path: `edges.${i}.id`, message: `id de aresta repetido: ${e.id}` })
    edgeIds.add(e.id)
    if (!nodeIds.has(e.from)) fields.push({ path: `edges.${i}.from`, message: `nó inexistente: ${e.from}` })
    if (!nodeIds.has(e.to)) fields.push({ path: `edges.${i}.to`, message: `nó inexistente: ${e.to}` })
  })
  if (!nodeIds.has(def.entry)) fields.push({ path: 'entry', message: `nó de entrada inexistente: ${def.entry}` })
  if (fields.length) throw new FlowStoreError('VALIDATION_ERROR', 'FlowDefinition com referências inválidas', { fields })
}

function toVersionView(row: typeof flowVersions.$inferSelect): FlowVersionView {
  return {
    id: row.id,
    flowId: row.flowId,
    version: row.version,
    definition: row.definition as unknown as FlowDefinition,
    publishedByUserId: row.publishedByUserId,
    createdAt: row.createdAt,
  }
}
