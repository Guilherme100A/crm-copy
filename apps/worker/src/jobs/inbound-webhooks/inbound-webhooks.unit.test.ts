import { describe, expect, it } from 'vitest'
import { createRegistry } from '../../registry'
import { createInboundWebhookProcessor, INBOUND_WEBHOOKS_QUEUE, INBOUND_WEBHOOKS_SWEEP_JOB, registerInboundWebhooksJob, scheduleInboundWebhooksSweep } from './index'

const data = { requestId: 'r1', webhookId: 'w1', companyId: 'c1' }
const result = { status: 'processed' as const, steps: [], error: null, reason: null }

describe('job inbound-webhooks', () => {
  it('registra fila e worker', () => {
    const reg = registerInboundWebhooksJob(createRegistry(), { processor: { process: async () => result, sweepPending: async () => 0 } })
    expect(reg.queues.map((q) => q.name)).toEqual([INBOUND_WEBHOOKS_QUEUE])
    expect(reg.workers.map((w) => w.name)).toEqual([INBOUND_WEBHOOKS_QUEUE])
  })

  it('processa o request do job; o job de varredura reenfileira pelo enqueue; sem deps lança', async () => {
    const seen: unknown[] = []
    const enqueued: unknown[] = []
    const processor = createInboundWebhookProcessor({
      processor: () => ({
        process: async (d) => (seen.push(d), result),
        sweepPending: async (_o, enqueue) => (await enqueue(data, { jobId: 'iwr-r1' }), 1),
      }),
      enqueue: async (d, o) => void enqueued.push({ d, o }),
    })
    expect(await processor({ name: 'inbound-webhook', data } as never)).toEqual(result)
    expect(seen).toEqual([data])
    expect(await processor({ name: INBOUND_WEBHOOKS_SWEEP_JOB, data: {} } as never)).toEqual({ swept: 1 })
    expect(enqueued).toEqual([{ d: data, o: { jobId: 'iwr-r1' } }])
    await expect(createInboundWebhookProcessor({ processor: () => undefined })({ name: 'inbound-webhook', data } as never)).rejects.toThrow(/configureInboundWebhooks/)
  })

  it('agenda a varredura repetível a cada minuto', async () => {
    const calls: unknown[] = []
    await scheduleInboundWebhooksSweep({ upsertJobScheduler: async (...args: unknown[]) => void calls.push(args) } as never)
    expect(calls).toEqual([[INBOUND_WEBHOOKS_SWEEP_JOB, { every: 60_000 }, { name: INBOUND_WEBHOOKS_SWEEP_JOB, data: {} }]])
  })
})
