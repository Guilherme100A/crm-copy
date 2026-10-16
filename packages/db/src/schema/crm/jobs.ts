import { index, primaryKey, text, timestamp } from 'drizzle-orm/pg-core'
import { crm } from './schema.js'

// Idempotência dos consumidores de eventos (T09): uma linha por (consumidor, chave do evento) já processado.
// Infraestrutura do worker, sem company_id: a chave vem do evento WhatsApp (ex.: sessão + mensagem).
export const processedEvents = crm.table(
  'processed_events',
  {
    consumer: text('consumer').notNull(),
    eventKey: text('event_key').notNull(),
    processedAt: timestamp('processed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ name: 'processed_events_pk', columns: [t.consumer, t.eventKey] }),
    index('processed_events_processed_at_idx').on(t.processedAt),
  ],
)
