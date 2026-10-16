import { describe, expect, it } from 'vitest'
import { createRegistry } from '../../registry'
import { createInboundSalesProcessor, INBOUND_SALES_QUEUE, registerInboundSalesJob } from './index'

const data = { eventId: 'e1', saleSourceId: 's1', companyId: 'c1' }
const result = { status: 'processed' as const, error: null, saleId: 'x', contactId: 'y' }

describe('job inbound-sales', () => {
  it('registra fila e worker', () => {
    const reg = registerInboundSalesJob(createRegistry(), { processor: { process: async () => result } })
    expect(reg.queues.map((q) => q.name)).toEqual([INBOUND_SALES_QUEUE])
    expect(reg.workers.map((w) => w.name)).toEqual([INBOUND_SALES_QUEUE])
  })

  it('processa o evento do job; sem deps lança', async () => {
    const seen: unknown[] = []
    expect(await createInboundSalesProcessor({ processor: () => ({ process: async (d) => (seen.push(d), result) }) })({ data } as never)).toEqual(result)
    expect(seen).toEqual([data])
    await expect(createInboundSalesProcessor({ processor: () => undefined })({ data } as never)).rejects.toThrow(/configureInboundSales/)
  })
})
