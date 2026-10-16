// Handlers dos nós de CRM (T63): etiquetas, controle do chat, departamento, kanban, manipulador, venda aprovada e
// agente de IA. Reaproveitam os serviços dos módulos (contatos T26, ciclo de vida do chat T48, kanban T50, vendas
// T34) com ator de sistema; efeitos externos únicos (venda, push) passam por `ctx.once` (retry do passo não repete).
// Erros lançados seguem a aresta `failure` do nó, se houver; senão o run termina `failed` com o código.
import { and, eq, sql } from 'drizzle-orm'
import { chatEvents, chats, contacts, kanbanCards, labels, products, type Database } from '@crm/db'
import type { FlowAction } from '@crm/shared'
import { ChatLifecycleService } from '../../../chats/lifecycle/service'
import { emitChatResolved } from '../../../chats/lifecycle/hooks'
import { ChatQueryService } from '../../../chats/query/service'
import { ContactsService } from '../../../contacts/service'
import { KanbanService, createKanbanCard, systemActor } from '../../../kanban/service'
import type { RealtimePublisher } from '../../../realtime/publisher'
import { SalesService } from '../../../sales/service'
import type { NodeContext, NodeHandler, NodeOutcome } from '../../engine/context'
import { defaultGlobals } from '../messaging/data'
import { applyGlobals } from '../messaging/handlers'
import { cardValueCents, chatStatusOf, formatMoney, manipulate, parseCreatedAt, saleAmountCents } from './rules'

export interface CrmDeps {
  /** Eventos realtime (contact.updated, chat.updated, kanban.*, sale.recorded, notification.created). */
  publisher?: Pick<RealtimePublisher, 'publish'>
  now?: () => Date
  /** Fuso da empresa (padrão `crm.companies.time_zone`). */
  timeZone?: (ctx: NodeContext) => Promise<string>
  logger?: { warn(obj: object, msg?: string): void }
}

export class CrmNodeError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(`${code}: ${message}`)
    this.name = 'CrmNodeError'
  }
}

/** Cor das etiquetas criadas pelo fluxo. */
export const FLOW_LABEL_COLOR = '#3B82F6'
const DEFAULT_TZ = 'America/Sao_Paulo'
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

type Config = Record<string, unknown>
const next: NodeOutcome = { next: 'source' }
const actionsOf = (ctx: NodeContext, ...types: string[]): FlowAction[] => [...ctx.node.actions].filter((a) => types.includes(a.type)).sort((a, b) => a.order - b.order)
const configOf = (ctx: NodeContext, ...types: string[]): Config => (actionsOf(ctx, ...types)[0]?.config ?? {}) as Config

/** Banco do processo para os serviços (a transação do passo fica para leituras do próprio nó). */
function dbOf(ctx: NodeContext): Database {
  const db = ctx.repo.db as Database | null
  if (!db) throw new CrmNodeError('dry_run', 'nó de CRM não executa no dry-run')
  return db
}
const requireChat = (ctx: NodeContext): string => {
  if (!ctx.chatId) throw new CrmNodeError('no_chat', 'o run não tem chat')
  return ctx.chatId
}
const requireContact = (ctx: NodeContext): string => {
  if (!ctx.contactId) throw new CrmNodeError('no_contact', 'o run não tem contato')
  return ctx.contactId
}

async function publish(deps: CrmDeps, companyId: string, type: string, data: unknown, opts?: object): Promise<void> {
  if (!deps.publisher) return
  try {
    await deps.publisher.publish(companyId, type as never, data as never, opts as never)
  } catch (err) {
    deps.logger?.warn({ err, type }, 'falha ao publicar evento do nó de CRM')
  }
}

async function contactUpdated(db: Database, deps: CrmDeps, companyId: string, contactId: string): Promise<void> {
  const contact = await new ContactsService({ db }).get(companyId, contactId)
  await publish(deps, companyId, 'contact.updated', { contact_id: contactId, contact })
}

