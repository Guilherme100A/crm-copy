// Conexões WhatsApp da empresa (T40).
import { connections, type Database } from '@crm/db'
import { eq } from 'drizzle-orm'
import { registerCompanySessionsSource } from '../companies/sessions-source'

export * from './errors'
export * from './status'
export * from './service'

/**
 * Fonte das sessões da empresa para a desativação (T22): todas as sessões das conexões dela.
 * Devolve a função que desfaz o registro.
 */
export function registerConnectionSessionsSource(db: Database): () => void {
  return registerCompanySessionsSource(async (companyId) => {
    const rows = await db.select({ sessionId: connections.sessionId }).from(connections).where(eq(connections.companyId, companyId))
    return rows.map((r) => r.sessionId)
  })
}
