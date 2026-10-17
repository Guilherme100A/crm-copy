// API do editor de fluxos (T28; 06 §5.1–5.4, §6, §8): fluxos, pastas, rascunho (nós, ações, arestas), validação,
// publicação (activate), duplicação e impacto de exclusão. Leitura: `flows.view`; mutações: `flows.edit`;
// excluir fluxo/pasta: `flows.delete`. Toda mutação do grafo publica `flow.graph_updated` (com `actor_id`).
import { Hono, type Context } from 'hono'
import { and, count, eq, ilike, inArray, isNotNull, isNull } from 'drizzle-orm'
import { z } from 'zod'
import { FlowStore, FlowStoreError, RealtimePublisher, type FlowCtx, type FlowFolderRow, type FlowRow } from '@crm/core'
import { FLOW_FOLDER_COLORS, FLOW_STATUSES, flowNodes, flows, type FlowStatus } from '@crm/db'
import { validate as validateFlow, type FlowDefinition } from '@crm/shared/flows'
import { getCompanyCtx } from '../../lib/context'
import { ApiError } from '../../lib/errors'
import { validate } from '../../lib/validate'
import type { AppEnv, ResolvedDeps } from '../../lib/types'
import { requirePerm } from '../../middleware/authorize'
import { setAudit } from '../../middleware/audit'
import { FlowGraph, genKey } from './graph'
import { flowServices } from '../flow-runs/services'
import { BLOCKING_REFERENCE_KINDS, deletionImpact, type FlowReferenceSource } from './impact'

export { registerFlowReferenceSource } from './impact'
export type { DeletionImpact, FlowReference, FlowReferenceKind, FlowReferenceSource } from './impact'
export { FlowGraph } from './graph'

declare module '../../lib/types' {
  interface AppDeps {
    /** Fontes extras de referências a fluxos (configs de conexão, horários), além das registradas. */
    flowReferenceSources?: readonly FlowReferenceSource[]
  }
}

// ---------------------------------------------------------------- DTOs

export function toFlowDto(f: FlowRow, nodesCount = 0) {
  return {
    id: f.id,
    name: f.name,
    description: f.description,
    status: f.status,
    folder_id: f.folderId,
    position: f.position,
    published_version: f.publishedVersion,
    nodes_count: nodesCount,
    created_at: f.createdAt.toISOString(),
    updated_at: f.updatedAt.toISOString(),
  }
}

export function toFolderDto(f: FlowFolderRow) {
  return {
    id: f.id,
    name: f.name,
    color: f.color,
    parent_id: f.parentFolderId,
    position: f.position,
    created_at: f.createdAt.toISOString(),
    updated_at: f.updatedAt.toISOString(),
  }
}

// ---------------------------------------------------------------- schemas

const unwrap = (key: string) => (v: unknown) =>
  v && typeof v === 'object' && !Array.isArray(v) && key in v && typeof (v as Record<string, unknown>)[key] === 'object'
    ? (v as Record<string, unknown>)[key]
    : v

const uuid = z.uuid()
const key = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, 'use letras, números, _ ou -')
const name = z.string().trim().min(1).max(120)
const position = z.object({ x: z.number().finite(), y: z.number().finite() })
const config = z.record(z.string(), z.unknown())

