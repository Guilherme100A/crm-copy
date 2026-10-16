// Esperas do motor de fluxos (T30; 06 §3.5 wait_response/smart_interval, §4.5 máx. 31 dias).
// Um nó que espera devolve `{ wait: FlowWait }`: `reply` (resposta do lead, com prazo opcional) ou `timer` (atraso).
// O run fica `waiting`; `FlowControl` retoma pelo handle de resposta ou pelo de timeout.

/** Prazo máximo de espera e de atraso (06 §4.5). */
export const MAX_WAIT_MS = 31 * 24 * 60 * 60 * 1000

/** T111: `payment` = confirmação de pagamento do bloco Pagamento (só o webhook retoma; a resposta do lead não). */
export type FlowWaitKind = 'timer' | 'reply' | 'payment'

export interface FlowWait {
  kind: FlowWaitKind
  /** `reply`: handle da resposta; `timeout`: handle do prazo (no `timer`, o handle seguido ao vencer). */
  handles: { reply?: string; timeout?: string }
  /** ISO 8601 do vencimento; `null` = espera indefinida (só `reply`). */
  deadline_at: string | null
  /** Alternativa a `deadline_at` na entrada: convertido para `deadline_at` ao agendar. */
  delay_ms?: number
  /** Geração do timer (incrementa a cada resume após pausa) — compõe o `jobId`. */
  timer_gen?: number
  /** Restante do prazo guardado ao pausar o fluxo. */
  remaining_ms?: number | null
  [key: string]: unknown
}

export class FlowWaitError extends Error {
  constructor(
    readonly code: 'wait_too_long' | 'invalid_wait',
    message?: string,
  ) {
    // O código vai na mensagem: é ela que o motor grava em `flow_runs.error`.
    super(message ? `${code}: ${message}` : code)
    this.name = 'FlowWaitError'
  }
}

function assertDelay(delayMs: number) {
  if (!Number.isFinite(delayMs) || delayMs < 0) throw new FlowWaitError('invalid_wait', 'prazo inválido')
  if (delayMs > MAX_WAIT_MS) throw new FlowWaitError('wait_too_long', 'prazo máximo é 31 dias')
}

const nowOf = (now?: () => Date) => (now ? now() : new Date())

function deadline(input: { delayMs?: number; deadlineAt?: Date | string | null }, now?: () => Date): string | null {
  if (input.deadlineAt) {
    const at = new Date(input.deadlineAt)
    if (Number.isNaN(at.getTime())) throw new FlowWaitError('invalid_wait', 'deadline_at inválido')
    assertDelay(Math.max(0, at.getTime() - nowOf(now).getTime()))
    return at.toISOString()
  }
  if (input.delayMs === undefined) return null
  assertDelay(input.delayMs)
  return new Date(nowOf(now).getTime() + input.delayMs).toISOString()
}

/** Espera a resposta do lead; com prazo, segue `timeout` ao vencer. Prazo > 31 dias lança `wait_too_long`. */
export function waitForReply(
  opts: { delayMs?: number; deadlineAt?: Date | string | null; reply?: string; timeout?: string; now?: () => Date } = {},
): FlowWait {
  return {
    kind: 'reply',
    handles: { reply: opts.reply ?? 'source', timeout: opts.timeout ?? 'timeout' },
    deadline_at: deadline(opts, opts.now),
    ...(opts.delayMs !== undefined && !opts.deadlineAt ? { delay_ms: opts.delayMs } : {}),
  }
}

/** Atraso: ao vencer segue `handle` (padrão `source`). Atraso > 31 dias lança `wait_too_long`. */
export function waitDelay(delayMs: number, opts: { handle?: string; now?: () => Date } = {}): FlowWait {
  assertDelay(delayMs)
  return { kind: 'timer', handles: { timeout: opts.handle ?? 'source' }, deadline_at: deadline({ delayMs }, opts.now), delay_ms: delayMs }
}

/**
 * T111: espera da confirmação de pagamento até o fim do `listener_ttl`. `approved` é o handle seguido quando o
 * webhook confirma (`FlowControl.resolvePayment`); ao vencer segue `timeout` (sem aresta = run `completed`).
 */
export function waitForPayment(opts: { chargeId: string; transactionId: string; deadlineAt: Date | string; approved: string; timeout?: string; now?: () => Date }): FlowWait {
  return {
    kind: 'payment',
    handles: { reply: opts.approved, timeout: opts.timeout ?? 'payment_listener_expired' },
    deadline_at: deadline({ deadlineAt: opts.deadlineAt }, opts.now),
    charge_id: opts.chargeId,
    transaction_id: opts.transactionId,
  }
}

/** Lê/normaliza o `wait` salvo em `flow_runs.wait` (aceita `delay_ms` e `handle` soltos). */
export function parseWait(raw: unknown, now?: () => Date): FlowWait | null {
  if (!raw || typeof raw !== 'object') return null
  const w = raw as Record<string, unknown>
  // T111: espera de pagamento mantém o tipo (não vira `reply`: a mensagem do lead não a retoma).
  if (w.kind === 'payment') {
    const h = (w.handles && typeof w.handles === 'object' ? w.handles : {}) as Record<string, unknown>
    return {
      ...w,
      kind: 'payment',
      handles: { reply: typeof h.reply === 'string' ? h.reply : 'source', timeout: typeof h.timeout === 'string' ? h.timeout : 'payment_listener_expired' },
      deadline_at: typeof w.deadline_at === 'string' ? w.deadline_at : null,
      timer_gen: typeof w.timer_gen === 'number' ? w.timer_gen : 0,
    } as FlowWait
  }
  const kind: FlowWaitKind = w.kind === 'timer' ? 'timer' : 'reply'
  const rawHandles = (w.handles && typeof w.handles === 'object' ? w.handles : {}) as Record<string, unknown>
  const handles: FlowWait['handles'] =
    kind === 'timer'
      ? { timeout: typeof rawHandles.timeout === 'string' ? rawHandles.timeout : typeof w.handle === 'string' ? w.handle : 'source' }
      : {
          reply: typeof rawHandles.reply === 'string' ? rawHandles.reply : 'source',
          timeout: typeof rawHandles.timeout === 'string' ? rawHandles.timeout : 'timeout',
        }
  let deadlineAt = typeof w.deadline_at === 'string' ? w.deadline_at : null
  if (!deadlineAt && typeof w.delay_ms === 'number') deadlineAt = new Date(nowOf(now).getTime() + Math.min(Math.max(0, w.delay_ms), MAX_WAIT_MS)).toISOString()
  return {
    ...w,
    kind,
    handles,
    deadline_at: deadlineAt,
    timer_gen: typeof w.timer_gen === 'number' ? w.timer_gen : 0,
  } as FlowWait
}
