import { describe, expect, it, vi } from 'vitest'
import { bullTurnScheduler, memoryTurnScheduler, type AiTurnJobData } from './scheduler'

const job = (gen: number): AiTurnJobData => ({ companyId: 'co', chatId: 'chat', gen })

describe('memoryTurnScheduler', () => {
  it('reagendar o mesmo chat reinicia o timer: só a última geração roda', async () => {
    const ran: number[] = []
    const s = memoryTurnScheduler(async (j) => void ran.push(j.gen))
    await s.schedule(job(1), 30)
    await s.schedule(job(2), 30)
    expect(s.pending()).toEqual(['chat'])
    await new Promise((r) => setTimeout(r, 60))
    await s.idle()
    expect(ran).toEqual([2])
  })

  it('flush roda na hora e erro do turno vai para onError', async () => {
    const onError = vi.fn()
    const s = memoryTurnScheduler(async () => {
      throw new Error('boom')
    }, onError)
    await s.schedule(job(1), 60_000)
    await s.flush('chat')
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'boom' }), job(1))
    expect(s.pending()).toEqual([])
  })
})

describe('bullTurnScheduler', () => {
  it('job delayed com jobId por chat e geração', async () => {
    const add = vi.fn(async () => undefined)
    await bullTurnScheduler({ add } as never).schedule(job(3), 5000)
    expect(add).toHaveBeenCalledWith('turn', job(3), expect.objectContaining({ jobId: 'turn-chat-g3', delay: 5000 }))
  })
})
