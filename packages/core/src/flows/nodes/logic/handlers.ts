// Handlers dos nós de lógica (T41): condição (`success`/`failure`), distribuidor (`output:<id>`, contadores em
// `crm.flow_distributor_counters` + `flow.distributor_updated`), conexão de fluxo (jump para outro fluxo ativo) e
// intervalo inteligente (espera `timer` da T30). Leituras na transação do passo (`ctx.repo.db`); no dry-run não há
// banco: etiquetas/chat/contadores ficam vazios.
import { sql } from 'drizzle-orm'
import type { Database } from '@crm/db'
import type { FlowAction } from '@crm/shared'
import type { NodeContext, NodeHandler } from '../../engine/context'
import { waitDelay } from '../../engine/waits'
import { defaultGlobals } from '../messaging/data'
import { applyGlobals } from '../messaging/handlers'
import { evaluateRules, nextSmartInterval, pickDistributorOutput, type ConditionFacts, type ConditionRule, type DistributorOutput, type SmartIntervalConfig } from './rules'

export interface LogicDeps {
  now?: () => Date
  /** Eventos realtime (`flow.distributor_updated`); sem ele não publica. */
  publisher?: { publish(companyId: string, type: 'flow.distributor_updated', data: never, opts?: object): Promise<unknown> }
  /** Fuso da empresa (padrão `crm.companies.time_zone`; dry-run `America/Sao_Paulo`). */
  timeZone?: (ctx: NodeContext) => Promise<string>
  /** Variáveis globais `g_*` (padrão `defaultGlobals` da T51). */
  globals?: (ctx: NodeContext) => Promise<Record<string, unknown>>
  logger?: { warn(obj: object, msg?: string): void }
}

export class LogicNodeError extends Error {
  constructor(
    readonly code: 'target_flow_inactive' | 'invalid_config',
    message: string,
  ) {
    super(`${code}: ${message}`)
    this.name = 'LogicNodeError'
  }
}

const DEFAULT_TZ = 'America/Sao_Paulo'
const dbOf = (ctx: NodeContext): Database | null => (ctx.repo.db as Database | null) ?? null
const rows = async <T>(db: Database, q: ReturnType<typeof sql>) => (await db.execute(q)).rows as T[]
const actionOf = (ctx: NodeContext, type: string): FlowAction | undefined => ctx.node.actions.find((a) => a.type === type)

async function timeZoneOf(ctx: NodeContext, deps: LogicDeps): Promise<string> {
  if (deps.timeZone) return deps.timeZone(ctx)
  const db = dbOf(ctx)
  if (!db) return DEFAULT_TZ
  const [c] = await rows<{ tz: string | null }>(db, sql`select time_zone as tz from crm.companies where id = ${ctx.companyId}`)
  return c?.tz || DEFAULT_TZ
}

/** Fatos para a condição: etiquetas (contato + chat), chat, contato, globais e tipo da última resposta. */
async function factsOf(ctx: NodeContext, deps: LogicDeps, now: Date): Promise<ConditionFacts> {
  const db = dbOf(ctx)
  const timeZone = await timeZoneOf(ctx, deps)
  const globals = await (deps.globals ?? defaultGlobals)(ctx)
  const ids = new Set<string>()
  const names = new Set<string>()
  let chat: ConditionFacts['chat'] = null
  let contact: ConditionFacts['contact'] = ctx.contact
    ? { name: ctx.contact.full_name ?? null, phone: ctx.contact.phone_number ?? null, email: ctx.contact.email ?? null, customFields: ctx.contact.custom_fields ?? {} }
    : null
  if (db) {
    if (ctx.contactId) {
      const [c] = await rows<{ name: string; phone: string | null; email: string | null; custom_fields: Record<string, unknown> | null }>(
        db,
        sql`select name, phone_e164 as phone, email, custom_fields from crm.contacts where id = ${ctx.contactId} and company_id = ${ctx.companyId}`,
      )
      if (c) contact = { name: c.name, phone: c.phone, email: c.email, customFields: c.custom_fields ?? {} }
    }
    const labelRows = await rows<{ id: string; name: string }>(
      db,
      sql`select l.id, l.name from crm.labels l
          where l.company_id = ${ctx.companyId} and (
            exists (select 1 from crm.contact_labels cl where cl.label_id = l.id and cl.contact_id = ${ctx.contactId ?? null}::uuid)
            or exists (select 1 from crm.chat_labels hl where hl.label_id = l.id and hl.chat_id = ${ctx.chatId ?? null}::uuid))`,
    )
    for (const l of labelRows) {
      ids.add(l.id)
      names.add(l.name.trim().toLowerCase())
    }
    if (ctx.chatId) {
      const [ch] = await rows<{ status: string; assigned_user_id: string | null }>(
        db,
        sql`select status, assigned_user_id from crm.chats where id = ${ctx.chatId} and company_id = ${ctx.companyId}`,
      )
      if (ch) chat = { status: ch.status, assignedUserId: ch.assigned_user_id }
    }
  }
  const reply = ctx.vars.reply as { type?: unknown } | undefined
  return {
    now,
    timeZone,
    labels: { ids, names },
    chat,
    contact,
    globals,
    replyType: typeof reply?.type === 'string' ? reply.type : null,
    render: (s) => ctx.render(applyGlobals(s, globals)),
  }
}

