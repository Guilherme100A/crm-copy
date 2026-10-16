import { META_CAPI_QUEUE } from '@crm/core'
import { describe, expect, it } from 'vitest'
import { createRegistry } from '../../registry'
import { createMetaCapiProcessor, registerMetaCapiJob } from './index'

describe('job meta-capi', () => {
  it('registra fila e worker', () => {
    const reg = registerMetaCapiJob(createRegistry(), { db: {} as never })
    expect(reg.queues.map((q) => q.name)).toEqual([META_CAPI_QUEUE])
    expect(reg.workers.map((w) => w.name)).toEqual([META_CAPI_QUEUE])
  })

  it('sem db configurado lança', async () => {
    const processor = createMetaCapiProcessor({ deps: () => ({}) })
    await expect(processor({ data: { companyId: 'c', saleId: 's' } } as never)).rejects.toThrow(/configureMetaCapi/)
  })
})
