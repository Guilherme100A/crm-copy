// Idempotência dos consumidores (SPEC 3.8: entrega at-least-once). A chave vem do PAYLOAD do evento, nunca do
// id do stream: o mesmo evento republicado tem a mesma chave e o efeito roda uma vez.
import { createHash } from 'node:crypto'
import { processedEvents, type Database } from '@crm/db'
import type { WaEvent } from '@crm/wa-port'
import { and, eq } from 'drizzle-orm'

export type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0]

/** JSON com chaves ordenadas (mesmo payload em qualquer ordem → mesma string). */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

/**
 * Chave de idempotência de um WaEvent:
 * - `message.inbound` → `message.inbound:<session_id>:<message.id>` (SPEC 3.8: `(session_id, message_id)`);
 * - `message.status` → `message.status:<session_id>:<message_id>:<status>`;
 * - demais → `<type>:<sha256 do JSON canônico do evento>`.
 */
export function waEventKey(event: WaEvent): string {
  if (event.type === 'message.inbound') return `message.inbound:${event.session_id}:${event.message.id}`
  if (event.type === 'message.status') return `message.status:${event.session_id}:${event.message_id}:${event.status}`
  return `${event.type}:${createHash('sha256').update(canonicalJson(event)).digest('hex')}`
}

export type RunOnceResult<T> = { executed: true; result: T } | { executed: false }

/**
 * Executa `fn` uma única vez por `(consumer, eventKey)`. A marca em `crm.processed_events` e o efeito ficam na
 * mesma transação: se `fn` lança, nada é marcado (o evento será reprocessado). Duas execuções concorrentes da
 * mesma chave se serializam na unicidade; a segunda vê a marca e não executa.
 */
export async function runOnce<T>(
  db: Database,
  consumer: string,
  eventKey: string,
  fn: (tx: Transaction) => Promise<T> | T,
): Promise<RunOnceResult<T>> {
  return db.transaction(async (tx) => {
    const inserted = await tx
      .insert(processedEvents)
      .values({ consumer, eventKey })
      .onConflictDoNothing()
      .returning({ eventKey: processedEvents.eventKey })
    if (inserted.length === 0) return { executed: false } as const
    return { executed: true, result: await fn(tx) } as const
  })
}

export async function isProcessed(db: Database, consumer: string, eventKey: string): Promise<boolean> {
  const rows = await db
    .select({ eventKey: processedEvents.eventKey })
    .from(processedEvents)
    .where(and(eq(processedEvents.consumer, consumer), eq(processedEvents.eventKey, eventKey)))
    .limit(1)
  return rows.length > 0
}
