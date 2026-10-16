// Leituras padrão dos nós de mensagem (T51), na transação do passo (`ctx.repo.db`): destino do run, modelo interno
// (T35) e variáveis globais. No dry-run não há banco: destino de simulação e nada de modelo/globais.
import { sql } from 'drizzle-orm'
import type { Database } from '@crm/db'
import type { TemplateContent } from '../../../content/rules'
import type { NodeContext } from '../../engine/context'

/** Para quem e por qual sessão o nó envia. `phone` em E.164 (`+55…`). */
export interface SendTarget {
  sessionId: string
  phone: string
}

/** Sessão e telefone usados no dry-run (o gateway de simulação aceita qualquer sessão). */
export const DRY_RUN_SESSION = 'dry-run'

export class MessagingTargetError extends Error {
  constructor(
    readonly code: 'no_chat' | 'no_phone' | 'no_session',
    message: string,
  ) {
    super(message)
    this.name = 'MessagingTargetError'
  }
}

const dbOf = (ctx: NodeContext): Database | null => (ctx.repo.db as Database | null) ?? null

async function rows<T>(db: Database, query: ReturnType<typeof sql>): Promise<T[]> {
  const res = await db.execute(query)
  return res.rows as T[]
}

/** Run → chat → conexão (`crm.connections.session_id`); telefone do contato do chat (`phone_e164`). */
export async function defaultResolveTarget(ctx: NodeContext): Promise<SendTarget> {
  const db = dbOf(ctx)
  if (!db) {
    const phone = ctx.contact?.phone_number ? `+${String(ctx.contact.phone_number).replace(/\D/g, '')}` : '+5500000000000'
    return { sessionId: DRY_RUN_SESSION, phone }
  }
  if (!ctx.chatId) throw new MessagingTargetError('no_chat', 'O run não tem chat: não há para quem enviar')
  const [row] = await rows<{ session_id: string | null; phone: string | null }>(
    db,
    sql`select cn.session_id, ct.phone_e164 as phone
        from crm.chats c
        left join crm.connections cn on cn.id = c.connection_id and cn.company_id = c.company_id
        left join crm.contacts ct on ct.id = c.contact_id
        where c.id = ${ctx.chatId} and c.company_id = ${ctx.companyId}
        limit 1`,
  )
  if (!row) throw new MessagingTargetError('no_chat', 'Chat do run não encontrado')
  if (!row.session_id) throw new MessagingTargetError('no_session', 'A conexão do chat não tem sessão do WhatsApp')
  if (!row.phone) throw new MessagingTargetError('no_phone', 'O contato não tem telefone (só LID)')
  return { sessionId: row.session_id, phone: row.phone }
}

/** Modelo interno da empresa (T35) ou `null`. */
export async function defaultLoadTemplate(ctx: NodeContext, id: string): Promise<TemplateContent | null> {
  const db = dbOf(ctx)
  if (!db || !/^[0-9a-f-]{36}$/i.test(id)) return null
  const [row] = await rows<{ header: TemplateContent['header'] | null; body: string; footer: string | null; buttons: TemplateContent['buttons'] | null }>(
    db,
    sql`select header, body, footer, buttons from crm.message_templates where id = ${id} and company_id = ${ctx.companyId} limit 1`,
  )
  if (!row) return null
  return { header: row.header ?? { type: 'none' }, body: row.body, footer: row.footer, buttons: row.buttons ?? [] }
}

/** Mapa `g_nome → valor` (número vira number), como o `globalsMap` da T35. */
export async function defaultGlobals(ctx: NodeContext): Promise<Record<string, unknown>> {
  const db = dbOf(ctx)
  if (!db) return {}
  const list = await rows<{ name: string; type: string; value: string | null }>(
    db,
    sql`select name, type, value from crm.global_variables where company_id = ${ctx.companyId}`,
  )
  return Object.fromEntries(list.map((r) => [r.name, r.type === 'number' && r.value !== null ? Number(r.value) : (r.value ?? '')]))
}
