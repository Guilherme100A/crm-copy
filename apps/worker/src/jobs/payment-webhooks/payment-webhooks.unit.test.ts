import { describe, expect, it } from 'vitest'
import { createRegistry } from '../../registry'
import { createPaymentWebhookProcessor, PAYMENT_WEBHOOKS_QUEUE, registerPaymentWebhooksJob } from './index'

const data = { companyId: 'c', integrationId: 'i', gateway: 'xpag', event: { type: 'payment.approved' as const, transaction_id: 'tx', amount_cents: 100, currency: 'BRL', paid_at: null } }

describe('job payment-webhooks', () => {
  it('registra fila e worker', () => {
    const reg = registerPaymentWebhooksJob(createRegistry(), { service: { process: async () => ({ status: 'ignored', reason: 'unknown_charge' }) } })
    expect(reg.queues.map((q) => q.name)).toEqual([PAYMENT_WEBHOOKS_QUEUE])
    expect(reg.workers.map((w) => w.name)).toEqual([PAYMENT_WEBHOOKS_QUEUE])
  })

  it('processa o evento do job; sem dependências lança', async () => {
    const seen: unknown[] = []
    const processor = createPaymentWebhookProcessor({ service: () => ({ process: async (d) => (seen.push(d), { status: 'ignored', reason: 'unknown_charge' }) }) })
    await processor({ data } as never)
    expect(seen).toEqual([data])
    await expect(createPaymentWebhookProcessor({ service: () => undefined })({ data } as never)).rejects.toThrow(/configurePaymentWebhooks/)
  })
})
