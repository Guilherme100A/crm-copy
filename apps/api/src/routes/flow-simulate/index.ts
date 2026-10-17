// Simulador de fluxos (T82; 06 §4.4, §5.6): `POST /api/flows/:id/simulate` roda o rascunho no dry-run do motor e devolve
// a transcrição, o caminho e a espera atual. Nada é gravado (nem runs, nem passos) e nenhuma rede é chamada (registry do
// simulador). Simular não altera o fluxo: basta `flows.view`. Protocolo de continuação em `simulator.ts`.
import { Hono } from 'hono'
import { z } from 'zod'
import { FlowStore, FlowStoreError } from '@crm/core'
import { getCompanyCtx } from '../../lib/context'
import { ApiError } from '../../lib/errors'
import { validate } from '../../lib/validate'
import type { AppEnv, ResolvedDeps } from '../../lib/types'
import { requirePerm } from '../../middleware/authorize'
import { SimulateError, simulate } from './simulator'

export { simulate, simulatorRegistry, type SimulationResult } from './simulator'

const simulateSchema = z.object({
  resume: z
    .object({
      node_key: z.string().min(1).max(128),
      handle: z.string().min(1).max(200),
      text: z.string().max(4000).optional(),
    })
    .optional(),
  vars: z.record(z.string(), z.unknown()).optional(),
  steps_so_far: z.number().int().min(0).max(10_000).optional(),
})

const STORE_CODES = {
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  LIMIT_REACHED: 'LIMIT_REACHED',
} as const

export function flowSimulateRoutes(deps: ResolvedDeps) {
  const app = new Hono<AppEnv>()
  const store = new FlowStore(deps.db)

  app.post('/api/flows/:id/simulate', requirePerm('flows.view'), validate('json', simulateSchema), async (c) => {
    const ctx = getCompanyCtx(c)
    let definition
    try {
      definition = await store.toDefinition(
        { companyId: ctx.companyId, userId: ctx.user?.id ?? null },
        c.req.param('id'),
      )
    } catch (err) {
      if (err instanceof FlowStoreError) throw new ApiError(STORE_CODES[err.code], err.message, err.details)
      throw err
    }
    try {
      return c.json({ simulation: await simulate(definition, c.req.valid('json')) })
    } catch (err) {
      if (err instanceof SimulateError)
        throw new ApiError('VALIDATION_ERROR', err.message, {
          fields: [{ path: err.code === 'unknown_node' ? 'resume.node_key' : 'resume.handle', message: err.message }],
        })
      throw err
    }
  })

  return app
}
