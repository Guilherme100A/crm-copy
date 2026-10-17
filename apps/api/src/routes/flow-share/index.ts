// Compartilhar, importar, exportar e colar nós (T43; 06 §5.1, §5.3, §6): `GET /api/flows/:id/share-code`,
// `POST /api/flows/import`, `GET /api/flows/:id/export`, `POST /api/flows/import-json`, `POST /api/flows/:id/paste-nodes`.
import { randomBytes } from 'node:crypto'
import { Hono, type Context } from 'hono'
import { and, eq, gt, inArray, isNull, or } from 'drizzle-orm'
import { z } from 'zod'
import { FlowStore, FlowStoreError, type FlowRow } from '@crm/core'
import { flowShareCodes } from '@crm/db'
import { validate as validateFlow, type FlowDefinition } from '@crm/shared/flows'
import { getCompanyCtx } from '../../lib/context'
import { ApiError } from '../../lib/errors'
import { validate } from '../../lib/validate'
import type { AppEnv, ResolvedDeps } from '../../lib/types'
import { requirePerm } from '../../middleware/authorize'
import { setAudit } from '../../middleware/audit'
import { FlowGraph, genKey } from '../flows/graph'
import { remapDefinition, toFlowDto } from '../flows/index'
import { flowServices } from '../flow-runs/services'
import { mediaServiceFor } from '../media/index'
import { copyMedia, ensureLabels, fixFlowReferences, labelNamesOf, type TransferWarning } from './transfer'

export const FLOW_EXPORT_FORMAT = 'crm.flow.export/v1'
/** Deslocamento dos nós colados sem posição (06 §5.3). */
export const PASTE_OFFSET = { x: 50, y: 50 } as const
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

