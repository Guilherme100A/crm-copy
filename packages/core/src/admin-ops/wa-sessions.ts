// Sessões WhatsApp de todas as empresas para o admin (T96, AC-T96-03). A lista vem do `WaGateway` (perfil `crm`); a
// empresa dona sai de `crm.connections.session_id` (único). Sessão sem conexão no CRM → `company: null` (órfã).
// No modo extensão (`WA_RPC_PROFILE=ai-manager`) a rota não existe: as sessões ficam no painel do ai-manager.
import { eq, inArray } from 'drizzle-orm'
import { companies, connections, type Database } from '@crm/db'
import type { SessionState, WaGateway } from '@crm/wa-port'

/** Perfil do gateway em que o admin do CRM é dono das sessões. */
export const WA_EXTENSION_PROFILE = 'ai-manager'

/** Perfil efetivo: `WA_RPC_PROFILE` do ambiente (default `crm`). Decide pelo nome, não pelo registro do perfil. */
export function waRpcProfile(env: Record<string, string | undefined> = process.env): string {
  return env.WA_RPC_PROFILE?.trim() || 'crm'
}

export const isWaExtensionMode = (profile: string) => profile.trim().toLowerCase() === WA_EXTENSION_PROFILE

export interface AdminWaSessionDto {
  id: string
  name: string
  phone: string | null
  state: SessionState
  requires_restart: boolean
  warmup_started_at: string | null
  last_connected_at: string | null
  created_at: string
  updated_at: string
  connection: { id: string; name: string; connection_state: string | null; scheduled_for_deletion: boolean } | null
  company: { id: string; name: string; active: boolean } | null
}

export interface AdminWaSessionsFilter {
  company_id?: string | undefined
  state?: string | undefined
  /** `true`: só sessões sem empresa no CRM. */
  orphan?: boolean | undefined
}

export async function listAdminWaSessions(
  db: Database,
  gateway: Pick<WaGateway, 'sessions'>,
  filter: AdminWaSessionsFilter = {},
): Promise<AdminWaSessionDto[]> {
  const sessions = await gateway.sessions.list()
  const ids = sessions.map((s) => s.id)
  const owners = ids.length
    ? await db
        .select({
          sessionId: connections.sessionId,
          connectionId: connections.id,
          connectionName: connections.name,
          connectionState: connections.connectionState,
          deletion: connections.scheduledForDeletionAt,
          companyId: companies.id,
          companyName: companies.name,
          companyActive: companies.active,
        })
        .from(connections)
        .innerJoin(companies, eq(companies.id, connections.companyId))
        .where(inArray(connections.sessionId, ids))
    : []
  const bySession = new Map(owners.map((o) => [o.sessionId, o]))
  const items = sessions.map((s): AdminWaSessionDto => {
    const o = bySession.get(s.id)
    return {
      id: s.id,
      name: s.name,
      phone: s.phone,
      state: s.state ?? s.status,
      requires_restart: s.requiresRestart,
      warmup_started_at: s.warmupStartedAt,
      last_connected_at: s.lastConnectedAt,
      created_at: s.createdAt,
      updated_at: s.updatedAt,
      connection: o
        ? {
            id: o.connectionId,
            name: o.connectionName,
            connection_state: o.connectionState,
            scheduled_for_deletion: o.deletion !== null,
          }
        : null,
      company: o ? { id: o.companyId, name: o.companyName, active: o.companyActive } : null,
    }
  })
  return items
    .filter((i) => (filter.company_id ? i.company?.id === filter.company_id : true))
    .filter((i) => (filter.state ? i.state === filter.state : true))
    .filter((i) => (filter.orphan === undefined ? true : filter.orphan === (i.company === null)))
    .sort(
      (a, b) =>
        (a.company?.name ?? '￿').localeCompare(b.company?.name ?? '￿') ||
        a.name.localeCompare(b.name) ||
        a.id.localeCompare(b.id),
    )
}
