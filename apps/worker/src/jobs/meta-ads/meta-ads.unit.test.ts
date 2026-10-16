// Job `meta-sync` (T101): limite de uso da Meta adia o job (moveToDelayed + DelayedError), sem contar como falha.
import { MetaRateLimitedError } from '@crm/core'
import { DelayedError } from 'bullmq'
import { describe, expect, it, vi } from 'vitest'
import { createMetaSyncProcessor, META_SYNC_QUEUE } from './index'

const data = { companyId: 'c', bundleKey: 'k', params: {} as never, accountIds: ['a'], force: false }

describe('createMetaSyncProcessor', () => {
  it('roda o bundle e devolve o envelope', async () => {
    const runJob = vi.fn(async () => ({ status: 'ready' }) as never)
    const out = await createMetaSyncProcessor({ service: () => ({ runJob }) })({ data, moveToDelayed: vi.fn() } as never, 'tok')
    expect(out).toEqual({ status: 'ready' })
    expect(runJob).toHaveBeenCalledWith(data)
    expect(META_SYNC_QUEUE).toBe('meta-sync')
  })

  it('limite de uso: move para delayed até o retryAt e lança DelayedError', async () => {
    const retryAt = Date.now() + 120_000
    const moveToDelayed = vi.fn(async () => undefined)
    const processor = createMetaSyncProcessor({ service: () => ({ runJob: async () => Promise.reject(new MetaRateLimitedError(retryAt, 'uso 90%')) }) })
    await expect(processor({ data, moveToDelayed } as never, 'tok')).rejects.toBeInstanceOf(DelayedError)
    expect(moveToDelayed).toHaveBeenCalledWith(retryAt, 'tok')
  })

  it('outros erros falham normalmente; sem configuração, erro claro', async () => {
    const processor = createMetaSyncProcessor({ service: () => ({ runJob: async () => Promise.reject(new Error('banco fora')) }) })
    await expect(processor({ data, moveToDelayed: vi.fn() } as never, 'tok')).rejects.toThrow('banco fora')
    await expect(createMetaSyncProcessor({ service: () => undefined })({ data, moveToDelayed: vi.fn() } as never)).rejects.toThrow(/configureMetaAds/)
  })
})
