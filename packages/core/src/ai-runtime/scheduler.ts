// Agendador do turno (buffer, 07 §3.2): cada mensagem nova reinicia a contagem. Em memória para testes/processo
// único; no worker, job BullMQ delayed na fila `ai-agent` com jobId por chat e geração (só a última vale).
import type { Queue } from 'bullmq'

export const AI_AGENT_QUEUE = 'ai-agent'

export interface AiTurnJobData {
  companyId: string
  chatId: string
  gen: number
}

export interface TurnScheduler {
  /** Agenda o turno do chat; um agendamento novo para o mesmo chat substitui o anterior. */
  schedule(job: AiTurnJobData, delayMs: number): Promise<void>
}

/** Agendador em memória: chama `run` depois do atraso (cancela o anterior do mesmo chat). */
export function memoryTurnScheduler(run: (job: AiTurnJobData) => Promise<unknown>, onError?: (err: unknown, job: AiTurnJobData) => void): TurnScheduler & {
  /** Roda agora o turno pendente do chat (testes). */
  flush(chatId: string): Promise<void>
  /** Espera os turnos em andamento. */
  idle(): Promise<void>
  pending(): string[]
} {
  const timers = new Map<string, { timer: NodeJS.Timeout; job: AiTurnJobData }>()
  const inflight = new Set<Promise<unknown>>()
  const fire = (job: AiTurnJobData) => {
    timers.delete(job.chatId)
    const p = run(job).catch((err) => onError?.(err, job))
    inflight.add(p)
    void p.finally(() => inflight.delete(p))
    return p
  }
  return {
    async schedule(job, delayMs) {
      const prev = timers.get(job.chatId)
      if (prev) clearTimeout(prev.timer)
      const timer = setTimeout(() => void fire(job), Math.max(0, delayMs))
      timer.unref?.()
      timers.set(job.chatId, { timer, job })
    },
    async flush(chatId) {
      const t = timers.get(chatId)
      if (!t) return this.idle()
      clearTimeout(t.timer)
      await fire(t.job)
    },
    async idle() {
      while (inflight.size) await Promise.all([...inflight])
    },
    pending: () => [...timers.keys()],
  }
}

/** Agendador BullMQ: job delayed com `jobId` determinístico; a geração descarta turnos superados. */
export function bullTurnScheduler(queue: Pick<Queue<AiTurnJobData>, 'add'>): TurnScheduler {
  return {
    async schedule(job, delayMs) {
      await queue.add('turn', job, {
        jobId: `turn-${job.chatId}-g${job.gen}`,
        delay: Math.max(0, delayMs),
        removeOnComplete: { count: 1000, age: 24 * 3600 },
        removeOnFail: { count: 5000, age: 7 * 24 * 3600 },
      })
    },
  }
}