export function generateShareCode(length = 10): string {
  const bytes = randomBytes(length)
  return [...bytes].map((b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('')
}

const importSchema = z.object({ codes: z.array(z.string().trim().min(1).max(64)).min(1).max(50) })
const exportSchema = z.object({
  format: z.string().optional(),
  flow: z.object({ name: z.string().trim().max(120).optional(), description: z.string().max(2000).nullish() }).optional(),
  definition: z.unknown(),
})
const pasteSchema = z.object({
  source_flow_id: z.uuid(),
  nodes: z
    .array(z.object({ id: z.string().min(1).max(64), position: z.object({ x: z.number().finite(), y: z.number().finite() }).optional() }))
    .min(1)
    .max(200),
})

async function store404<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (err) {
    if (err instanceof FlowStoreError) throw new ApiError(err.code === 'NOT_FOUND' ? 'NOT_FOUND' : err.code, err.message, err.details)
    throw err
  }
}

export function flowShareRoutes(deps: ResolvedDeps) {
  const app = new Hono<AppEnv>()
  const store = new FlowStore(deps.db)
  const graph = new FlowGraph(deps.db)

  const ctxOf = (c: Context<AppEnv>) => {
    const ctx = getCompanyCtx(c)
    return { companyId: ctx.companyId, userId: ctx.user?.id ?? null }
  }

  /** Cria a cópia (draft, na raiz) com ids novos, etiquetas, mídias e referências ajustadas para a empresa destino. */
  async function materialize(
    ctx: { companyId: string; userId: string | null },
    flow: FlowRow,
    def: FlowDefinition,
    copy: FlowRow,
    remap: Map<string, string>,
  ): Promise<{ definition: FlowDefinition; warnings: TransferWarning[] }> {
    const warnings: TransferWarning[] = []
    const next = remapDefinition(def)
    await ensureLabels(deps.db, ctx.companyId, labelNamesOf(next))
    await copyMedia(mediaServiceFor(deps), next, flow.companyId, ctx.companyId, warnings)
    await fixFlowReferences(deps.db, next, ctx.companyId, remap, warnings)
    const definition = await store404(() => store.fromDefinition(ctx, copy.id, next))
    return { definition, warnings }
  }

  app.get('/api/flows/:id/share-code', requirePerm('flows.view'), async (c) => {
    const ctx = ctxOf(c)
    const flow = await store404(() => store.getFlow(ctx, c.req.param('id')))
    const now = new Date()
    const [active] = await deps.db
      .select({ code: flowShareCodes.code })
      .from(flowShareCodes)
      .where(
        and(
          eq(flowShareCodes.flowId, flow.id),
          eq(flowShareCodes.companyId, ctx.companyId),
          isNull(flowShareCodes.revokedAt),
          or(isNull(flowShareCodes.expiresAt), gt(flowShareCodes.expiresAt, now)),
        ),
      )
      .limit(1)
    if (active) return c.json({ code: active.code })
    for (let i = 0; i < 5; i++) {
      const code = generateShareCode()
      const [row] = await deps.db
        .insert(flowShareCodes)
        .values({ companyId: ctx.companyId, flowId: flow.id, code, createdByUserId: ctx.userId })
        .onConflictDoNothing()
        .returning({ code: flowShareCodes.code })
      if (row) return c.json({ code: row.code })
    }
    throw new Error('não foi possível gerar um código de compartilhamento')
  })

  // Importa por códigos (de qualquer empresa): cópia independente, status draft, na raiz.
  app.post('/api/flows/import', requirePerm('flows.edit'), validate('json', importSchema), async (c) => {
    const ctx = ctxOf(c)
    // Códigos sem diferenciar maiúsculas; a resposta ecoa o código como o cliente mandou.
    const codes = [...new Set(c.req.valid('json').codes)]
    const now = new Date()
    const rows = await deps.db
      .select({ code: flowShareCodes.code, flowId: flowShareCodes.flowId, companyId: flowShareCodes.companyId })
      .from(flowShareCodes)
      .where(
        and(
          inArray(flowShareCodes.code, codes.map((s) => s.toUpperCase())),
          isNull(flowShareCodes.revokedAt),
          or(isNull(flowShareCodes.expiresAt), gt(flowShareCodes.expiresAt, now)),
        ),
      )
    const byUpper = new Map(rows.map((r) => [r.code, r]))
    const byCode = new Map(codes.flatMap((code) => (byUpper.has(code.toUpperCase()) ? [[code, byUpper.get(code.toUpperCase())!] as const] : [])))
    const errors = codes.filter((code) => !byCode.has(code)).map((code) => ({ code, reason: 'invalid_code' as const }))

    // 1ª passada: cria as cópias (para remapear referências entre fluxos importados juntos).
    const sources: Array<{ code: string; flow: FlowRow; def: FlowDefinition; copy: FlowRow }> = []
    const remap = new Map<string, string>()
    for (const code of codes) {
      const ref = byCode.get(code)
      if (!ref) continue
      const src = { companyId: ref.companyId }
      const flow = await store.getFlow(src, ref.flowId)
      const def = await store.toDefinition(src, ref.flowId)
      // Limite de fluxos (T95) → 409 LIMIT_REACHED, como no create/duplicate (T44).
      const copy = await store404(() => store.createFlow(ctx, { name: flow.name, description: flow.description, status: 'draft' }))
      remap.set(flow.id, copy.id)
      sources.push({ code, flow, def, copy })
    }
    const items = []
    for (const s of sources) {
      const { warnings } = await materialize(ctx, s.flow, s.def, s.copy, remap)
      items.push({ code: s.code, flow: toFlowDto(await store.getFlow(ctx, s.copy.id)), warnings })
    }
    setAudit(c, { action: 'flow.import', targetType: 'flow', detail: { codes: codes.length, imported: items.length } })
    return c.json({ items, errors }, 201)
  })

  app.get('/api/flows/:id/export', requirePerm('flows.view'), async (c) => {
    const ctx = ctxOf(c)
    const flow = await store404(() => store.getFlow(ctx, c.req.param('id')))
    const definition = await store.toDefinition(ctx, flow.id)
    return c.json({
      format: FLOW_EXPORT_FORMAT,
      exported_at: new Date().toISOString(),
      flow: { name: flow.name, description: flow.description },
      definition,
      labels: labelNamesOf(definition),
    })
  })

  /** Importa um export JSON como rascunho; devolve os erros do `validate` (T10) sem recusar o rascunho. */
  app.post('/api/flows/import-json', requirePerm('flows.edit'), validate('json', exportSchema), async (c) => {
    const ctx = ctxOf(c)
    const body = c.req.valid('json')
    if (body.format !== undefined && body.format !== FLOW_EXPORT_FORMAT)
      throw new ApiError('VALIDATION_ERROR', 'Formato de exportação desconhecido', { fields: [{ path: 'format', message: `use ${FLOW_EXPORT_FORMAT}` }] })
    const copy = await store404(() => store.createFlow(ctx, { name: body.flow?.name || undefined, description: body.flow?.description ?? null, status: 'draft' }))
    try {
      // Estrutura: a mesma conferência do rascunho (T19); inválida → 422 e a cópia é removida.
      const parsed = await store404(() => store.fromDefinition(ctx, copy.id, body.definition))
      const { definition, warnings } = await materialize(ctx, { ...copy, companyId: ctx.companyId }, parsed, copy, new Map())
      setAudit(c, { action: 'flow.import_json', targetType: 'flow', targetId: copy.id })
      return c.json({ flow: toFlowDto(await store.getFlow(ctx, copy.id)), warnings, validation_errors: validateFlow(definition) }, 201)
    } catch (err) {
      await store.deleteFlow(ctx, copy.id).catch(() => undefined)
      throw err
    }
  })

  /** Cola nós de outro fluxo da mesma empresa: ids novos, posição enviada (ou +50/+50) e arestas internas. */
  app.post('/api/flows/:id/paste-nodes', requirePerm('flows.edit'), validate('json', pasteSchema), async (c) => {
    const ctx = ctxOf(c)
    const targetId = c.req.param('id')
    const b = c.req.valid('json')
    await store404(() => store.getFlow(ctx, targetId))
    const source = await store404(() => store.toDefinition(ctx, b.source_flow_id))
    const wanted = new Map(b.nodes.map((n) => [n.id, n.position]))
    const picked = source.nodes.filter((n) => wanted.has(n.id) && n.type !== 'start' && n.id !== source.entry)
    if (!picked.length) throw new ApiError('VALIDATION_ERROR', 'Nenhum nó válido para colar', { fields: [{ path: 'nodes', message: 'nós inexistentes ou só o Início' }] })
    const keyOf = new Map(picked.map((n) => [n.id, genKey('node')]))
    const nodes = []
    for (const n of picked) {
      const pos = wanted.get(n.id) ?? { x: n.position.x + PASTE_OFFSET.x, y: n.position.y + PASTE_OFFSET.y }
      nodes.push(
        await graph.addNode(ctx, targetId, {
          id: keyOf.get(n.id),
          type: n.type,
          name: n.name,
          description: n.description ?? null,
          position: pos,
          actions: n.actions.map((a) => ({ type: a.type, order: a.order, config: a.config })),
        }),
      )
    }
    const edges = []
    for (const e of source.edges) {
      const from = keyOf.get(e.from)
      const to = keyOf.get(e.to)
      if (from && to) edges.push((await graph.upsertConnection(ctx, targetId, { from, handle: e.handle, to })).edge)
    }
    await flowServices(deps)
      .publisher.publish(ctx.companyId, 'flow.graph_updated', { flow_id: targetId, actor_id: ctx.userId, mutation: 'paste_nodes' })
      .catch(() => undefined)
    setAudit(c, { action: 'flow.paste_nodes', targetType: 'flow', targetId, detail: { source_flow_id: b.source_flow_id, nodes: nodes.length } })
    return c.json({ nodes, edges }, 201)
  })

  return app
}
