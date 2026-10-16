// Timers das esperas (T30). Prazos longos viram job delayed `flow-timer` com `jobId` determinístico (reagendar o
// mesmo passo não duplica; o BullMQ recusa `:` em jobId, então o formato é `timer-<runId>-seq-<n>[-g<gen>]`).
// Atrasos curtos (≤ 5 s) rodam em processo (setTimeout), sem job.

export interface FlowTimerJobData {
  runId: string
  seq: number
  /** Geração do timer (0 na primeira espera; +1 a cada resume após pausa). */
  gen?: number
}

export function flowTimerJobId(data: FlowTimerJobData): string {
  const base = `timer-${data.runId}-seq-${data.seq}`
  return data.gen ? `${base}-g${data.gen}` : base
}

/** Agendador durável (BullMQ no worker). */
export interface TimerScheduler {
  schedule(data: FlowTimerJobData, delayMs: number): Promise<void>
  cancel(data: FlowTimerJobData): Promise<void>
}

export const FLOW_TIMER_QUEUE = 'flow-timer'

/** Fila BullMQ mínima que o agendador usa (`Queue` de `defineQueue`). */
export interface TimerQueue {
  add(name: string, data: FlowTimerJobData, opts: { jobId: string; delay: number }): Promise<unknown>
  remove(jobId: string): Promise<unknown>
}

/** `TimerScheduler` sobre a fila `flow-timer` (job delayed). Reagendar o mesmo id não duplica; cancelar remove o job. */
export function bullTimerScheduler(queue: TimerQueue): TimerScheduler {
  return {
    schedule: async (data, delayMs) => {
      await queue.add(FLOW_TIMER_QUEUE, data, { jobId: flowTimerJobId(data), delay: Math.max(0, Math.round(delayMs)) })
    },
    cancel: async (data) => {
      await queue.remove(flowTimerJobId(data))
    },
  }
}

export const DEFAULT_SHORT_DELAY_MS = 5000

/**
 * Agenda o disparo: ≤ `shortDelayMs` em processo, acima disso no `TimerScheduler`. Sem agendador, todo prazo
 * roda em processo (testes e dry-run de integração).
 */
export class FlowTimers {
  private readonly local = new Map<string, ReturnType<typeof setTimeout>>()

  constructor(
    private readonly fire: (data: FlowTimerJobData) => Promise<unknown>,
    private readonly opts: { scheduler?: TimerScheduler; shortDelayMs?: number; onError?: (err: unknown) => void } = {},
  ) {}

  async schedule(data: FlowTimerJobData, delayMs: number): Promise<'local' | 'queued'> {
    const delay = Math.max(0, Math.round(delayMs))
    const short = this.opts.shortDelayMs ?? DEFAULT_SHORT_DELAY_MS
    if (!this.opts.scheduler || delay <= short) {
      const id = flowTimerJobId(data)
      if (this.local.has(id)) return 'local'
      const t = setTimeout(() => {
        this.local.delete(id)
        this.fire(data).catch((err: unknown) => this.opts.onError?.(err))
      }, delay)
      t.unref?.()
      this.local.set(id, t)
      return 'local'
    }
    await this.opts.scheduler.schedule(data, delay)
    return 'queued'
  }

  async cancel(data: FlowTimerJobData): Promise<void> {
    const id = flowTimerJobId(data)
    const t = this.local.get(id)
    if (t) {
      clearTimeout(t)
      this.local.delete(id)
    }
    await this.opts.scheduler?.cancel(data)
  }

  /** Timers em processo pendentes (diagnóstico/testes). */
  get pendingLocal(): number {
    return this.local.size
  }

  /** Cancela todos os timers em processo (shutdown). */
  clearLocal(): void {
    for (const t of this.local.values()) clearTimeout(t)
    this.local.clear()
  }
}
