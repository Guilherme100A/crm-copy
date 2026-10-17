// Conexões WhatsApp da empresa (T40).
import { connections, type Database } from '@crm/db'
import { registerCompanySessionsSource } from '../companies/sessions-source'
import { crmManagedOf } from './service'

export * from './errors'
export * from './status'
export * from './service'

/**
 * Fonte das sessões da empresa para a desativação (T22): as sessões das conexões criadas pelo CRM (chips importados
 * do ai-manager ficam de fora). Devolve a função que desfaz o registro.
 */
export function registerConnectionSessionsSource(db: Database): () => void {
  return registerCompanySessionsSource(async (companyId) => {
    const rows = await db.select({ sessionId: connections.sessionId }).from(connections).where(crmManagedOf(companyId))
    return rows.map((r) => r.sessionId)
  })
}
