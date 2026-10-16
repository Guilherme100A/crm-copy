// `flow_run.updated` (T120; catálogo da T43): o worker publica a mudança de estado dos runs que ele mesmo provoca —
// passo executado (`flow-step`: running → waiting/completed/failed…) e espera vencida/retomada (`flow-timer`). Lê a
// linha do run depois do job para publicar o estado efetivo (com flow/contato/chat), sem tocar no motor.
import { flowRuns, type Database } from '@crm/db'
import { eq } from 'drizzle-orm'
import type { Job, Worker } from 'bullmq'
import { FLOW_STEP_QUEUE } from '../jobs/flow-step'
import { FLOW_TIMER_QUEUE } from '../jobs/flow-timer'

export interface FlowRunEventPublisher {
  publish(companyId: string, type: 'flow_run.updated', data: Record<string, unknown>): Promise<unknown>
}

export interface FlowRunEventsOptions {
  db: Database
  publisher: FlowRunEventPublisher
  logger?: { warn(obj: object, msg?: string): void }
}

/** Se o job mudou o run: `flow-step` executado ou `flow-timer` que avançou. */
export function changedRunId(queue: string, job: Pick<Job, 'data'>, result: unknown): string | null {
  const data = (job.data ?? {}) as { runId?: unknown }
  const r = (result ?? {}) as { executed?: unknown; advanced?: unknown }
  if (typeof data.runId !== 'string') return null
  if (queue === FLOW_STEP_QUEUE && r.executed === true) return data.runId
  if (queue === FLOW_TIMER_QUEUE && r.advanced === true) return data.runId
  return null
}

/** Publica o estado atual do run. */
export async function publishRunUpdated(opts: FlowRunEventsOptions, runId: string): Promise<void> {
  const [run] = await opts.db.select().from(flowRuns).where(eq(flowRuns.id, runId)).limit(1)
  if (!run) return
  await opts.publisher.publish(run.companyId, 'flow_run.updated', {
    run_id: run.id,
    flow_id: run.flowId,
    contact_id: run.contactId,
    chat_id: run.chatId,
    status: run.status,
  })
}

/** Liga os workers `flow-step`/`flow-timer` (BullMQ `completed`) à publicação. Devolve a função que desliga. */
export function attachFlowRunEvents(workers: readonly Pick<Worker, 'name' | 'on' | 'off'>[], opts: FlowRunEventsOptions): () => void {
  const offs: (() => void)[] = []
  for (const worker of workers) {
    if (worker.name !== FLOW_STEP_QUEUE && worker.name !== FLOW_TIMER_QUEUE) continue
    const onCompleted = (job: Job, result: unknown) => {
      const runId = changedRunId(worker.name, job, result)
      if (!runId) return
      void publishRunUpdated(opts, runId).catch((err: unknown) =>
        opts.logger?.warn({ err: err instanceof Error ? err.message : String(err), run_id: runId }, 'falha ao publicar flow_run.updated'),
      )
    }
    worker.on('completed', onCompleted)
    offs.push(() => worker.off('completed', onCompleted))
  }
  return () => offs.forEach((off) => off())
}
