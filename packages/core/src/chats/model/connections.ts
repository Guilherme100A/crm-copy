// Sessão do WhatsApp → empresa e conexão do CRM. A tabela `crm.connections` (1:1 com a sessão) é da T40; até lá,
// o resolver padrão consulta-a se existir e devolve `null` (evento ignorado) se a tabela ou a sessão não existirem.
import { sql } from 'drizzle-orm'
import type { Database } from '@crm/db'

export interface ResolvedConnection {
  companyId: string
  connectionId: string
}

export type ConnectionResolver = (sessionId: string) => Promise<ResolvedConnection | null>

/** `42P01` = relação inexistente (crm.connections antes da T40). */
const isUndefinedTable = (err: unknown) => {
  for (let e: unknown = err, i = 0; e && i < 4; e = (e as { cause?: unknown }).cause, i++) if ((e as { code?: unknown }).code === '42P01') return true
  return false
}

/** Resolver padrão: `select id, company_id from crm.connections where session_id = $1`. */
export function crmConnectionsResolver(db: Database): ConnectionResolver {
  return async (sessionId) => {
    try {
      const res = await db.execute(sql`select id, company_id from crm.connections where session_id = ${sessionId} limit 1`)
      const row = res.rows[0] as { id?: string; company_id?: string } | undefined
      return row?.id && row.company_id ? { companyId: row.company_id, connectionId: row.id } : null
    } catch (err) {
      if (isUndefinedTable(err)) return null
      throw err
    }
  }
}
