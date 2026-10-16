import { describe, expect, it, vi } from 'vitest'
import type { AiAgentRuntime } from '@crm/core'
import { createRegistry } from '../../registry'
import { AI_AGENT_QUEUE, createAiAgentProcessor, registerAiAgentJob } from './index'

describe('job ai-agent', () => {
  it('processor chama runtime.runTurn; dados inválidos ou runtime ausente lançam', async () => {
    const runTurn = vi.fn(async () => ({ chatId: 'c1', messageIds: [], llmCalls: 0, sent: [], skipped: 'stale' }))
    const runtime = { runTurn } as unknown as AiAgentRuntime
    const processor = createAiAgentProcessor({ runtime: () => runtime })
    await expect(processor({ data: { companyId: 'co', chatId: 'c1', gen: 2 } } as never)).resolves.toMatchObject({ skipped: 'stale' })
    expect(runTurn).toHaveBeenCalledWith({ companyId: 'co', chatId: 'c1', gen: 2 })
    await expect(processor({ data: { companyId: 'co', chatId: 'c1' } } as never)).rejects.toThrow(/inválido/)
    await expect(createAiAgentProcessor({ runtime: () => undefined })({ data: { companyId: 'co', chatId: 'c1', gen: 1 } } as never)).rejects.toThrow(
      /não configurado/,
    )
  })

  it('registra fila e worker ai-agent', () => {
    const reg = registerAiAgentJob(createRegistry(), { runtime: {} as AiAgentRuntime })
    expect(reg.queues.map((q) => q.name)).toEqual([AI_AGENT_QUEUE])
    expect(reg.workers.map((w) => w.name)).toEqual([AI_AGENT_QUEUE])
  })
})
