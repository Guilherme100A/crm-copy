// Conexão WhatsApp real em crm.connections (T40) para suítes que semeiam chats/horários por SQL.
// Desde a T40, crm.chats.connection_id (e member_connections/business_hour_configs) têm FK para crm.connections:
// o id usado no teste precisa existir. Idempotente: o mesmo id (ou session_id) não é criado duas vezes.
import { randomBytes } from 'node:crypto'

type Query = (text: string, params?: unknown[]) => Promise<any[]>

export interface EnsureConnectionOptions {
  /** Id fixo (ex.: o connectionId que o teste já usa no resolver de sessão). Padrão: gerado pelo banco. */
  id?: string
  /** Sessão do gateway (única). Padrão: `test-sess-<rand>`. */
  sessionId?: string
  name?: string
}

/** Garante a conexão e devolve o id. */
export async function ensureConnection(q: Query, companyId: string, opts: EnsureConnectionOptions = {}): Promise<string> {
  const sessionId = opts.sessionId ?? `test-sess-${randomBytes(6).toString('hex')}`
  const name = opts.name ?? `Conexão de teste ${randomBytes(2).toString('hex')}`
  const rows = await q(
    `INSERT INTO crm.connections (id, company_id, session_id, name)
     VALUES (coalesce($1::uuid, gen_random_uuid()), $2, $3, $4)
     ON CONFLICT DO NOTHING RETURNING id`,
    [opts.id ?? null, companyId, sessionId, name],
  )
  if (rows[0]?.id) return rows[0].id
  // já existia (mesmo id ou mesma sessão)
  const [found] = await q(`SELECT id FROM crm.connections WHERE id = coalesce($1::uuid, id) AND (session_id = $2 OR $1::uuid IS NOT NULL) LIMIT 1`, [
    opts.id ?? null,
    sessionId,
  ])
  if (!found) throw new Error(`ensureConnection: não foi possível criar a conexão ${opts.id ?? sessionId}`)
  return found.id
}