const createFlowSchema = z.preprocess(
  unwrap('flow'),
  z.object({ name: name.optional(), description: z.string().max(2000).nullish(), folder_id: uuid.nullish() }),
)
const updateFlowSchema = z.preprocess(unwrap('flow'), z.object({ name: name.optional(), description: z.string().max(2000).nullish() }))
const listQuery = z.object({
  folder_id: z.union([uuid, z.literal('root')]).optional(),
  status: z.enum(FLOW_STATUSES).optional(),
  search: z.string().trim().max(120).optional(),
})
const namesQuery = z.object({ triggerable: z.enum(['1', '0', 'true', 'false']).optional() })
const moveSchema = z.object({ folder_id: uuid.nullable() })
const reorderSchema = z.object({ position: z.number().int().min(0) })
const actionSchema = z.object({ id: key.optional(), type: z.string().min(1).max(64), order: z.number().int().min(0).optional(), config })
const nodeSchema = z.preprocess(
  unwrap('flow_node'),
  z.object({
    id: key.optional(),
    type: z.string().min(1).max(64),
    name: z.string().max(120).optional(),
    description: z.string().max(2000).nullish(),
    position,
    actions: z.array(actionSchema).max(50).optional(),
  }),
)
const nodePatchSchema = z.object({
  name: z.string().max(120).optional(),
  description: z.string().max(2000).nullish(),
  position: position.optional(),
  type: z.string().min(1).max(64).optional(),
})
const actionPatchSchema = z.object({ type: z.string().min(1).max(64).optional(), order: z.number().int().min(0).optional(), config: config.optional() })
const positionsSchema = z.object({ positions: z.array(z.object({ id: key, x: z.number().finite(), y: z.number().finite() })).min(1).max(1000) })
const connectionSchema = z.object({ id: key.optional(), from: key, handle: z.string().min(1).max(130), to: key })
const folderSchema = z.preprocess(
  unwrap('flow_folder'),
  z.object({ name, color: z.enum(FLOW_FOLDER_COLORS).optional(), parent_id: uuid.nullish(), position: z.number().int().min(0).optional() }),
)
const folderPatchSchema = z.preprocess(
  unwrap('flow_folder'),
  z.object({ name: name.optional(), color: z.enum(FLOW_FOLDER_COLORS).optional(), parent_id: uuid.nullish(), position: z.number().int().min(0).optional() }),
)
const folderMoveSchema = z.object({ parent_id: uuid.nullable() })
const foldersQuery = z.object({ parent_id: z.union([uuid, z.literal('root')]).optional() })

// ---------------------------------------------------------------- apoio

const STORE_CODES = { NOT_FOUND: 'NOT_FOUND', CONFLICT: 'CONFLICT', VALIDATION_ERROR: 'VALIDATION_ERROR', LIMIT_REACHED: 'LIMIT_REACHED' } as const

async function run<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (err) {
    if (err instanceof FlowStoreError) throw new ApiError(STORE_CODES[err.code], err.message, err.details)
    throw err
  }
}

/** Copia a definição trocando os ids de nós, ações e arestas (o entry acompanha). */
export function remapDefinition(def: FlowDefinition): FlowDefinition {
  const nodeIds = new Map(def.nodes.map((n) => [n.id, genKey('node')]))
  return {
    ...def,
    entry: nodeIds.get(def.entry) ?? def.entry,
    nodes: def.nodes.map((n) => ({ ...n, id: nodeIds.get(n.id)!, actions: n.actions.map((a) => ({ ...a, id: genKey('action') })) })),
    edges: def.edges.map((e) => ({ ...e, id: genKey('edge'), from: nodeIds.get(e.from) ?? e.from, to: nodeIds.get(e.to) ?? e.to })),
  }
}