/** Saída anterior deste contato neste nó (prevenir repetição) ou do último contato (distribuir sempre para o próximo). */
async function previousOutput(db: Database, ctx: NodeContext, sameContact: boolean): Promise<string | null> {
  const [r] = await rows<{ handle: string | null }>(
    db,
    sql`select s.result ->> 'handle' as handle
        from crm.flow_run_steps s join crm.flow_runs r on r.id = s.run_id
        where r.company_id = ${ctx.companyId} and r.flow_id = ${ctx.flowId} and s.node_key = ${ctx.node.id} and s.action_key is null
          and s.status = 'done' and s.result ->> 'handle' like 'output:%' and s.run_id <> ${ctx.runId}
          ${sameContact ? sql`and r.contact_id = ${ctx.contactId ?? null}::uuid` : sql``}
        order by s.created_at desc limit 1`,
  )
  return r?.handle ? r.handle.slice('output:'.length) : null
}

export function logicHandlers(deps: LogicDeps = {}): Record<'condition' | 'distributor' | 'connection_flow' | 'smart_interval', NodeHandler> {
  const now = () => (deps.now ? deps.now() : new Date())
  return {
    condition: {
      async execute(ctx) {
        const config = (actionOf(ctx, 'evaluate_condition')?.config ?? {}) as { ruleType?: string; conditions?: ConditionRule[] }
        const facts = await factsOf(ctx, deps, now())
        return { next: evaluateRules(config.ruleType ?? 'all', config.conditions ?? [], facts) ? 'success' : 'failure' }
      },
    },

    distributor: {
      async execute(ctx) {
        const config = (actionOf(ctx, 'distribute_contacts')?.config ?? {}) as { outputs?: DistributorOutput[]; distribute_always_next?: boolean; prevent_repetition?: boolean }
        const outputs = (config.outputs ?? []).filter((o) => o && typeof o.id === 'string' && o.id)
        if (outputs.length === 0) throw new LogicNodeError('invalid_config', 'distribuidor sem saídas')
        const db = dbOf(ctx)
        if (!db) return { next: `output:${pickDistributorOutput(outputs, {})}` }

        if (config.prevent_repetition && ctx.contactId) {
          const before = await previousOutput(db, ctx, true)
          if (before && outputs.some((o) => o.id === before)) return { next: `output:${before}` }
        }
        // Serializa a escolha por nó (o contador decide a próxima saída).
        await db.execute(sql`select pg_advisory_xact_lock(hashtext(${`distributor:${ctx.flowId}:${ctx.node.id}`}))`)
        const counted = await rows<{ output_key: string; count: number }>(
          db,
          sql`select output_key, count from crm.flow_distributor_counters
              where company_id = ${ctx.companyId} and flow_id = ${ctx.flowId} and node_key = ${ctx.node.id}`,
        )
        const counts = Object.fromEntries(counted.map((c) => [c.output_key, c.count]))
        const lastId = config.distribute_always_next ? await previousOutput(db, ctx, false) : null
        const chosen = pickDistributorOutput(outputs, counts, { alwaysNext: config.distribute_always_next === true, lastId })!
        await db.execute(sql`
          insert into crm.flow_distributor_counters (company_id, flow_id, node_key, output_key, count)
          values (${ctx.companyId}, ${ctx.flowId}, ${ctx.node.id}, ${chosen}, 1)
          on conflict (company_id, flow_id, node_key, output_key)
          do update set count = crm.flow_distributor_counters.count + 1, updated_at = now()`)
        counts[chosen] = (counts[chosen] ?? 0) + 1
        if (deps.publisher) {
          try {
            await deps.publisher.publish(ctx.companyId, 'flow.distributor_updated', {
              flow_id: ctx.flowId,
              node_id: ctx.node.id,
              outputs: outputs.map((o) => ({ id: o.id, name: o.name ?? null, quantity: o.quantity ?? null, count: counts[o.id] ?? 0 })),
            } as never)
          } catch (err) {
            deps.logger?.warn({ err, flow_id: ctx.flowId }, 'falha ao publicar flow.distributor_updated')
          }
        }
        return { next: `output:${chosen}` }
      },
    },

    connection_flow: {
      async execute(ctx) {
        const target = String((actionOf(ctx, 'execute_flow')?.config as { target_flow_id?: unknown } | undefined)?.target_flow_id ?? '').trim()
        if (!target) throw new LogicNodeError('invalid_config', 'fluxo de destino não informado')
        const db = dbOf(ctx)
        if (db) {
          const [flow] = /^[0-9a-f-]{36}$/i.test(target)
            ? await rows<{ status: string; published_version: number | null }>(
                db,
                sql`select status, published_version from crm.flows where id = ${target} and company_id = ${ctx.companyId}`,
              )
            : []
          if (!flow || flow.status !== 'active' || flow.published_version === null)
            throw new LogicNodeError('target_flow_inactive', 'o fluxo de destino não existe ou não está ativo')
        }
        // O motor encerra este run (completed) e inicia o destino com o mesmo contato e chat (T25).
        return { jump: { flowId: target } }
      },
    },

    smart_interval: {
      async execute(ctx) {
        const config = (actionOf(ctx, 'smart_interval')?.config ?? {}) as unknown as SmartIntervalConfig
        const at = now()
        const next = nextSmartInterval(config, at, await timeZoneOf(ctx, deps))
        if (next.delayMs <= 0) return { next: 'source' }
        return { wait: waitDelay(next.delayMs, { now: () => at }) as unknown as Record<string, unknown> }
      },
    },
  }
}
