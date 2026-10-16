// Redis real (REDIS_URL, db 1) com prefixo BullMQ aleatório.
import { randomBytes } from 'node:crypto'
import { defineQueue } from '@crm/core'
import { bullConnection } from '@crm/node-kit'
import { describe, expect, it } from 'vitest'
import { createRegistry } from '../registry'
import { loadWorkerConfig } from './config'
import { startWorker } from './start'

describe('startWorker', () => {
  it('SIGTERM fecha workers sem perder o job ativo (o job termina antes do fim do shutdown)', async () => {
    const prefix = `crm-test-${randomBytes(4).toString('hex')}`
    const timeline: string[] = []
    let jobStarted!: () => void
    const started = new Promise<void>((resolve) => (jobStarted = resolve))
    let stopped!: () => void
    const done = new Promise<void>((resolve) => (stopped = resolve))

    const registry = createRegistry()
      .queue('slow-job')
      .worker('slow-job', async () => {
        timeline.push('job:start')
        jobStarted()
        await new Promise((r) => setTimeout(r, 400))
        timeline.push('job:end')
        return 'ok'
      })
    const app = await startWorker({
      registry,
      prefix,
      exitProcess: false,
      onStop: () => {
        timeline.push('stopped')
        stopped()
      },
    })
    expect(app.consumer).toBeUndefined()
    expect(app.queues.get('slow-job')?.opts.prefix).toBe(prefix)

    await app.queues.get('slow-job')!.add('x', {})
    await started
    process.emit('SIGTERM')
    await done
    expect(timeline).toEqual(['job:start', 'job:end', 'stopped'])
    expect(process.listenerCount('SIGTERM')).toBe(0)

    const q = defineQueue('slow-job', { prefix, connection: bullConnection() })
    try {
      expect(await q.getJobCounts('completed', 'active', 'wait')).toEqual({ completed: 1, active: 0, wait: 0 })
    } finally {
      await q.obliterate({ force: true })
      await q.close()
    }
  })

  it('stop() é idempotente e o consumidor só sobe com handlers registrados', async () => {
    const stream = `test:wsm:events:${randomBytes(4).toString('hex')}`
    const registry = createRegistry().on('session.qr', () => undefined)
    const app = await startWorker({ registry, handleSignals: false, consumer: { stream, blockMs: 50 } })
    expect(app.consumer?.isRunning).toBe(true)
    await Promise.all([app.stop(), app.stop()])
    expect(app.consumer?.isRunning).toBe(false)
  })
})

describe('loadWorkerConfig', () => {
  it('aplica os defaults e valida', () => {
    expect(loadWorkerConfig({})).toMatchObject({ WA_EVENTS_STREAM: 'wsm:events', REDIS_URL: 'redis://127.0.0.1:6379/1' })
    expect(() => loadWorkerConfig({ LOG_LEVEL: 'loud' })).toThrow()
  })
})
