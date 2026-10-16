// Envio de um destinatário (T74): inicia o fluxo do alvo para o contato (FlowEngine.startRun) e executa o 1º passo
// na hora, com o gateway embrulhado para capturar a rejeição do pipeline (gates e antiban do WaGateway). Assim o
// agendador distingue limite (reagendar), contato bloqueado (skipped) e conexão caída (pausar o alvo).
import { and, eq, sql } from 'drizzle-orm'
import { chats, type Database } from '@crm/db'
import type { SendRejectionCode, WaGateway } from '@crm/wa-port'
import type { FlowControl } from '../flows/engine/control'
import { FlowEngine, type FlowEngineOptions } from '../flows/engine/runner'

export interface StartInput {
  companyId: string
  dispatchId: string
  recipientId: string
  contactId: string
  connectionId: string
  flowId: string
}

/** Códigos que o agendador trata; o resto vira `failed`. */
export type StartFailureCode = 'RATE_LIMIT' | 'WARMUP_LIMIT' | 'CONTACT_NOT_ALLOWED' | 'SESSION_NOT_CONNECTED' | 'error'

export type StartResult = { ok: true; runId: string } | { ok: false; code: StartFailureCode; message: string; runId?: string | null }

export interface MassDispatchStarter {
  start(input: StartInput): Promise<StartResult>
}

const HANDLED = new Set<string>(['RATE_LIMIT', 'WARMUP_LIMIT', 'CONTACT_NOT_ALLOWED', 'SESSION_NOT_CONNECTED'])

function rejectionCode(err: unknown): SendRejectionCode | null {
  const e = err as { name?: unknown; code?: unknown } | null
  return e && e.name === 'SendRejectedError' && typeof e.code === 'string' ? (e.code as SendRejectionCode) : null
}

/** Gateway que guarda a última rejeição de envio (o motor transforma o erro do nó em texto). */
function capturing(wa: WaGateway): { gateway: WaGateway; last: () => { code: SendRejectionCode; message: string } | null } {
  let last: { code: SendRejectionCode; message: string } | null = null
  const gateway = new Proxy(wa, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target) as unknown
      if (prop !== 'send' && prop !== 'sendGroup') return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value
      return async (...args: unknown[]) => {
        try {
          return await (value as (...a: unknown[]) => Promise<unknown>).apply(target, args)
        } catch (err) {
          const code = rejectionCode(err)
          if (code) last = { code, message: err instanceof Error ? err.message : String(err) }
          throw err
        }
      }
    },
  }) as WaGateway
  return { gateway, last: () => last }
}

/** Chat do contato na conexão (cria se não existir; único por empresa+conexão+contato). */
export async function ensureChat(db: Database, companyId: string, connectionId: string, contactId: string): Promise<string> {
  await db.insert(chats).values({ companyId, connectionId, contactId }).onConflictDoNothing()
  const [row] = await db
    .select({ id: chats.id })
    .from(chats)
    .where(and(eq(chats.companyId, companyId), eq(chats.connectionId, connectionId), eq(chats.contactId, contactId)))
    .limit(1)
  if (!row) throw new Error('chat do destinatário não encontrado')
  return row.id
}

export interface FlowEngineStarterOptions {
  db: Database
  wa: WaGateway
  /** Cancela o run ativo do contato antes de iniciar (AC-T74-05). */
  control?: Pick<FlowControl, 'cancelForContact'>
  /** Opções extras do motor (registry, hooks de timers da T30, logger…). */
  engine?: Omit<FlowEngineOptions, 'db' | 'wa' | 'enqueue'>
}

/** Starter padrão: cancela o run ativo, garante o chat, inicia o fluxo e executa o 1º passo inline. */
export function flowEngineStarter(opts: FlowEngineStarterOptions): MassDispatchStarter {
  return {
    async start(input) {
      const { gateway, last } = capturing(opts.wa)
      const engine = new FlowEngine({ ...opts.engine, db: opts.db, wa: gateway })
      if (opts.control) await opts.control.cancelForContact({ companyId: input.companyId }, input.contactId)
      let runId: string
      try {
        const chatId = await ensureChat(opts.db, input.companyId, input.connectionId, input.contactId)
        runId = (
          await engine.startRun(
            { companyId: input.companyId },
            {
              flowId: input.flowId,
              contactId: input.contactId,
              chatId,
              trigger: { kind: 'mass_dispatch', dispatch_id: input.dispatchId, recipient_id: input.recipientId },
            },
          )
        ).runId
      } catch (err) {
        return { ok: false, code: 'error', message: err instanceof Error ? err.message : String(err) }
      }
      const step = await engine.step(runId, 0)
      const rejected = last()
      if (rejected && HANDLED.has(rejected.code)) {
        // O run que falhou no 1º envio não conta: o destinatário é reagendado/pulado sem deixar run pendurado.
        await opts.db.execute(sql`update crm.flow_runs set status = 'cancelled', finished_at = now(), updated_at = now() where id = ${runId} and status in ('running', 'waiting')`)
        return { ok: false, code: rejected.code as StartFailureCode, message: rejected.message, runId }
      }
      if (step.executed && step.status === 'failed') return { ok: false, code: 'error', message: step.error ?? 'falha no fluxo', runId }
      return { ok: true, runId }
    },
  }
}