export function flowsRoutes(deps: ResolvedDeps) {
  const app = new Hono<AppEnv>()
  const store = new FlowStore(deps.db)
  const graph = new FlowGraph(deps.db)
  const publisher = () => deps.realtimePublisher ?? (cachedPublisher ??= new RealtimePublisher({ redis: deps.redis, prefix: deps.realtime?.prefix }))
  let cachedPublisher: RealtimePublisher | undefined

  const ctxOf = (c: Context<AppEnv>): FlowCtx & { actorId: string | null } => {
    const ctx = getCompanyCtx(c)
    return { companyId: ctx.companyId, userId: ctx.user?.id ?? null, actorId: ctx.user?.id ?? null }
  }

  const nodesCount = async (ids: string[]): Promise<Map<string, number>> => {
    if (!ids.length) return new Map()
    const rows = await deps.db.select({ flowId: flowNodes.flowId, n: count() }).from(flowNodes).where(inArray(flowNodes.flowId, ids)).groupBy(flowNodes.flowId)
    return new Map(rows.map((r) => [r.flowId, Number(r.n)]))
  }
  const flowDto = async (f: FlowRow) => toFlowDto(f, (await nodesCount([f.id])).get(f.id) ?? 0)

  const graphUpdated = async (c: Context<AppEnv>, flowId: string, mutation: string) => {
    const ctx = ctxOf(c)
    setAudit(c, { action: `flow.${mutation}`, targetType: 'flow', targetId: flowId })
    await publisher()
      .publish(ctx.companyId, 'flow.graph_updated', { flow_id: flowId, actor_id: ctx.actorId, mutation })
      .catch((err: unknown) => c.get('logger')?.warn({ err }, 'realtime publish failed'))
  }

  const setStatus = async (c: Context<AppEnv>, status: FlowStatus, action: string) => {
    const ctx = ctxOf(c)
    const flow = await run(() => store.updateFlow(ctx, c.req.param('id')!, { status }))
    setAudit(c, { action: `flow.${action}`, targetType: 'flow', targetId: flow.id })
    return c.json({ flow: await flowDto(flow) })
  }

  // ---------------------------------------------------------------- fluxos

  app.get('/api/flows', requirePerm('flows.view'), validate('query', listQuery), async (c) => {
    const ctx = ctxOf(c)
    const q = c.req.valid('query')
    const where = [eq(flows.companyId, ctx.companyId)]
    if (q.folder_id === 'root') where.push(isNull(flows.folderId))
    else if (q.folder_id) where.push(eq(flows.folderId, q.folder_id))
    if (q.status) where.push(eq(flows.status, q.status))
    if (q.search) where.push(ilike(flows.name, `%${q.search}%`))
    const rows = await deps.db
      .select()
      .from(flows)
      .where(and(...where))
      .orderBy(flows.folderId, flows.position, flows.createdAt)
    const counts = await nodesCount(rows.map((r) => r.id))
    const folders = await store.listFolders(ctx, q.folder_id === undefined ? {} : { parentFolderId: q.folder_id === 'root' ? null : q.folder_id })
    return c.json({ items: rows.map((r) => toFlowDto(r, counts.get(r.id) ?? 0)), folders: folders.map(toFolderDto) })
  })

  // Antes de `/api/flows/:id`.
  app.get('/api/flows/names', requirePerm('flows.view'), validate('query', namesQuery), async (c) => {
    const ctx = ctxOf(c)
    const triggerable = ['1', 'true'].includes(c.req.valid('query').triggerable ?? '')
    const where = [eq(flows.companyId, ctx.companyId)]
    if (triggerable) where.push(eq(flows.status, 'active'), isNotNull(flows.publishedVersion))
    const rows = await deps.db
      .select({ id: flows.id, name: flows.name })
      .from(flows)
      .where(and(...where))
      .orderBy(flows.name)
    return c.json({ items: rows })
  })

  app.post('/api/flows', requirePerm('flows.edit'), validate('json', createFlowSchema), async (c) => {
    const ctx = ctxOf(c)
    const b = c.req.valid('json')
    const flow = await run(() => store.createFlow(ctx, { name: b.name, description: b.description ?? null, folderId: b.folder_id ?? null, status: 'draft' }))
    setAudit(c, { action: 'flow.create', targetType: 'flow', targetId: flow.id })
    return c.json({ flow: await flowDto(flow) }, 201)
  })

  app.get('/api/flows/:id', requirePerm('flows.view'), async (c) => {
    const flow = await run(() => store.getFlow(ctxOf(c), c.req.param('id')))
    return c.json({ flow: await flowDto(flow) })
  })

  app.get('/api/flows/:id/editor-bundle', requirePerm('flows.view'), async (c) => {
    const ctx = ctxOf(c)
    const id = c.req.param('id')
    const flow = await run(() => store.getFlow(ctx, id))
    const definition = await run(() => store.toDefinition(ctx, id))
    return c.json({ flow: await flowDto(flow), definition })
  })

  app.patch('/api/flows/:id', requirePerm('flows.edit'), validate('json', updateFlowSchema), async (c) => {
    const ctx = ctxOf(c)
    const b = c.req.valid('json')
    const flow = await run(() => store.updateFlow(ctx, c.req.param('id'), { name: b.name, description: b.description }))
    await graphUpdated(c, flow.id, 'update_flow')
    return c.json({ flow: await flowDto(flow) })
  })

  app.get('/api/flows/:id/deletion-impact', requirePerm('flows.view'), async (c) => {
    const ctx = ctxOf(c)
    const flow = await run(() => store.getFlow(ctx, c.req.param('id')))
    return c.json(await deletionImpact(deps.db, ctx, flow.id, deps.flowReferenceSources))
  })

  app.delete('/api/flows/:id', requirePerm('flows.delete'), async (c) => {
    const ctx = ctxOf(c)
    const flow = await run(() => store.getFlow(ctx, c.req.param('id')))
    const impact = await deletionImpact(deps.db, ctx, flow.id, deps.flowReferenceSources)
    const references = [...impact.connection_flow_configs, ...impact.business_hour_configs].filter((r) => BLOCKING_REFERENCE_KINDS.includes(r.kind))
    // T44: `?force=1` desvincula/desativa as configs afetadas e exclui (06 §2.3); sem ele, 409 com a lista.
    const force = ['1', 'true'].includes(c.req.query('force') ?? '')
    if (references.length && !force)
      throw new ApiError('CONFLICT', 'O fluxo é usado por configurações; remova as referências antes de excluir', {
        error_code: 'flow_referenced',
        references,
        connection_flow_configs: impact.connection_flow_configs,
        business_hour_configs: impact.business_hour_configs,
      })
    if (references.length) {
      const detached = await run(() => store.deleteFlowDetaching(ctx, flow.id))
      setAudit(c, { action: 'flow.delete', targetType: 'flow', targetId: flow.id, detail: { force: true, detached } })
      return c.json({ deleted: true, detached })
    }
    await run(() => store.deleteFlow(ctx, flow.id))
    setAudit(c, { action: 'flow.delete', targetType: 'flow', targetId: flow.id })
    return c.json({ deleted: true })
  })

  app.post('/api/flows/:id/validate', requirePerm('flows.view'), async (c) => {
    const def = await run(() => store.toDefinition(ctxOf(c), c.req.param('id')))
    const errors = validateFlow(def)
    setAudit(c, { skip: true })
    return c.json({ valid: errors.length === 0, errors })
  })

  /** Publica o rascunho válido como nova versão e ativa o fluxo. Inválido → 422 com os erros por nó. */
  app.post('/api/flows/:id/activate', requirePerm('flows.edit'), async (c) => {
    const ctx = ctxOf(c)
    const id = c.req.param('id')
    const def = await run(() => store.toDefinition(ctx, id))
    const errors = validateFlow(def)
    if (errors.length) throw new ApiError('VALIDATION_ERROR', 'O fluxo tem erros e não pode ser ativado', { errors })
    const version = await run(() => store.publish(ctx, id))
    // T43/T30: ativar também retoma os runs congelados pela pausa (prazo restante reagendado).
    await flowServices(deps).control.resumeFlow(ctx, id)
    const flow = await run(() => store.getFlow(ctx, id))
    setAudit(c, { action: 'flow.activate', targetType: 'flow', targetId: id, detail: { version: version.version } })
    return c.json({ flow: await flowDto(flow), version: { id: version.id, version: version.version } })
  })

  // T43/T30: pausar congela os runs em espera (timers removidos, prazo restante guardado).
  app.post('/api/flows/:id/pause', requirePerm('flows.edit'), async (c) => {
    const ctx = ctxOf(c)
    const id = c.req.param('id')
    const current = await run(() => store.getFlow(ctx, id))
    const { paused_runs } = await flowServices(deps).control.pauseFlow(ctx, current.id)
    const flow = await run(() => store.getFlow(ctx, id))
    setAudit(c, { action: 'flow.pause', targetType: 'flow', targetId: id, detail: { paused_runs } })
    return c.json({ flow: await flowDto(flow), paused_runs })
  })
  app.post('/api/flows/:id/archive', requirePerm('flows.edit'), (c) => setStatus(c, 'archived', 'archive'))
  app.post('/api/flows/:id/unarchive', requirePerm('flows.edit'), async (c) => {
    const flow = await run(() => store.getFlow(ctxOf(c), c.req.param('id')))
    return setStatus(c, flow.publishedVersion ? 'paused' : 'draft', 'unarchive')
  })

  app.post('/api/flows/:id/duplicate', requirePerm('flows.edit'), async (c) => {
    const ctx = ctxOf(c)
    const source = await run(() => store.getFlow(ctx, c.req.param('id')))
    const def = await run(() => store.toDefinition(ctx, source.id))
    const copy = await run(() =>
      store.createFlow(ctx, { name: `${source.name} (cópia)`, description: source.description, folderId: source.folderId, status: 'draft', position: source.position + 1 }),
    )
    await run(() => store.fromDefinition(ctx, copy.id, remapDefinition(def)))
    setAudit(c, { action: 'flow.duplicate', targetType: 'flow', targetId: copy.id, detail: { source_flow_id: source.id } })
    return c.json({ flow: await flowDto(await store.getFlow(ctx, copy.id)) }, 201)
  })

  app.post('/api/flows/:id/move', requirePerm('flows.edit'), validate('json', moveSchema), async (c) => {
    const flow = await run(() => store.updateFlow(ctxOf(c), c.req.param('id'), { folderId: c.req.valid('json').folder_id }))
    setAudit(c, { action: 'flow.move', targetType: 'flow', targetId: flow.id })
    return c.json({ flow: await flowDto(flow) })
  })

  app.post('/api/flows/:id/reorder', requirePerm('flows.edit'), validate('json', reorderSchema), async (c) => {
    const flow = await run(() => store.updateFlow(ctxOf(c), c.req.param('id'), { position: c.req.valid('json').position }))
    setAudit(c, { action: 'flow.reorder', targetType: 'flow', targetId: flow.id })
    return c.json({ flow: await flowDto(flow) })
  })

  // ---------------------------------------------------------------- rascunho

  app.put('/api/flows/:id/definition', requirePerm('flows.edit'), async (c) => {
    const ctx = ctxOf(c)
    const id = c.req.param('id')
    const definition = await run(async () => store.fromDefinition(ctx, id, await c.req.json()))
    await graphUpdated(c, id, 'replace_definition')
    return c.json({ definition })
  })

  app.post('/api/flows/:id/nodes', requirePerm('flows.edit'), validate('json', nodeSchema), async (c) => {
    const id = c.req.param('id')
    const node = await graph.addNode(ctxOf(c), id, c.req.valid('json'))
    await graphUpdated(c, id, 'add_node')
    return c.json({ node }, 201)
  })

  // Antes de `/api/flows/:id/nodes/:nodeId`.
  app.post('/api/flows/:id/nodes/positions', requirePerm('flows.edit'), validate('json', positionsSchema), async (c) => {
    const id = c.req.param('id')
    const updated = await graph.setPositions(ctxOf(c), id, c.req.valid('json').positions)
    await graphUpdated(c, id, 'reposition_nodes')
    return c.json({ updated })
  })

  app.patch('/api/flows/:id/nodes/:nodeId', requirePerm('flows.edit'), validate('json', nodePatchSchema), async (c) => {
    const id = c.req.param('id')
    const node = await graph.updateNode(ctxOf(c), id, c.req.param('nodeId'), c.req.valid('json'))
    await graphUpdated(c, id, 'update_node')
    return c.json({ node })
  })

  app.delete('/api/flows/:id/nodes/:nodeId', requirePerm('flows.edit'), async (c) => {
    const id = c.req.param('id')
    const r = await graph.deleteNode(ctxOf(c), id, c.req.param('nodeId'))
    await graphUpdated(c, id, 'delete_node')
    return c.json({ deleted: true, removed_edge_ids: r.removedEdgeIds })
  })

  app.post('/api/flows/:id/nodes/:nodeId/actions', requirePerm('flows.edit'), validate('json', z.preprocess(unwrap('flow_node_action'), actionSchema)), async (c) => {
    const id = c.req.param('id')
    const action = await graph.addAction(ctxOf(c), id, c.req.param('nodeId'), c.req.valid('json'))
    await graphUpdated(c, id, 'add_action')
    return c.json({ action }, 201)
  })

  app.patch('/api/flows/:id/nodes/:nodeId/actions/:actionId', requirePerm('flows.edit'), validate('json', actionPatchSchema), async (c) => {
    const id = c.req.param('id')
    const action = await graph.updateAction(ctxOf(c), id, c.req.param('nodeId'), c.req.param('actionId'), c.req.valid('json'))
    await graphUpdated(c, id, 'update_action')
    return c.json({ action })
  })

  app.delete('/api/flows/:id/nodes/:nodeId/actions/:actionId', requirePerm('flows.edit'), async (c) => {
    const id = c.req.param('id')
    await graph.deleteAction(ctxOf(c), id, c.req.param('nodeId'), c.req.param('actionId'))
    await graphUpdated(c, id, 'delete_action')
    return c.json({ deleted: true })
  })

  app.post('/api/flows/:id/connections', requirePerm('flows.edit'), validate('json', connectionSchema), async (c) => {
    const id = c.req.param('id')
    const r = await graph.upsertConnection(ctxOf(c), id, c.req.valid('json'))
    await graphUpdated(c, id, 'add_connection')
    return c.json({ edge: r.edge, replaced_edge_id: r.replacedEdgeId })
  })

  app.delete('/api/flows/:id/connections/:edgeId', requirePerm('flows.edit'), async (c) => {
    const id = c.req.param('id')
    await graph.deleteConnection(ctxOf(c), id, c.req.param('edgeId'))
    await graphUpdated(c, id, 'delete_connection')
    return c.json({ deleted: true })
  })

  // ---------------------------------------------------------------- pastas

  app.get('/api/flow-folders', requirePerm('flows.view'), validate('query', foldersQuery), async (c) => {
    const q = c.req.valid('query')
    const rows = await store.listFolders(ctxOf(c), q.parent_id === undefined ? {} : { parentFolderId: q.parent_id === 'root' ? null : q.parent_id })
    return c.json({ items: rows.map(toFolderDto) })
  })

  app.post('/api/flow-folders', requirePerm('flows.edit'), validate('json', folderSchema), async (c) => {
    const b = c.req.valid('json')
    const folder = await run(() => store.createFolder(ctxOf(c), { name: b.name, color: b.color, parentFolderId: b.parent_id ?? null, position: b.position }))
    setAudit(c, { action: 'flow_folder.create', targetType: 'flow_folder', targetId: folder.id })
    return c.json({ folder: toFolderDto(folder) }, 201)
  })

  app.patch('/api/flow-folders/:id', requirePerm('flows.edit'), validate('json', folderPatchSchema), async (c) => {
    const b = c.req.valid('json')
    const folder = await run(() => store.updateFolder(ctxOf(c), c.req.param('id'), { name: b.name, color: b.color, parentFolderId: b.parent_id, position: b.position }))
    setAudit(c, { action: 'flow_folder.update', targetType: 'flow_folder', targetId: folder.id })
    return c.json({ folder: toFolderDto(folder) })
  })

  app.post('/api/flow-folders/:id/move', requirePerm('flows.edit'), validate('json', folderMoveSchema), async (c) => {
    const folder = await run(() => store.moveFolder(ctxOf(c), c.req.param('id'), c.req.valid('json').parent_id))
    setAudit(c, { action: 'flow_folder.move', targetType: 'flow_folder', targetId: folder.id })
    return c.json({ folder: toFolderDto(folder) })
  })

  // Fluxos e subpastas da pasta excluída vão para a raiz (FK `set null`, T19).
  app.delete('/api/flow-folders/:id', requirePerm('flows.delete'), async (c) => {
    const id = c.req.param('id')
    await run(() => store.deleteFolder(ctxOf(c), id))
    setAudit(c, { action: 'flow_folder.delete', targetType: 'flow_folder', targetId: id })
    return c.json({ deleted: true })
  })

  return app
}
