// Indicador de conexões desconectadas no menu (SPEC T107; 18 §5.5, §6): `GET /api/connections/disconnect-alert` diz se
// alguma conexão da empresa ativa caiu nas últimas 24 h. O `open` não zera `disconnected_at`, então a queda continua
// valendo depois de reconectar; conexões agendadas para exclusão não contam. Suporte e quem não tem
// `connections.view` → 403 (owner tem todas as chaves). Montada ANTES de `connectionsRoutes` (`/api/connections/:id`).
import { connections } from '@crm/db'
import { and, desc, eq, gt, isNull } from 'drizzle-orm'
import { Hono } from 'hono'
import { getCompanyCtx } from '../../lib/context'
import { ApiError } from '../../lib/errors'
import type { AppEnv, ResolvedDeps } from '../../lib/types'
import { requirePerm } from '../../middleware/authorize'

export const DISCONNECT_ALERT_WINDOW_MS = 24 * 60 * 60 * 1000

export interface ConnectionsAlertOptions {
  /** Relógio (testes): início da janela de 24 h. */
  now?: () => Date
}

declare module '../../lib/types' {
  interface AppDeps {
    connectionsAlert?: ConnectionsAlertOptions
  }
}

export interface DisconnectAlertDto {
  has_recent_disconnected: boolean
  last_disconnected_at: string | null
}

export function connectionsAlertRoutes(deps: ResolvedDeps) {
  const now = deps.connectionsAlert?.now ?? (() => new Date())
  const app = new Hono<AppEnv>()

  app.get('/api/connections/disconnect-alert', requirePerm('connections.view'), async (c) => {
    const ctx = getCompanyCtx(c)
    // Suporte não vê o indicador (18 §8), nem entrando por concessão.
    if (ctx.supportGrant || ctx.user?.systemRole === 'support')
      throw new ApiError('FORBIDDEN', 'Permissão insuficiente', { permission: 'connections.view' })
    const since = new Date(now().getTime() - DISCONNECT_ALERT_WINDOW_MS)
    const [row] = await deps.db
      .select({ disconnectedAt: connections.disconnectedAt })
      .from(connections)
      .where(
        and(
          eq(connections.companyId, ctx.companyId),
          gt(connections.disconnectedAt, since),
          isNull(connections.scheduledForDeletionAt),
        ),
      )
      .orderBy(desc(connections.disconnectedAt))
      .limit(1)
    const body: DisconnectAlertDto = {
      has_recent_disconnected: !!row,
      last_disconnected_at: row?.disconnectedAt ? row.disconnectedAt.toISOString() : null,
    }
    return c.json(body, 200)
  })

  return app
}
