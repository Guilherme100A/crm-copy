import { META_CAPI_QUEUE, SaleNotVisibleError } from '@crm/core'
import { describe, expect, it } from 'vitest'
import { createRegistry } from '../../registry'
import { createMetaCapiProcessor, META_CAPI_BACKOFF, META_CAPI_QUEUE_OPTS, metaCapiBackoff, registerMetaCapiJob } from './index'

describe('job meta-capi', () => {
  it('registra fila e worker', () => {
    const reg = registerMetaCapiJob(createRegistry(), { db: {} as never })
    expect(reg.queues.map((q) => q.name)).toEqual([META_CAPI_QUEUE])
    expect(reg.workers.map((w) => w.name)).toEqual([META_CAPI_QUEUE])
  })

  it('T126: backoff próprio — venda ainda não visível tenta em segundos; falha da Meta mantém 30 s exponencial', () => {
    const reg = registerMetaCapiJob(createRegistry(), { db: {} as never })
    expect(reg.queues[0]!.opts).toEqual(META_CAPI_QUEUE_OPTS)
    expect(META_CAPI_QUEUE_OPTS.defaultJobOptions).toEqual({ attempts: 5, backoff: { type: META_CAPI_BACKOFF } })
    expect(reg.workers[0]!.opts.settings?.backoffStrategy).toBe(metaCapiBackoff)
    const notVisible = new SaleNotVisibleError('s1')
    expect([1, 2, 3, 4].map((n) => metaCapiBackoff(n, META_CAPI_BACKOFF, notVisible))).toEqual([2_000, 4_000, 8_000, 16_000])
    expect([1, 2, 3].map((n) => metaCapiBackoff(n, META_CAPI_BACKOFF, new Error('meta-capi: 1 envio(s) falharam')))).toEqual([30_000, 60_000, 120_000])
  })

  it('T126: o processador repassa SaleNotVisibleError (o job não conclui sem enviar)', async () => {
    const db = { select: () => ({ from: () => ({ where: () => ({ limit: async () => [] }) }) }) }
    const processor = createMetaCapiProcessor({ deps: () => ({ db: db as never }) })
    await expect(processor({ data: { companyId: 'c', saleId: 's' } } as never)).rejects.toBeInstanceOf(SaleNotVisibleError)
  })

  it('sem db configurado lança', async () => {
    const processor = createMetaCapiProcessor({ deps: () => ({}) })
    await expect(processor({ data: { companyId: 'c', saleId: 's' } } as never)).rejects.toThrow(/configureMetaCapi/)
  })
})