async function timeZoneOf(ctx: NodeContext, deps: CrmDeps, db: Database): Promise<string> {
  if (deps.timeZone) return deps.timeZone(ctx)
  const [c] = (await db.execute(sql`select time_zone as tz from crm.companies where id = ${ctx.companyId}`)).rows as Array<{ tz: string | null }>
  return c?.tz || DEFAULT_TZ
}

async function renderer(ctx: NodeContext): Promise<(s: string) => string> {
  const globals = /\{\{\s*global\.|\{\s*g_/.test(JSON.stringify(ctx.node.actions)) ? await defaultGlobals(ctx) : {}
  return (s: string) => ctx.render(applyGlobals(s, globals))
}

const lifecycle = (db: Database, deps: CrmDeps) => new ChatLifecycleService({ db, ...(deps.publisher ? { publisher: deps.publisher as never } : {}) })

/** Etiqueta por nome (sem caixa); cria se `create`. */
async function labelId(db: Database, companyId: string, name: string, create: boolean): Promise<string | null> {
  const find = async () =>
    ((await db.select({ id: labels.id }).from(labels).where(and(eq(labels.companyId, companyId), sql`lower(${labels.name}) = ${name.toLowerCase()}`)))[0]?.id ?? null)
  const existing = await find()
  if (existing || !create) return existing
  const [row] = await db.insert(labels).values({ companyId, name, color: FLOW_LABEL_COLOR }).onConflictDoNothing().returning({ id: labels.id })
  return row?.id ?? find()
}

export function crmHandlers(deps: CrmDeps = {}): Record<'tags' | 'chat_controller' | 'department' | 'kanban' | 'manipulator' | 'approved_sale' | 'ai_agent', NodeHandler> {
  return {
    tags: {
      async execute(ctx) {
        const db = dbOf(ctx)
        const contactId = requireContact(ctx)
        const render = await renderer(ctx)
        let changed = false
        for (const action of actionsOf(ctx, 'add_tags', 'remove_tags')) {
          const add = action.type === 'add_tags'
          const names = [...new Set(((action.config as Config).tags as unknown[] | undefined ?? []).map((t) => render(String(t)).trim()).filter(Boolean))]
          for (const name of names) {
            const id = await labelId(db, ctx.companyId, name, add)
            if (!id) continue
            const res = add
              ? await db.execute(sql`insert into crm.contact_labels (company_id, contact_id, label_id) values (${ctx.companyId}, ${contactId}, ${id}) on conflict do nothing returning label_id`)
              : await db.execute(sql`delete from crm.contact_labels where contact_id = ${contactId} and label_id = ${id} returning label_id`)
            if (res.rows.length) changed = true
          }
        }
        if (changed) {
          await db.update(contacts).set({ updatedAt: new Date() }).where(eq(contacts.id, contactId))
          await contactUpdated(db, deps, ctx.companyId, contactId)
        }
        return next
      },
    },

    chat_controller: {
      async execute(ctx) {
        const db = dbOf(ctx)
        const chatId = requireChat(ctx)
        const raw = configOf(ctx, 'change_chat_status').chat_status
        const status = chatStatusOf(raw)
        if (!status) throw new CrmNodeError('invalid_chat_status', `status inválido: ${String(raw)} (use waiting, attending ou resolved)`)
        const [chat] = await db.select().from(chats).where(and(eq(chats.id, chatId), eq(chats.companyId, ctx.companyId)))
        if (!chat) throw new CrmNodeError('no_chat', 'chat não encontrado')
        if (chat.status === status) return next
        const now = deps.now ? deps.now() : new Date()
        const patch: Partial<typeof chats.$inferInsert> = { status, updatedAt: now }
        if (status === 'resolved') patch.resolvedAt = now
        if (status === 'waiting') Object.assign(patch, { assignedUserId: null, resolvedAt: null, ...(chat.status === 'resolved' ? { openedAt: now } : {}) })
        const updated = await db.transaction(async (tx) => {
          const [row] = await tx.update(chats).set(patch).where(eq(chats.id, chat.id)).returning()
          await tx.insert(chatEvents).values({ companyId: ctx.companyId, chatId: chat.id, type: 'status_changed', actorUserId: null, detail: { from: chat.status, to: status, by: 'flow', run_id: ctx.runId } })
          return row!
        })
        const [dto] = await new ChatQueryService(db).decorate([updated])
        await publish(deps, ctx.companyId, 'chat.updated', { chat_id: updated.id, chat: dto }, { scope: { connection_id: updated.connectionId, department_id: updated.departmentId } })
        if (status === 'resolved') await emitChatResolved({ companyId: ctx.companyId, chatId: chat.id, actorUserId: null })
        return next
      },
    },

    department: {
      async execute(ctx) {
        const db = dbOf(ctx)
        const chatId = requireChat(ctx)
        const departmentId = String(configOf(ctx, 'set_department').department_id ?? '').trim()
        if (!UUID_RE.test(departmentId)) throw new CrmNodeError('invalid_department', 'departamento inválido')
        await lifecycle(db, deps).update(systemActor(ctx.companyId), chatId, { department_id: departmentId })
        return next
      },
    },

    kanban: {
      async execute(ctx) {
        const db = dbOf(ctx)
        const chatId = requireChat(ctx)
        const kanban = new KanbanService({ db, ...(deps.publisher ? { publisher: deps.publisher as RealtimePublisher } : {}) })
        const render = await renderer(ctx)
        for (const action of actionsOf(ctx, 'create_kanban_card', 'remove_kanban_card')) {
          const c = action.config as Config
          const crmId = String(c.crm_id ?? '').trim()
          if (action.type === 'create_kanban_card') {
            const raw = c.value === undefined || c.value === null || c.value === '' ? undefined : typeof c.value === 'number' ? c.value : render(String(c.value))
            const valueCents = raw === undefined ? undefined : cardValueCents(raw)
            await createKanbanCard(kanban, { companyId: ctx.companyId }, { crmId, columnId: String(c.crm_column_id ?? '').trim(), chatId, ...(valueCents !== undefined ? { valueCents } : {}) })
          } else {
            const [card] = UUID_RE.test(crmId)
              ? await db
                  .select({ id: kanbanCards.id })
                  .from(kanbanCards)
                  .where(and(eq(kanbanCards.companyId, ctx.companyId), eq(kanbanCards.crmId, crmId), eq(kanbanCards.chatId, chatId)))
              : []
            if (card) await kanban.deleteCard(systemActor(ctx.companyId), crmId, card.id)
          }
        }
        return next
      },
    },

    manipulator: {
      async execute(ctx) {
        const db = dbOf(ctx)
        const contactId = requireContact(ctx)
        const render = await renderer(ctx)
        for (const action of actionsOf(ctx, 'set_contact_custom_field', 'set_created_at')) {
          const c = action.config as Config
          const value = typeof c.value === 'string' ? render(c.value) : c.value
          if (action.type === 'set_created_at') {
            const at = parseCreatedAt(String(value ?? ''), await timeZoneOf(ctx, deps, db))
            if (!at) throw new CrmNodeError('invalid_date', `data inválida: ${String(value)} (use dd/MM/aaaa HH:mm:ss ou ISO)`)
            await db.update(contacts).set({ createdAt: at, updatedAt: new Date() }).where(and(eq(contacts.id, contactId), eq(contacts.companyId, ctx.companyId)))
            continue
          }
          const field = String(c.field_name ?? '').trim()
          if (!field) throw new CrmNodeError('invalid_config', 'campo não informado')
          const [row] = await db
            .select({ fields: contacts.customFields })
            .from(contacts)
            .where(and(eq(contacts.id, contactId), eq(contacts.companyId, ctx.companyId)))
          const result = manipulate((row?.fields ?? {})[field], String(c.operation ?? 'set_value'), value, typeof c.value_type === 'string' ? c.value_type : undefined)
          await db.execute(sql`
            update crm.contacts set custom_fields = coalesce(custom_fields, '{}'::jsonb) || jsonb_build_object(${field}::text, ${JSON.stringify(result)}::jsonb), updated_at = now()
            where id = ${contactId} and company_id = ${ctx.companyId}`)
        }
        await contactUpdated(db, deps, ctx.companyId, contactId)
        return next
      },
    },

    approved_sale: {
      async execute(ctx) {
        const db = dbOf(ctx)
        const c = configOf(ctx, 'register_approved_sale')
        const render = await renderer(ctx)
        const publicId = String(c.product_public_id ?? '').trim()
        const [product] = UUID_RE.test(publicId) ? await db.select().from(products).where(and(eq(products.companyId, ctx.companyId), eq(products.publicId, publicId))) : []
        if (!product) throw new CrmNodeError('product_not_found', 'produto não encontrado')
        const amount = saleAmountCents(render(typeof c.amount_template === 'string' && c.amount_template ? c.amount_template : '{comprovante.valor}'), product)
        const currencyRaw = render(typeof c.currency_template === 'string' && c.currency_template ? c.currency_template : '{comprovante.currency}').trim().toUpperCase()
        const currency = /^[A-Z]{3}$/.test(currencyRaw) ? currencyRaw : product.currency
        let customer = render(typeof c.customer_name_template === 'string' && c.customer_name_template ? c.customer_name_template : '{comprovante.nome_pagador}').trim()
        let connectionId: string | null = null
        if (ctx.chatId) {
          const [chat] = await db.select({ connectionId: chats.connectionId }).from(chats).where(eq(chats.id, ctx.chatId))
          connectionId = chat?.connectionId ?? null
        }
        if (!customer && ctx.contactId) customer = ((await db.select({ name: contacts.name }).from(contacts).where(eq(contacts.id, ctx.contactId)))[0]?.name ?? '').trim()

        // Venda e push uma vez por (run, nó): o retry do passo devolve o resultado salvo.
        const result = await ctx.once('approved_sale', async () => {
          const { sale, created } = await new SalesService({ db, ...(deps.publisher ? { publisher: deps.publisher as never } : {}) }).record({
            companyId: ctx.companyId,
            source: 'flow',
            externalId: `run-${ctx.runId}-${ctx.node.id}`,
            amountCents: amount.cents,
            currency,
            contactId: ctx.contactId,
            connectionId,
            productId: product.id,
            customerName: customer || null,
            noteIssuerId: typeof c.note_issuer_id === 'string' && c.note_issuer_id.trim() ? c.note_issuer_id.trim() : null,
            utmifyIntegrationId: typeof c.utmify_integration_id === 'string' && c.utmify_integration_id.trim() ? c.utmify_integration_id.trim() : null,
          })
          return { saleId: sale.id, created }
        })
        ctx.setVar('venda', { id: result.saleId, valor: formatMoney(amount.cents), moeda: currency, cliente: customer, fallback: amount.fallback })

        const titleT = typeof c.push_title_template === 'string' ? c.push_title_template : ''
        const bodyT = typeof c.push_body_template === 'string' ? c.push_body_template : ''
        if (result.created && (titleT.trim() || bodyT.trim())) {
          const saleVars: Record<string, string> = { 'produto.nome': product.name, 'venda.valor': formatMoney(amount.cents), 'venda.moeda': currency, 'venda.cliente': customer }
          const fill = (t: string) => render(t.replace(/\{\s*(produto\.nome|venda\.valor|venda\.moeda|venda\.cliente)\s*\}/g, (_m, k: string) => saleVars[k] ?? ''))
          await ctx.once('approved_sale_push', async () => {
            await publish(deps, ctx.companyId, 'notification.created', { title: fill(titleT), body: fill(bodyT), url: null, kind: 'approved_sale', sale_id: result.saleId })
            return true
          })
        }
        return next
      },
    },

    ai_agent: {
      async execute(ctx) {
        const db = dbOf(ctx)
        const chatId = requireChat(ctx)
        const c = configOf(ctx, 'control_ai_agent')
        const agentId = c.mode === 'activate' ? String(c.agent_id ?? '').trim() : null
        if (c.mode === 'activate' && !UUID_RE.test(agentId ?? '')) throw new CrmNodeError('invalid_agent', 'agente inválido')
        await lifecycle(db, deps).update(systemActor(ctx.companyId), chatId, { ai_agent_id: agentId })
        return next
      },
    },
  }
}
